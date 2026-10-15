#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 35, D7: cobertura da guarda de atividade da app nos scripts que escrevem a fila ou publicam.
 *
 * Um script é escritor se importa (estático ou dinâmico) uma função de escrita da fila ou de
 * publicação. Não há lista de scripts: o teste percorre scripts/ (.js e .mjs, recursivo) e decide.
 * Os nomes vêm de duas fontes. ESCRITAS_REMOTAS (lib/curation/curationQueue.server.js) é lida do
 * código. ESCRITAS_EXTRA são as funções que publicam ou escrevem noutros módulos. Cada nome de
 * ESCRITAS_EXTRA tem de ser exportado por lib/. Se deixar de o ser, o teste falha, e a cobertura
 * não cai em silêncio.
 *
 * Todo o escritor chama recusarSeAtividadeApp( (lib/curation/atividadeApp.js) antes de escrever.
 * A chamada só conta se for instrução. Tem de começar a linha, fora de comentários, sem if, else,
 * && || ou ternário na mesma linha, fora de blocos condicionais (if, else, catch, ciclos, switch),
 * e antes de qualquer chamada de escrita. Uma escrita numa função declarada antes só passa se essa
 * função for chamada depois da guarda. Um escritor que usa import() com .then falha
 * com mensagem, porque a ordem não se verifica assim.
 * Vale também em dry-run. scripts/tests/ fica de fora: são testes, não scripts de produção.
 *
 * Uso: node scripts/tests/curation-guard-coverage.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fecho, semComentarios } from "./_sem-comentarios.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = path.join(RAIZ, "scripts");
const LIB = path.join(RAIZ, "lib");
const CURATION_QUEUE = path.join(LIB, "curation", "curationQueue.server.js");
const GUARDA = "recusarSeAtividadeApp";

/** Funções de escrita que publicam ou escrevem noutros módulos (além de ESCRITAS_REMOTAS). */
const ESCRITAS_EXTRA = [
  "mutateCurationQueue",
  "saveCurationQueue",
  "revertAllPublishedInQueue",
  "revertLocalAfterShopifyReset",
  "runShopifyCatalogReset",
  "startShopifyCatalogResetInBackground",
  "runApprovedShopifySync",
  "startApprovedShopifySyncInBackground",
  "runStreamImport",
  "runImport",
  "ProductImporter",
  "purgeEliteCatalog",
  "executeReprice",
  "recordPriceWrite",
  "publishCatalogProductToShopify",
  "startCatalogCleanupInBackground",
  "startCatalogRebuildInBackground",
  "startCatalogIndexingWorker",
];

/** @param {string} dir @param {(caminho: string) => boolean} aceita */
function listar(dir, aceita) {
  const saida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...listar(caminho, aceita));
    else if (aceita(caminho)) saida.push(caminho);
  }
  return saida.sort();
}

function escritasRemotas() {
  const texto = fs.readFileSync(CURATION_QUEUE, "utf8");
  const bloco = texto.match(/const ESCRITAS_REMOTAS = \{([\s\S]*?)\n\};/);
  if (!bloco) throw new Error("ESCRITAS_REMOTAS não encontrado em curationQueue.server.js");
  return [...bloco[1].matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]);
}

/** Nomes exportados por qualquer ficheiro de lib/ (declarações e listas export { ... }). */
function nomesExportados() {
  const nomes = new Set();
  const reExport = /export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)|export\s*\{([^}]*)\}/g;
  for (const ficheiro of listar(LIB, (p) => /\.jsx?$/.test(p))) {
    for (const m of fs.readFileSync(ficheiro, "utf8").matchAll(reExport)) {
      if (m[1]) {
        nomes.add(m[1]);
        continue;
      }
      for (const parte of m[2].split(",")) {
        const partes = parte.trim().split(/\s+as\s+/);
        if (partes[0]) nomes.add(partes[partes.length - 1]);
      }
    }
  }
  return nomes;
}

/** @param {string} lista conteúdo de { ... } de um import */
function nomesDe(lista) {
  return lista
    .split(",")
    .map((parte) => parte.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/** Nomes importados e identificadores de namespace (import * as X, const X = await import(...)). */
function importacoes(texto) {
  const nomes = new Set();
  const namespaces = new Set();
  for (const m of texto.matchAll(/^\s*import\s+([^;'"]*?)\s+from\s+["'][^"']+["']/gm)) {
    const clausula = m[1];
    const chaves = clausula.match(/\{([^}]*)\}/);
    if (chaves) for (const nome of nomesDe(chaves[1])) nomes.add(nome);
    const ns = clausula.match(/\*\s+as\s+(\w+)/);
    if (ns) namespaces.add(ns[1]);
  }
  for (const m of texto.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(\s*["'][^"']+["']\s*\)/g)) {
    for (const nome of nomesDe(m[1])) nomes.add(nome);
  }
  for (const m of texto.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\(/g)) namespaces.add(m[1]);
  return { nomes, namespaces };
}

/** Linha que começa por chamada à guarda. Só esta forma conta como instrução. */
const LINHA_DA_GUARDA = new RegExp(`^[ \\t]*${GUARDA}\\s*\\(`, "gm");
/** Condição na mesma linha da chamada, como if, else, && ou || ou ternário. */
const CONDICAO_NA_LINHA = /\b(if|else)\b|&&|\|\||\s\?\s/;
/** Cabeçalho de bloco que torna a chamada opcional ou repetida. */
const CABECALHO_CONDICIONAL = /\b(if|else|catch|while|for|switch)\b|&&|\|\||\s\?\s/;

/**
 * Verdadeiro se a posição está dentro de um bloco cujo cabeçalho é condicional. Percorre os blocos
 * de fora para dentro, a partir da posição, e lê o texto de cada cabeçalho até ao ; { ou } anterior.
 * @param {string} codigo
 * @param {number} pos
 */
function emBlocoCondicional(codigo, pos) {
  let profundidade = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const c = codigo[i];
    if (c === "}") {
      profundidade += 1;
    } else if (c === "{") {
      if (profundidade > 0) {
        profundidade -= 1;
      } else {
        let j = i - 1;
        while (j >= 0 && !";{}".includes(codigo[j])) j -= 1;
        if (CABECALHO_CONDICIONAL.test(codigo.slice(j + 1, i))) return true;
      }
    }
  }
  return false;
}

/**
 * Analisa a guarda de um script. Devolve { ok, motivo }.
 * @param {string} texto conteúdo do ficheiro
 * @param {Set<string>} usados nomes de escrita que o ficheiro usa (ex.: "nome" ou "ns.nome")
 */
function analisarGuarda(texto, usados) {
  const codigo = semComentarios(texto);
  if (/\bimport\s*\([^)]*\)\s*\.\s*then\b/.test(codigo)) {
    return { ok: false, motivo: "usa import() com .then, e a ordem da guarda não se verifica assim. Usa await." };
  }
  const chamadas = [...codigo.matchAll(LINHA_DA_GUARDA)];
  if (chamadas.length === 0) {
    return { ok: false, motivo: `sem chamada a ${GUARDA}( como instrução, fora de comentários` };
  }
  for (const m of chamadas) {
    const fim = codigo.indexOf("\n", m.index);
    const linha = codigo.slice(m.index, fim === -1 ? codigo.length : fim);
    if (CONDICAO_NA_LINHA.test(linha)) {
      return { ok: false, motivo: "chamada na mesma linha de if, else, && ou ternário" };
    }
    if (emBlocoCondicional(codigo, m.index)) {
      return { ok: false, motivo: "chamada dentro de bloco condicional (if, else, catch, ciclo ou switch)" };
    }
  }
  const guarda = chamadas[0].index;
  const escritas = [];
  for (const usado of usados) {
    const nome = usado.split(".").pop();
    for (const m of codigo.matchAll(new RegExp(`(?<!function\\s+)\\b${nome}\\s*\\(`, "g"))) escritas.push(m.index);
  }
  const funcoes = declaracoesDeFuncao(codigo);
  for (const w of escritas) {
    if (w > guarda) continue;
    const funcao = funcaoQueContem(funcoes, w);
    if (!funcao) return { ok: false, motivo: "escrita antes da guarda, fora de qualquer função" };
    if (funcaoQueContem(funcoes, guarda) === funcao) {
      return { ok: false, motivo: `escrita antes da guarda, dentro de ${funcao.nome}` };
    }
    // A função que escreve só passa se nunca for chamada antes da guarda.
    const chamadasAntes = [...codigo.matchAll(new RegExp(`(?<!function\\s+)\\b${funcao.nome}\\s*\\(`, "g"))]
      .map((m) => m.index)
      .filter((p) => p < guarda && !(p > funcao.abre && p < funcao.fim));
    if (chamadasAntes.length > 0) {
      return { ok: false, motivo: `${funcao.nome} escreve e é chamada antes da guarda` };
    }
  }
  return { ok: true, motivo: "" };
}

/** Declarações de função do código, com o intervalo do corpo (posições no código sem comentários). */
function declaracoesDeFuncao(codigo) {
  return [...codigo.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => {
    const abreParametros = m.index + m[0].length - 1;
    const abre = codigo.indexOf("{", fecho(codigo, abreParametros, "(", ")"));
    return { nome: m[1], abre, fim: fecho(codigo, abre, "{", "}") };
  });
}

/** Função mais interna que contém a posição, ou null. */
function funcaoQueContem(funcoes, pos) {
  let escolhida = null;
  for (const f of funcoes) {
    if (pos > f.abre && pos < f.fim && (!escolhida || f.abre > escolhida.abre)) escolhida = f;
  }
  return escolhida;
}

const escritasDaFila = escritasRemotas();
const escritas = new Set([...escritasDaFila, ...ESCRITAS_EXTRA]);
const exportados = nomesExportados();

const escritores = [];
const ficheiros = listar(SCRIPTS, (p) => /\.(js|mjs)$/.test(p)).filter(
  (p) => !path.relative(SCRIPTS, p).startsWith(`tests${path.sep}`)
);
for (const ficheiro of ficheiros) {
  const texto = fs.readFileSync(ficheiro, "utf8");
  const { nomes, namespaces } = importacoes(texto);
  const usados = new Set([...nomes].filter((n) => escritas.has(n)));
  for (const ns of namespaces) {
    for (const nome of escritas) {
      if (new RegExp(`\\b${ns}\\s*\\.\\s*${nome}\\b`).test(texto)) usados.add(`${ns}.${nome}`);
    }
  }
  if (usados.size === 0) continue;
  escritores.push({
    ficheiro: path.relative(RAIZ, ficheiro),
    usados: [...usados].sort(),
    guarda: analisarGuarda(texto, usados),
  });
}

let falhas = 0;
function check(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

check(`ESCRITAS_REMOTAS lida do código (${escritasDaFila.length} funções)`, () => {
  assert.ok(escritasDaFila.length >= 10, "a leitura de ESCRITAS_REMOTAS tem de encontrar as escritas da fila");
});

check("os nomes de ESCRITAS_EXTRA existem como exportação de lib/", () => {
  const inexistentes = ESCRITAS_EXTRA.filter((n) => !exportados.has(n));
  assert.deepEqual(inexistentes, [], "nomes de referência sem exportação em lib/ (renomeados ou removidos)");
});

check("a varredura encontra os escritores conhecidos (sanidade)", () => {
  const conhecidos = ["scripts/catalog/run-approved-sync.js", "scripts/catalog/curation-mark-deleted.js"];
  for (const c of conhecidos) {
    assert.ok(escritores.some((e) => e.ficheiro === c), `${c} tem de ser detetado como escritor`);
  }
});

check(`todos os escritores chamam ${GUARDA}( como instrução, antes de escrever (${escritores.length} escritores)`, () => {
  const sem = escritores
    .filter((e) => !e.guarda.ok)
    .map((e) => `${e.ficheiro} (${e.usados.join(", ")}): ${e.guarda.motivo}`);
  assert.deepEqual(sem, [], `sem a guarda de atividade:\n        ${sem.join("\n        ")}`);
});

// Casos sintéticos do analisador. Fixam as regras, para uma mutação ao analisador ficar vermelha aqui.
const USADOS_TESTE = new Set(["gravar"]);

check("analisador: guarda como instrução antes da escrita passa", () => {
  const texto = 'import { recusarSeAtividadeApp } from "x";\nasync function main() {\n  recusarSeAtividadeApp("s");\n  await gravar(1);\n}\n';
  const r = analisarGuarda(texto, USADOS_TESTE);
  assert.equal(r.ok, true, r.motivo);
});

check("analisador: guarda só em comentário falha (G2)", () => {
  const texto = 'async function main() {\n  // recusarSeAtividadeApp("s");\n  /* recusarSeAtividadeApp("s"); */\n  await gravar(1);\n}\n';
  assert.equal(analisarGuarda(texto, USADOS_TESTE).ok, false);
});

check("analisador: guarda dentro de if (false) falha (G3)", () => {
  const texto = 'async function main() {\n  if (false) {\n    recusarSeAtividadeApp("s");\n  }\n  await gravar(1);\n}\n';
  assert.equal(analisarGuarda(texto, USADOS_TESTE).ok, false);
});

check("analisador: guarda com && ou ternário na mesma linha falha", () => {
  const texto = 'async function main() {\n  recusarSeAtividadeApp("s") && ok();\n  await gravar(1);\n}\n';
  assert.equal(analisarGuarda(texto, USADOS_TESTE).ok, false);
});

check("analisador: guarda depois da primeira escrita falha", () => {
  const texto = 'async function main() {\n  await gravar(1);\n  recusarSeAtividadeApp("s");\n}\n';
  assert.equal(analisarGuarda(texto, USADOS_TESTE).ok, false);
});

check("analisador: escrita numa função chamada só depois da guarda passa", () => {
  const texto = 'async function gravarTudo() {\n  await gravar(1);\n}\nasync function main() {\n  recusarSeAtividadeApp("s");\n  await gravarTudo();\n}\nmain();\n';
  const r = analisarGuarda(texto, USADOS_TESTE);
  assert.equal(r.ok, true, r.motivo);
});

check("analisador: função com escrita chamada antes da guarda falha", () => {
  const texto = 'async function gravarTudo() {\n  await gravar(1);\n}\nasync function main() {\n  await gravarTudo();\n  recusarSeAtividadeApp("s");\n}\n';
  assert.equal(analisarGuarda(texto, USADOS_TESTE).ok, false);
});

check("analisador: import() com .then falha com mensagem clara", () => {
  const texto = 'const m = import("x").then(() => {});\nrecusarSeAtividadeApp("s");\nawait gravar(1);\n';
  const r = analisarGuarda(texto, USADOS_TESTE);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /\.then/);
});

if (falhas) {
  console.error(`\ncuration-guard-coverage: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ncuration-guard-coverage: todos os escritores têm a guarda");
