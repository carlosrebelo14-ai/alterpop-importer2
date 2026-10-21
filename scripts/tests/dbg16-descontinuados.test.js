#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-16. Publicado que sai do feed é despublicado (DRAFT) e aparece no painel com substitutos. Nada é publicado
 * sem o Carlos.
 *   (P1) classificação: 3 ciclos seguidos sem aparecer (Decisão 44), guarda de 5% de ausentes, ignorados e já despublicados fora.
 *   (P2) substitutos: mesma franquia e formato, preço a mais ou menos 30%, com stock, sem entrada na fila, até 3.
 *   (S1) despublicação: productUpdate com status DRAFT, e erro quando a Shopify não confirma.
 *   (S2) despublicação em lote: para com o trinco perdido, não aborta por um produto que falha, e marca só os que saem.
 *   (R1) rota: só usar e ignorar, sem productUpdate. "Usar este" revalida no servidor.
 *   (R2) script: --execute exige --ok, recusa-se numa loja que não é a configurada, e só despublica depois do dry-run.
 *   (R3) painel: a secção está ligada à rota.
 *   (V1) metafield de lista: o nome sai do texto JSON, e nada passa a nome.
 *   (V2) um publicado despublicado (DRAFT) não volta a ACTIVE quando o SKU reaparece no feed.
 *   (V3) a despublicação não conta como feita se a fila já não tiver o item.
 *   (V4) "Usar este" põe o substituto como PENDING, fixado por decisão humana, e não o põe duas vezes.
 * Mutações: M50 o limiar de 3 ciclos deixa de contar, M51 a guarda de 5% sai, M52 a faixa de preço sai, M53 os SKU
 * ocupados deixam de contar, M54 o script executa sem --ok, M55 a despublicação continua com o trinco perdido,
 * M56 o substituto entra sem statusChangedAt, M57 o gatekeeper volta a dar ACTIVE a um despublicado.
 * Uso: node scripts/tests/dbg16-descontinuados.test.js
 */
import "./_isolate-curation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";
import { classificarPublicadosAusentes, escolherSubstitutos, valorDeMetafield } from "../../lib/curation/descontinuados.js";
import { despublicarProdutoDraft, despublicarDescontinuadosNaShopify } from "../../lib/importer/shopify/despublicacao.server.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => semComentarios(fs.readFileSync(path.join(REPO, rel), "utf8"));
const PURO = "lib/curation/descontinuados.js";
const DESPUBLICACAO = "lib/importer/shopify/despublicacao.server.js";
const ROTA = "app/routes/api.curation.descontinuados.jsx";
const SCRIPT = "scripts/catalog/descontinuados-despublicar.js";
const PAINEL = "app/routes/app._index.jsx";

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

/** Mutação que tem de ser apanhada: se a suíte passar com ela, falha. */
async function mutacaoTemDeFalhar(nome, fn) {
  let apanhou = false;
  try {
    await fn();
  } catch {
    apanhou = true;
  }
  if (!apanhou) throw new Error(`mutação ${nome}: a suíte não a apanhou`);
}

/** Troca uma âncora que tem de existir exatamente uma vez no texto. Erro do teste, fora de mutacaoTemDeFalhar. */
function trocaUma(texto, nome, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  return texto.replace(antigo, () => novo);
}

/** Cópia mutada de um módulo, no mesmo diretório (imports relativos). A âncora tem de existir uma vez. */
function copiaMutada(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = trocaUma(fs.readFileSync(origem, "utf8"), nome, antigo, novo);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto);
  return destino;
}

// ---------- casos dinâmicos ----------

await caso("(V1) metafield de lista: o nome sai do texto JSON, e um valor que não é lista passa tal qual", () => {
  assert.equal(valorDeMetafield('["Rick and Morty"]'), "Rick and Morty");
  assert.equal(valorDeMetafield('["", "Segundo"]'), "Segundo");
  assert.equal(valorDeMetafield("Figura"), "Figura");
  assert.equal(valorDeMetafield("[]"), null);
  assert.equal(valorDeMetafield("[nao-json"), null);
  assert.equal(valorDeMetafield(null), null);
});

await caso("(V2) publicado despublicado fica DRAFT quando o SKU reaparece no feed; sem a marca, continua ACTIVE", async () => {
  const { resolveStatusFromQueueEntry } = await import(pathToFileURL(path.join(REPO, "lib/importer/curation/visibilityGatekeeper.js")).href);
  assert.equal(resolveStatusFromQueueEntry({ status: "PUBLISHED", metadata: { despublicadoEm: "2026-10-21T10:00:00Z" } }).status, "DRAFT");
  assert.equal(resolveStatusFromQueueEntry({ status: "PUBLISHED", metadata: {} }).status, "ACTIVE");
  assert.equal(resolveStatusFromQueueEntry({ status: "APPROVED", metadata: { despublicadoEm: "x" } }).status, "ACTIVE", "uma aprovação nova não é travada pela marca antiga");
});

await caso("(V3) a despublicação não conta como feita se a fila já não tiver o item publicado", async () => {
  const cliente = { graphql: async (q, vars) => ({ productUpdate: { product: { id: vars.input.id, status: "DRAFT" }, userErrors: [] } }) };
  const r = await despublicarDescontinuadosNaShopify({
    client: cliente,
    itens: [{ sku: "Z", productId: "gid://shopify/Product/Z" }],
    marcar: async () => null,
  });
  assert.deepEqual(r.ok, []);
  assert.equal(r.falhas.length, 1);
  assert.match(r.falhas[0].motivo, /não foi marcado/);
});

await caso("(V4) Usar este põe o substituto como PENDING, fixado por decisão humana, e não o duplica", async () => {
  const fila = await import(pathToFileURL(path.join(REPO, "lib/curation/curationQueue.server.js")).href);
  const registo = { sku: "SUB-1", title: "Substituto", vendor: null, categoryMain: null, netPrice: 50, grossPrice: 60, availableQuantity: 3 };
  assert.deepEqual(await fila.adicionarSubstitutoPendente(registo, "DESC-1"), { ok: true });
  const item = (await fila.loadCurationQueue()).items.find((i) => i.sku === "SUB-1");
  assert.equal(item.status, "PENDING");
  assert.equal(typeof item.statusChangedAt, "string", "statusChangedAt fixa o PENDING contra as regras");
  assert.equal(item.metadata.origem, "humano");
  assert.equal(item.metadata.substitutoDe, "DESC-1");
  assert.equal((await fila.adicionarSubstitutoPendente(registo, "DESC-1")).ok, false, "um SKU já na fila não entra outra vez");
});

const publicado = (sku, extra = {}) => ({ sku, status: "PUBLISHED", metadata: { shopifyProductId: `gid://shopify/Product/${sku}`, ...extra } });
const rastreio = (entradas) => new Map(entradas);
const todos = (n) => Array.from({ length: n }, (_, i) => `P${i}`);
/** Publicados que continuam no feed: ficam de fora da conta e mantêm a fração de ausentes abaixo de 5%. */
const presentesExtra = (n) => Array.from({ length: n }, (_, i) => publicado(`K${i}`));

await caso("(P1) três ciclos seguidos sem aparecer entram, dois ciclos não", () => {
  const extras = presentesExtra(98);
  const items = [publicado("A"), publicado("B"), ...extras];
  const r = classificarPublicadosAusentes({
    items,
    rastreio: rastreio([
      ["A", { missingCycles: 3, lastSeenAt: "2026-10-18T10:00:00Z" }],
      ["B", { missingCycles: 2, lastSeenAt: "2026-10-19T10:00:00Z" }],
      ...extras.map((i) => [i.sku, { missingCycles: 0, lastSeenAt: null }]),
    ]),
    presentes: new Set(extras.map((i) => i.sku)),
  });
  assert.equal(r.abortado, false, "2 de 100 ausentes está abaixo de 5%");
  assert.deepEqual(r.itens.map((i) => i.sku), ["A"]);
  assert.equal(r.itens[0].saiuEm, "2026-10-18T10:00:00.000Z");
});

await caso("(P1) mais de 5% dos publicados ausentes de uma vez: aborta e não lista", () => {
  const items = todos(10).map((sku) => publicado(sku));
  const rastreio_ = rastreio(items.map((i) => [i.sku, { missingCycles: 2, lastSeenAt: null }]));
  const r = classificarPublicadosAusentes({ items, rastreio: rastreio_, presentes: new Set(["P9"]) });
  assert.equal(r.abortado, true, "9 de 10 ausentes é feed truncado");
  assert.deepEqual(r.itens, []);
  assert.match(r.motivo, /Feed possivelmente truncado/);
});

await caso("(P1) ignorados ficam fora da lista, e já despublicados saem da conta", () => {
  const extras = presentesExtra(60);
  const items = [publicado("A", { descontinuadoIgnoradoEm: "2026-10-21T10:00:00Z" }), publicado("B", { despublicadoEm: "2026-10-21T11:00:00Z" }), publicado("C"), ...extras];
  const r = classificarPublicadosAusentes({
    items,
    rastreio: rastreio([
      ["A", { missingCycles: 3, lastSeenAt: null }],
      ["B", { missingCycles: 3, lastSeenAt: null }],
      ["C", { missingCycles: 3, lastSeenAt: null }],
      ...extras.map((i) => [i.sku, { missingCycles: 0, lastSeenAt: null }]),
    ]),
    presentes: new Set(extras.map((i) => i.sku)),
  });
  assert.equal(r.abortado, false, "2 de 62 ausentes fica abaixo de 5%");
  assert.deepEqual(r.itens.map((i) => i.sku), ["C"], "A ignorado não aparece, B já despublicado não conta");
});

const candidato = (sku, extra = {}) => ({ sku, resolvedFranchise: "Rick", resolvedFormat: "Figura", stock: 3, netPrice: 100, ...extra });
const referencia = { sku: "REF", franchise: "Rick", format: "Figura", netPrice: 100 };

await caso("(P2) mesma franquia e formato, preço dentro de 30%, do mais próximo para o mais distante, até 3", () => {
  const candidatos = [
    candidato("X1", { netPrice: 110 }),
    candidato("X2", { netPrice: 95 }),
    candidato("X3", { netPrice: 130 }),
    candidato("X4", { netPrice: 120 }),
  ];
  const r = escolherSubstitutos({ referencia, candidatos, ocupados: new Set() });
  assert.deepEqual(r.substitutos.map((s) => s.sku), ["X2", "X1", "X4"], "X3 está no limite, mas X4 é mais próximo, e só há 3");
  assert.equal(r.motivo, null);
});

await caso("(P2) fora da faixa de 30%, outra franquia, outro formato, sem stock e já na fila ficam de fora", () => {
  const candidatos = [
    candidato("F1", { netPrice: 131 }),
    candidato("F2", { netPrice: 69 }),
    candidato("F3", { resolvedFranchise: "Outra" }),
    candidato("F4", { resolvedFormat: "Peluche" }),
    candidato("F5", { stock: 0 }),
    candidato("F6", { netPrice: 100 }),
  ];
  const r = escolherSubstitutos({ referencia, candidatos, ocupados: new Set(["F6"]) });
  assert.deepEqual(r.substitutos, []);
});

await caso("(P2) sem franquia, formato ou preço de referência não há substitutos, com motivo", () => {
  assert.equal(escolherSubstitutos({ referencia: { ...referencia, franchise: null }, candidatos: [candidato("Z")], ocupados: new Set() }).motivo, "sem franquia de referência");
  assert.equal(escolherSubstitutos({ referencia: { ...referencia, format: null }, candidatos: [candidato("Z")], ocupados: new Set() }).motivo, "sem formato de referência");
  assert.equal(escolherSubstitutos({ referencia: { ...referencia, netPrice: null }, candidatos: [candidato("Z")], ocupados: new Set() }).motivo, "sem preço de referência");
});

await caso("(S1) productUpdate com status DRAFT, e erro quando a Shopify não confirma", async () => {
  const pedidos = [];
  const cliente = {
    graphql: async (q, vars) => {
      pedidos.push(vars);
      return { productUpdate: { product: { id: vars.input.id, status: "DRAFT" }, userErrors: [] } };
    },
  };
  const produto = await despublicarProdutoDraft(cliente, "gid://shopify/Product/1");
  assert.equal(produto.status, "DRAFT");
  assert.deepEqual(pedidos[0], { input: { id: "gid://shopify/Product/1", status: "DRAFT" } });

  const comErro = { graphql: async () => ({ productUpdate: { product: null, userErrors: [{ field: ["id"], message: "não existe" }] } }) };
  await assert.rejects(() => despublicarProdutoDraft(comErro, "gid://shopify/Product/2"), /não existe/);

  const semDraft = { graphql: async () => ({ productUpdate: { product: { id: "x", status: "ACTIVE" }, userErrors: [] } }) };
  await assert.rejects(() => despublicarProdutoDraft(semDraft, "gid://shopify/Product/3"), /não confirmou o estado DRAFT/);
});

await caso("(S2) lote: para com o trinco perdido, não aborta por um produto que falha, marca só os que saem", async () => {
  const chamadas = [];
  const cliente = {
    graphql: async (q, vars) => {
      chamadas.push(vars.input.id);
      if (vars.input.id.endsWith("/B")) throw new Error("erro da Shopify");
      return { productUpdate: { product: { id: vars.input.id, status: "DRAFT" }, userErrors: [] } };
    },
  };
  const marcados = [];
  const marcar = async (sku) => marcados.push(sku);
  const itens = [
    { sku: "A", productId: "gid://shopify/Product/A" },
    { sku: "B", productId: "gid://shopify/Product/B" },
    { sku: "C", productId: "gid://shopify/Product/C" },
    { sku: "D", productId: "gid://shopify/Product/D" },
  ];
  // Trinco: bom antes de A e de B, perdido a partir de C.
  const respostas = [true, true, false];
  const aindaTem = async () => respostas.shift() ?? false;
  const r = await despublicarDescontinuadosNaShopify({ client: cliente, itens, aindaTem, marcar });
  assert.deepEqual(r.ok, ["A"]);
  assert.deepEqual(marcados, ["A"]);
  assert.equal(r.falhas.length, 2, "B falha na Shopify, e C fica parado pelo trinco perdido");
  assert.deepEqual(chamadas, ["gid://shopify/Product/A", "gid://shopify/Product/B"], "D não chega a ser tocado");
});

await caso("(S2) sem productId: falha registada, sem chamada à Shopify", async () => {
  const chamadas = [];
  const r = await despublicarDescontinuadosNaShopify({
    client: { graphql: async (q, vars) => (chamadas.push(vars), { productUpdate: { product: { status: "DRAFT" }, userErrors: [] } }) },
    itens: [{ sku: "S", productId: null }],
    marcar: async () => {},
  });
  assert.deepEqual(r.falhas, [{ sku: "S", motivo: "sem produto na Shopify" }]);
  assert.equal(chamadas.length, 0);
});

// ---------- verificações estáticas ----------

await caso("(R1) rota: só usar e ignorar, sem productUpdate, e revalida o substituto", () => {
  const texto = ler(ROTA);
  assert.match(texto, /body\.action === "ignorar"/);
  assert.match(texto, /body\.action === "usar"/);
  assert.match(texto, /validarSubstituto\(\{/, "o substituto é revalidado no servidor");
  assert.match(texto, /status: 405/, "a rota recusa métodos que não são POST");
  assert.doesNotMatch(texto, /productUpdate/, "a rota não escreve na Shopify");
});

await caso("(R2) script: --execute exige --ok, recusa outra loja, e despublica só depois do dry-run", () => {
  const texto = ler(SCRIPT);
  assert.match(texto, /if \(!OK\) \{/, "--execute exige --ok");
  assert.match(texto, /process\.exit\(3\)/, "outra loja sai com 3");
  assert.match(texto, /if \(!SKUS_APROVADOS\) \{/, "--execute exige a lista aprovada");
  assert.match(texto, /foraDaAprovacao\.length/, "a lista mudou desde o dry-run: recusa");
  const dryRun = texto.indexOf("if (!execute) {");
  const escrita = texto.indexOf("despublicarDescontinuadosNaShopify({");
  assert.ok(dryRun > 0 && escrita > dryRun, "a escrita fica depois do dry-run");
});

await caso("(R3) painel: a secção chama a rota, com Usar este e Ignorar", () => {
  const texto = ler(PAINEL);
  assert.ok(texto.includes('"/api/curation/descontinuados"'), "o painel chama a rota");
  assert.ok(texto.includes("Usar este") && texto.includes("Ignorar"), "os dois botões existem");
});

await caso("(R5) Decisão 44: o input do productUpdate na despublicação é só { id, status: \"DRAFT\" }", () => {
  const texto = ler(DESPUBLICACAO);
  assert.match(texto, /client\.graphql\(PRODUCT_DRAFT, \{ input: \{ id: productId, status: "DRAFT" \} \}\)/, "o input tem só id e status");
  assert.match(texto, /mutation DespublicarDescontinuado\(\$input: ProductInput!\)/, "a mutação é a de DRAFT");
});

await caso("(R4) o modo remoto da fila conhece as três escritas novas", () => {
  const texto = ler("lib/curation/curationQueue.server.js");
  assert.match(texto, /ESCRITAS_REMOTAS = \{[\s\S]*?marcarDescontinuadoDespublicado,[\s\S]*?marcarDescontinuadoIgnorado,[\s\S]*?adicionarSubstitutoPendente,/);
});

// ---------- mutações ----------

await caso("mutação M50 (DBG-16): o limiar de três ciclos deixa de contar", async () => {
  const copia = copiaMutada(PURO, "M50", ".filter((item) => (rastreio.get(item.sku)?.missingCycles ?? 0) >= ciclos)", "");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M50", async () => {
      const extras = presentesExtra(60);
      const r = m.classificarPublicadosAusentes({
        items: [publicado("A"), ...extras],
        rastreio: rastreio([["A", { missingCycles: 1, lastSeenAt: null }], ...extras.map((i) => [i.sku, { missingCycles: 0, lastSeenAt: null }])]),
        presentes: new Set(extras.map((i) => i.sku)),
      });
      assert.deepEqual(r.itens, [], "um ciclo não chega");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M51 (DBG-16): a guarda de 5% sai", async () => {
  const copia = copiaMutada(PURO, "M51", "if (vivos.length && ausentesAgora.length / vivos.length > fracaoMaxima) {", "if (false) {");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M51", async () => {
      const items = todos(10).map((sku) => publicado(sku));
      const r = m.classificarPublicadosAusentes({
        items,
        rastreio: rastreio(items.map((i) => [i.sku, { missingCycles: 2, lastSeenAt: null }])),
        presentes: new Set(["P9"]),
      });
      assert.equal(r.abortado, true, "feed truncado tem de abortar");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M52 (DBG-16): a faixa de preço de 30% sai", async () => {
  const copia = copiaMutada(PURO, "M52", ".filter((c) => c.diferenca <= limite)", ".filter(() => true)");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M52", async () => {
      const r = m.escolherSubstitutos({ referencia, candidatos: [candidato("F1", { netPrice: 131 })], ocupados: new Set() });
      assert.deepEqual(r.substitutos, [], "131 está fora de 30%");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M53 (DBG-16): os SKU já na fila deixam de ficar de fora", async () => {
  const copia = copiaMutada(PURO, "M53", ".filter((c) => !ocupados.has(c.sku))", ".filter(() => true)");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M53", async () => {
      const r = m.escolherSubstitutos({ referencia, candidatos: [candidato("OC", { netPrice: 100 })], ocupados: new Set(["OC"]) });
      assert.deepEqual(r.substitutos, [], "um SKU já na fila não é substituto");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M54 (DBG-16): o script executa sem --ok", () => {
  const mutado = trocaUma(ler(SCRIPT), "M54", "if (!OK) {", "if (false) {");
  assert.throws(() => assert.match(mutado, /if \(!OK\) \{/, "--execute exige --ok"));
});

await caso("mutação M55 (DBG-16): a despublicação continua com o trinco perdido", async () => {
  const copia = copiaMutada(DESPUBLICACAO, "M55", "break;", "continue;");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M55", async () => {
      let chamadas = 0;
      const cliente = { graphql: async () => (chamadas += 1, { productUpdate: { product: { status: "DRAFT" }, userErrors: [] } }) };
      const respostas = [true, false, false, false];
      const r = await m.despublicarDescontinuadosNaShopify({
        client: cliente,
        itens: [
          { sku: "A", productId: "gid://shopify/Product/A" },
          { sku: "B", productId: "gid://shopify/Product/B" },
          { sku: "C", productId: "gid://shopify/Product/C" },
        ],
        aindaTem: async () => respostas.shift(),
        marcar: async () => {},
      });
      assert.equal(r.falhas.length, 1, "com o trinco perdido, para no primeiro produto em falta");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M56 (DBG-16): o substituto entra sem statusChangedAt", async () => {
  const copia = copiaMutada("lib/curation/curationQueue.server.js", "M56", "    statusChangedAt: new Date().toISOString(),\n    metadata: {\n      ...buildMetadata(registo", "    metadata: {\n      ...buildMetadata(registo");
  try {
    const fila = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M56", async () => {
      await fila.adicionarSubstitutoPendente({ sku: "SUB-M56", title: "M", netPrice: 1, availableQuantity: 1 }, "DESC-M56");
      const item = (await fila.loadCurationQueue()).items.find((i) => i.sku === "SUB-M56");
      assert.equal(typeof item.statusChangedAt, "string", "sem statusChangedAt o substituto não fica fixado");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M57 (DBG-16): o gatekeeper volta a dar ACTIVE a um despublicado", async () => {
  const copia = copiaMutada("lib/importer/curation/visibilityGatekeeper.js", "M57", 'if (queueStatus === "PUBLISHED" && entry?.metadata?.despublicadoEm) {', "if (false) {");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M57", async () => {
      assert.equal(m.resolveStatusFromQueueEntry({ status: "PUBLISHED", metadata: { despublicadoEm: "x" } }).status, "DRAFT");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M58 (DBG-16, Decisão 44): acrescentar um campo ao input do productUpdate fica vermelho", async () => {
  const texto = ler(DESPUBLICACAO);
  const mutado = trocaUma(texto, "M58", '{ input: { id: productId, status: "DRAFT" } }', '{ input: { id: productId, status: "DRAFT", title: productId } }');
  assert.throws(() => assert.match(mutado, /client\.graphql\(PRODUCT_DRAFT, \{ input: \{ id: productId, status: "DRAFT" \} \}\)/, "o input tem só id e status"));
});

// ---------- marcas de descontinuado saem em cada decisão (revisão do arquiteto) ----------

const FILA_MODULO = "lib/curation/curationQueue.server.js";
const RESET_MODULO = "lib/importer/shopify/shopifyReset.server.js";
const MARCAS = { despublicadoEm: "2026-10-21T10:00:00Z", descontinuadoIgnoradoEm: "2026-10-21T11:00:00Z" };
const temMarcas = (metadata) => "despublicadoEm" in metadata || "descontinuadoIgnoradoEm" in metadata;

async function escreverFilaDeTeste(fila, itens) {
  await fila.comLockDaFila(async () => {
    const queue = await fila.loadCurationQueue();
    queue.items.push(...itens);
    await fila.saveCurationQueue(queue);
  });
  fila.invalidateCurationMemoryCache();
}

async function itemDaFila(fila, sku) {
  fila.invalidateCurationMemoryCache();
  return (await fila.loadCurationQueue()).items.find((i) => i.sku === sku);
}

await caso("(D1) aprovar, publicar e reverter pelo reset tiram as marcas de descontinuado", async () => {
  const fila = await import(pathToFileURL(path.join(REPO, FILA_MODULO)).href);
  const reset = await import(pathToFileURL(path.join(REPO, RESET_MODULO)).href);
  await escreverFilaDeTeste(fila, [
    { sku: "D1-APR", status: "PENDING", shopifyStatus: "DRAFT", title_en: "x", metadata: { ...MARCAS } },
    { sku: "D1-PUB", status: "APPROVED", shopifyStatus: "ACTIVE", title_en: "x", metadata: { ...MARCAS } },
    { sku: "D1-RST", status: "PUBLISHED", shopifyStatus: "ACTIVE", title_en: "x", metadata: { shopifyProductId: "gid://shopify/Product/D1RST", ...MARCAS } },
  ]);
  await fila.approveProduct("D1-APR");
  const aprovado = await itemDaFila(fila, "D1-APR");
  assert.equal(aprovado.status, "APPROVED");
  assert.equal(temMarcas(aprovado.metadata), false, "aprovar tira as marcas");
  await fila.markQueueItemPublished("D1-PUB", "gid://shopify/Product/D1PUB");
  const publicado = await itemDaFila(fila, "D1-PUB");
  assert.equal(publicado.status, "PUBLISHED");
  assert.equal(temMarcas(publicado.metadata), false, "publicar tira as marcas");
  await reset.revertLocalAfterShopifyReset(["D1-RST"], ["gid://shopify/Product/D1RST"]);
  const revertido = await itemDaFila(fila, "D1-RST");
  assert.equal(revertido.status, "PENDING");
  assert.equal(temMarcas(revertido.metadata), false, "o reset tira as marcas");
});

await caso("(R6) o reset em massa limpa as marcas antes de repor o item", () => {
  assert.match(ler(RESET_MODULO), /item\.status = targetStatus;\n\s*item\.metadata = semMarcasDeDescontinuado\(item\.metadata\);/);
});

await caso("mutação M59 (DBG-16): aprovar deixa as marcas no item", async () => {
  const copia = copiaMutada(FILA_MODULO, "M59", '  item.status = "APPROVED";\n  item.metadata = semMarcasDeDescontinuado(item.metadata);', '  item.status = "APPROVED";');
  try {
    const original = await import(pathToFileURL(path.join(REPO, FILA_MODULO)).href);
    const mutante = await import(pathToFileURL(copia).href);
    await escreverFilaDeTeste(original, [{ sku: "M59-APR", status: "PENDING", shopifyStatus: "DRAFT", title_en: "x", metadata: { ...MARCAS } }]);
    await mutacaoTemDeFalhar("M59", async () => {
      await mutante.approveProduct("M59-APR");
      assert.equal(temMarcas((await itemDaFila(original, "M59-APR")).metadata), false, "aprovar tira as marcas");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M60 (DBG-16): o apagado no admin deixa as marcas no item", async () => {
  const copia = copiaMutada(FILA_MODULO, "M60", "  const rest = semMarcasDeDescontinuado(restoDaMetadata);", "  const rest = restoDaMetadata;");
  try {
    const mutante = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M60", async () => {
      const item = mutante.applyDeletedInAdmin({ sku: "M60", status: "PUBLISHED", metadata: { shopifyProductId: "x", ...MARCAS } }, new Date().toISOString());
      assert.equal(temMarcas(item.metadata), false, "o apagado no admin tira as marcas");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M61 (DBG-16): o reset em massa deixa as marcas no item", () => {
  const mutado = trocaUma(ler(RESET_MODULO), "M61", "    item.status = targetStatus;\n    item.metadata = semMarcasDeDescontinuado(item.metadata);", "    item.status = targetStatus;");
  assert.throws(() => assert.match(mutado, /item\.status = targetStatus;\n\s*item\.metadata = semMarcasDeDescontinuado\(item\.metadata\);/, "o reset em massa limpa as marcas"));
});

await caso("mutação M62 (DBG-16): publicar deixa as marcas no item", async () => {
  const copia = copiaMutada(FILA_MODULO, "M62", '  item.status = "PUBLISHED";\n  item.metadata = semMarcasDeDescontinuado(item.metadata);', '  item.status = "PUBLISHED";');
  try {
    const original = await import(pathToFileURL(path.join(REPO, FILA_MODULO)).href);
    const mutante = await import(pathToFileURL(copia).href);
    await escreverFilaDeTeste(original, [{ sku: "M62-PUB", status: "APPROVED", shopifyStatus: "ACTIVE", title_en: "x", metadata: { ...MARCAS } }]);
    await mutacaoTemDeFalhar("M62", async () => {
      await mutante.markQueueItemPublished("M62-PUB", "gid://shopify/Product/M62");
      assert.equal(temMarcas((await itemDaFila(original, "M62-PUB")).metadata), false, "publicar tira as marcas");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("DBG-16 — todos os casos passaram");
