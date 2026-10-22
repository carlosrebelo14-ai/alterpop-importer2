#!/usr/bin/env node
/* eslint-env node */
/**
 * Tarefa image_check (scripts/maintenance/image-check.mjs): contagens do catálogo e amostra de miniaturas.
 *   O script corre como na Fly: por stdin, com node --input-type=module -, e o cwd na raiz do repositório.
 *   Prisma falso num diretório temporário. Lê por chave e lança em qualquer escrita, e a tentativa fica registada.
 *   Servidor HTTP em 127.0.0.1 com /ok, /hotlink, /redir, /html e /falha. Portas fechadas para o erro de rede.
 *   Repositório público: nenhum URL, SKU nem caminho de fixture aparece no stdout.
 * Uso: node scripts/tests/image-check.test.js
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/maintenance/image-check.mjs");
const SCRIPT_SRC = fs.readFileSync(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "image-check-"));
const REFERER_APP = "https://alterpop-importer-app.fly.dev/";
const ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

// Prisma falso. Só count e findMany pela chave. Qualquer outro acesso (escrita) regista o nome e lança.
// Não tem ${} de propósito: é uma string do módulo, escrita tal como está.
const STUB = `import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const sinal = (nome) => fs.appendFileSync(new URL("./escritas.txt", import.meta.url), nome + "\\n");
const leitura = (chaves) => fs.appendFileSync(new URL("./leituras.txt", import.meta.url), chaves + "\\n");

function casaCampo(valor, filtro) {
  if (filtro !== null && typeof filtro === "object") {
    if ("gt" in filtro) return valor > filtro.gt;
    throw new Error("filtro nao suportado");
  }
  return valor === filtro;
}
function casa(condicao, linha) {
  return Object.entries(condicao).every(([campo, filtro]) => casaCampo(linha[campo], filtro));
}
function ordenar(a, b) {
  if (a.shop !== b.shop) return a.shop < b.shop ? -1 : 1;
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

const catalogProduct = {
  async count() {
    if (cfg.modo === "lanca") throw new Error("falha simulada");
    if (cfg.modo === "muda") return cfg.linhas.length + 1;
    return cfg.linhas.length;
  },
  async findMany(args) {
    const selecao = Object.keys(args.select || {});
    leitura(selecao.slice().sort().join(","));
    const ordenadas = cfg.linhas.slice().sort(ordenar);
    const filtro = args.where;
    const filtradas = filtro ? ordenadas.filter((l) => (filtro.OR || [filtro]).some((c) => casa(c, l))) : ordenadas;
    return filtradas.slice(0, args.take ?? filtradas.length).map((l) => Object.fromEntries(selecao.map((k) => [k, l[k] ?? null])));
  },
};

const modeloProxy = new Proxy(catalogProduct, {
  get(alvo, prop) {
    if (prop in alvo) return alvo[prop];
    sinal("catalogProduct." + String(prop));
    return () => {
      throw new Error("escrita proibida no teste");
    };
  },
});
const base = { catalogProduct: modeloProxy, $disconnect: async () => {} };
export const prisma = new Proxy(base, {
  get(alvo, prop) {
    if (prop in alvo) return alvo[prop];
    sinal(String(prop));
    return () => {
      throw new Error("escrita proibida no teste");
    };
  },
});
`;

let falhas = 0;
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

/** Um Prisma falso novo, com as linhas e o modo dados. Devolve o caminho do módulo. */
function novoStub(cfg) {
  const dir = fs.mkdtempSync(path.join(tmp, "stub-"));
  fs.writeFileSync(path.join(dir, "prisma.mjs"), STUB);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
  return { dir, caminho: path.join(dir, "prisma.mjs") };
}

/** Corre o script como a Fly: o código pelo stdin de node --input-type=module -, com o cwd na raiz. */
function correr(env) {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, ["--input-type=module", "-"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    filho.stdout.on("data", (d) => (stdout += d));
    filho.stderr.on("data", (d) => (stderr += d));
    filho.stdin.on("error", () => {});
    const reloj = setTimeout(() => filho.kill("SIGKILL"), 60_000);
    filho.on("close", (status) => {
      clearTimeout(reloj);
      resolver({ status, stdout, stderr, linhas: stdout.split("\n").filter(Boolean) });
    });
    filho.stdin.end(SCRIPT_SRC);
  });
}

const correrComStub = (stub) => correr({ IMAGE_CHECK_PRISMA: stub.caminho });

function lerCampos(linha) {
  const campos = {};
  for (const token of linha.split(" ").slice(1)) {
    const i = token.indexOf("=");
    campos[token.slice(0, i)] = token.slice(i + 1);
  }
  return campos;
}

const linhasDe = (r, prefixo) => r.linhas.filter((l) => l.startsWith(prefixo));

/** Uma linha única com o prefixo, ou falha. */
function linhaUnica(r, prefixo) {
  const encontradas = linhasDe(r, prefixo);
  assert.equal(encontradas.length, 1, `esperava uma linha ${prefixo}, há ${encontradas.length}: ${r.linhas.join(" | ")}`);
  return encontradas[0];
}

function semEscritas(stub) {
  assert.ok(!fs.existsSync(path.join(stub.dir, "escritas.txt")), "nenhuma escrita pode chegar ao stub");
}

/** Só linhas do contrato, tokens com = e nada de texto livre. */
function assertFormatoDoContrato(stdout) {
  for (const l of stdout.split("\n").filter(Boolean)) {
    assert.match(l, /^IC(_[A-Z]+)?: (\S+=\S+)( \S+=\S+)*$/, `linha fora do contrato: ${l}`);
  }
}

function assertInvariante(campos) {
  const soma = Number(campos.vazio) + Number(campos.https) + Number(campos.http) + Number(campos.invalido);
  assert.equal(soma, Number(campos.total), `vazio+https+http+invalido (${soma}) tem de dar total (${campos.total})`);
}

/** Portas fechadas: uma porta que acabou de ser libertada, sem nada à escuta. */
async function portaFechada() {
  const s = net.createServer();
  const porta = await new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
  await new Promise((r) => s.close(r));
  return porta;
}

const pedidos = [];
const servidor = http.createServer((req, res) => {
  const caminho = req.url.split("?")[0];
  pedidos.push({ caminho, referer: req.headers.referer ?? null, userAgent: req.headers["user-agent"] ?? null, accept: req.headers.accept ?? null });
  if (caminho.startsWith("/ok")) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end("png");
  }
  if (caminho === "/hotlink") {
    if (req.headers.referer) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("negado");
    }
    res.writeHead(200, { "content-type": "image/png" });
    return res.end("png");
  }
  if (caminho === "/redir") {
    res.writeHead(301, { Location: "/ok/redir" });
    return res.end();
  }
  if (caminho.startsWith("/html")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<p>x</p>");
  }
  if (caminho.startsWith("/falha")) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("erro");
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nao");
});

const PORTA = await new Promise((r) => servidor.listen(0, "127.0.0.1", () => r(servidor.address().port)));
const FECHADA = await portaFechada();
const LOJA = "loja-sintetica.example";
const LINHA = (sku, imageUrl, shop = LOJA) => ({ shop, sku, imageUrl });

console.log("(a) contadores, invariante e formato");
await check("contagens por esquema, multi e invariante; nenhum URL, SKU nem caminho no stdout", async () => {
  const stub = novoStub({
    modo: "normal",
    linhas: [
      LINHA("SKU-SINTETICO-A01", null),
      LINHA("SKU-SINTETICO-A02", "   \t "),
      LINHA("SKU-SINTETICO-A03", `https://127.0.0.1:${FECHADA}/a`),
      LINHA("SKU-SINTETICO-A04", `HTTP://127.0.0.1:${PORTA}/ok/a4`),
      LINHA("SKU-SINTETICO-A05", "lixo sem url"),
      LINHA("SKU-SINTETICO-A06", "ftp://127.0.0.1/a6"),
      LINHA("SKU-SINTETICO-A07", "http://exa mple.invalid/a7"),
      LINHA("SKU-SINTETICO-A08", `http://127.0.0.1:${PORTA}/ok/a8a, http://127.0.0.1:${PORTA}/ok/a8b`),
      LINHA("SKU-SINTETICO-A09", `"https://127.0.0.1:${FECHADA}/a9"`),
      LINHA("SKU-SINTETICO-A10", `lixo; http://127.0.0.1:${PORTA}/ok/a10`),
      LINHA("SKU-SINTETICO-A11", `http://exa mple.invalid/a11, http://127.0.0.1:${PORTA}/ok/a11`),
    ],
  });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  assertFormatoDoContrato(r.stdout);
  const ic = lerCampos(linhaUnica(r, "IC:"));
  assert.deepEqual(
    { total: ic.total, vazio: ic.vazio, https: ic.https, http: ic.http, invalido: ic.invalido, multi: ic.multi },
    { total: "11", vazio: "2", https: "2", http: "3", invalido: "4", multi: "2" },
  );
  assertInvariante(ic);
  assert.equal(lerCampos(linhaUnica(r, "IC_AMOSTRA:")).obtidas, "5", "5 elegíveis: a amostra tem as 5");
  assert.equal(lerCampos(linhaUnica(r, "IC_TOTAIS:")).com_erro, "2", "as duas portas fechadas contam como erro");
  assert.ok(!r.stdout.includes("://"), "nenhum URL completo no stdout");
  // As barras que sobram são só os códigos do contrato (200/imagem, erro/CODIGO, timeout/-). Fora deles, nenhuma.
  const semCodigos = r.stdout.replace(/(\d{3}|erro|timeout)\/[A-Za-z_-]+/g, "");
  assert.ok(!semCodigos.includes("/"), "nenhum caminho no stdout");
  assert.ok(!r.stdout.includes("SKU"), "nenhum SKU no stdout");
  semEscritas(stub);
});

console.log("(b) host: só com 2 ou mais linhas, top 5 e desempate");
await check("top 5 por n decrescente e depois por nome; host com uma linha não sai", async () => {
  const hosts = [
    ["127.0.0.9", 4],
    ["127.0.0.2", 2],
    ["127.0.0.3", 2],
    ["127.0.0.4", 2],
    ["127.0.0.5", 2],
    ["127.0.0.6", 2],
    ["127.0.0.7", 2],
    ["127.0.0.8", 1],
  ];
  const linhas = [];
  let i = 0;
  for (const [ip, n] of hosts) {
    for (let k = 0; k < n; k += 1) {
      i += 1;
      linhas.push(LINHA(`SKU-SINTETICO-H${String(i).padStart(3, "0")}`, `https://${ip}:${FECHADA}/h${i}`));
    }
  }
  const stub = novoStub({ modo: "normal", linhas });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  const esperados = [
    `IC_HOST: pos=1 host=127.0.0.9:${FECHADA} n=4`,
    `IC_HOST: pos=2 host=127.0.0.2:${FECHADA} n=2`,
    `IC_HOST: pos=3 host=127.0.0.3:${FECHADA} n=2`,
    `IC_HOST: pos=4 host=127.0.0.4:${FECHADA} n=2`,
    `IC_HOST: pos=5 host=127.0.0.5:${FECHADA} n=2`,
  ];
  assert.deepEqual(linhasDe(r, "IC_HOST:"), esperados);
  assert.ok(!r.stdout.includes("127.0.0.8"), "um host com uma linha não pode sair");
  semEscritas(stub);
});

console.log("(c) amostra");
await check("25 elegíveis: obtidas=20, e cada linha da amostra é pedida uma vez por pedido, sem repetição", async () => {
  pedidos.length = 0;
  const linhas = [];
  for (let i = 1; i <= 25; i += 1) linhas.push(LINHA(`SKU-SINTETICO-C${i}`, `http://127.0.0.1:${PORTA}/ok/c${i}`));
  const stub = novoStub({ modo: "normal", linhas });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  assert.equal(linhaUnica(r, "IC_AMOSTRA:"), "IC_AMOSTRA: pedidas=20 obtidas=20 https=0 http=20");
  const porCaminho = new Map();
  for (const p of pedidos.filter((p) => p.caminho.startsWith("/ok/c"))) porCaminho.set(p.caminho, (porCaminho.get(p.caminho) || 0) + 1);
  assert.equal(porCaminho.size, 20, "têm de ser 20 linhas distintas");
  for (const [caminho, n] of porCaminho) assert.equal(n, 2, `${caminho} pedido ${n} vezes (esperado 2: sem Referer e com Referer)`);
  semEscritas(stub);
});
await check("3 elegíveis: obtidas=3", async () => {
  const linhas = [1, 2, 3].map((i) => LINHA(`SKU-SINTETICO-D${i}`, `http://127.0.0.1:${PORTA}/ok/d${i}`));
  const stub = novoStub({ modo: "normal", linhas });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  assert.equal(linhaUnica(r, "IC_AMOSTRA:"), "IC_AMOSTRA: pedidas=20 obtidas=3 https=0 http=3");
  semEscritas(stub);
});

console.log("(d) pedidos à miniatura");
await check("hotlink: ok sem Referer e não ok com o Referer da app; o pedido leva o UA e o Accept de browser", async () => {
  pedidos.length = 0;
  const stub = novoStub({ modo: "normal", linhas: [LINHA("SKU-SINTETICO-E1", `http://127.0.0.1:${PORTA}/hotlink`)] });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  const t = lerCampos(linhaUnica(r, "IC_TOTAIS:"));
  assert.equal(t.ok_sem_referer, "1");
  assert.equal(t.ok_referer_app, "0");
  assert.equal(linhaUnica(r, "IC_RESULTADO:"), "IC_RESULTADO: n=1 esquema=http sem_referer=200/imagem app=403/nao_imagem redireciona=nao destino=-");
  assert.equal(linhaUnica(r, "IC_HTTPS:"), "IC_HTTPS: testadas=1 ok=0 com_erro=1", "o https de uma linha http é pedido, e aqui falha em TLS");
  const hits = pedidos.filter((p) => p.caminho === "/hotlink");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].referer, null, "o primeiro pedido não tem Referer");
  assert.equal(hits[1].referer, REFERER_APP, "o segundo leva o Referer da app");
  for (const h of hits) {
    assert.match(h.userAgent, /Mozilla\/5\.0.*Chrome\/124/);
    assert.equal(h.accept, ACCEPT);
  }
  semEscritas(stub);
});
await check("redirect: o 3xx fica registado com o destino, não é seguido e não conta como ok", async () => {
  pedidos.length = 0;
  const stub = novoStub({ modo: "normal", linhas: [LINHA("SKU-SINTETICO-F1", `http://127.0.0.1:${PORTA}/redir`)] });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  const t = lerCampos(linhaUnica(r, "IC_TOTAIS:"));
  assert.equal(t.para_http, "1");
  assert.equal(t.para_https, "0");
  assert.equal(t.ok_sem_referer, "0");
  assert.equal(t.ok_referer_app, "0");
  assert.equal(
    linhaUnica(r, "IC_RESULTADO:"),
    "IC_RESULTADO: n=1 esquema=http sem_referer=301/- app=301/- redireciona=para_http destino=mesmo",
  );
  assert.equal(pedidos.filter((p) => p.caminho === "/ok/redir").length, 0, "o destino do redirecionamento não é pedido");
  semEscritas(stub);
});
await check("https 200 com imagem: a sonda https conta como ok quando responde; TLS só aqui, com certificado de teste", async () => {
  // Servidor TLS com certificado autoassinado gerado na hora. O processo filho aceita-o só neste caso (NODE_TLS_REJECT_UNAUTHORIZED).
  const chave = path.join(tmp, "tls-key.pem");
  const cert = path.join(tmp, "tls-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", chave, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const tlsServidor = https.createServer({ key: fs.readFileSync(chave), cert: fs.readFileSync(cert) }, (req, res) => {
    if (req.url.startsWith("/ok")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end("png");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => tlsServidor.listen(0, "127.0.0.1", r));
  try {
    const porta = tlsServidor.address().port;
    const stub = novoStub({ modo: "normal", linhas: [LINHA("SKU-SINTETICO-T1", `http://127.0.0.1:${porta}/ok/tls1`)] });
    const r = await correr({ IMAGE_CHECK_PRISMA: stub.caminho, NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.equal(r.status, 0, `saída: ${r.status}`);
    assert.equal(linhaUnica(r, "IC_HTTPS:"), "IC_HTTPS: testadas=1 ok=1 com_erro=0");
    assert.match(linhaUnica(r, "IC_RESULTADO:"), /^IC_RESULTADO: n=1 esquema=http sem_referer=erro\/[A-Z_]+ app=erro\/[A-Z_]+ redireciona=nao destino=-$/);
    semEscritas(stub);
  } finally {
    await new Promise((r) => tlsServidor.close(r));
  }
});
await check("respostas que não são imagem: html e 500 ficam nao_imagem e não contam como ok", async () => {
  const stub = novoStub({
    modo: "normal",
    linhas: [LINHA("SKU-SINTETICO-G1", `http://127.0.0.1:${PORTA}/html/g1`), LINHA("SKU-SINTETICO-G2", `http://127.0.0.1:${PORTA}/falha/g2`)],
  });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  assert.deepEqual(linhasDe(r, "IC_RESULTADO:"), [
    "IC_RESULTADO: n=1 esquema=http sem_referer=200/nao_imagem app=200/nao_imagem redireciona=nao destino=-",
    "IC_RESULTADO: n=1 esquema=http sem_referer=500/nao_imagem app=500/nao_imagem redireciona=nao destino=-",
  ]);
  const t = lerCampos(linhaUnica(r, "IC_TOTAIS:"));
  assert.equal(t.ok_sem_referer, "0");
  assert.equal(t.ok_referer_app, "0");
  assert.equal(linhaUnica(r, "IC_HTTPS:"), "IC_HTTPS: testadas=2 ok=0 com_erro=2");
  semEscritas(stub);
});
await check("https sem servidor: erro de rede como erro/<código>, sem mensagem; linha https não gera sonda", async () => {
  const stub = novoStub({ modo: "normal", linhas: [LINHA("SKU-SINTETICO-H1", `https://127.0.0.1:${FECHADA}/x`)] });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  assert.match(
    linhaUnica(r, "IC_RESULTADO:"),
    /^IC_RESULTADO: n=1 esquema=https sem_referer=erro\/(ECONNREFUSED|FETCH) app=erro\/(ECONNREFUSED|FETCH) redireciona=nao destino=-$/,
  );
  assert.equal(lerCampos(linhaUnica(r, "IC_TOTAIS:")).com_erro, "1");
  assert.equal(linhaUnica(r, "IC_HTTPS:"), "IC_HTTPS: testadas=0 ok=0 com_erro=0", "só as linhas http têm sonda https");
  semEscritas(stub);
});

console.log("(e) paginação e leitura mínima");
await check("1003 linhas em duas lojas: duas páginas, total fecha com count(), só imageUrl, shop e sku", async () => {
  const linhas = [];
  for (let i = 0; i < 1001; i += 1) {
    const sku = `SKU-SINTETICO-P${String(i).padStart(4, "0")}`;
    linhas.push(LINHA(sku, i % 10 === 0 ? null : `https://127.0.0.1:${FECHADA}/p${i}`, "loja-a.example"));
  }
  linhas.push(LINHA("SKU-SINTETICO-Q1", `https://127.0.0.1:${FECHADA}/q1`, "loja-b.example"));
  linhas.push(LINHA("SKU-SINTETICO-Q2", null, "loja-b.example"));
  const stub = novoStub({ modo: "normal", linhas });
  const r = await correrComStub(stub);
  assert.equal(r.status, 0, `saída: ${r.status}`);
  const ic = lerCampos(linhaUnica(r, "IC:"));
  const vazias = linhas.filter((l) => l.imageUrl === null).length;
  assert.equal(ic.total, String(linhas.length));
  assert.equal(ic.vazio, String(vazias));
  assert.equal(ic.https, String(linhas.length - vazias));
  assertInvariante(ic);
  const leituras = fs.readFileSync(path.join(stub.dir, "leituras.txt"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(leituras, ["imageUrl,shop,sku", "imageUrl,shop,sku"], "duas páginas, e só estes campos");
  semEscritas(stub);
});

console.log("(f) falhas sem detalhe");
await check("stub que lança: IC_ERRO catalogo_falhou, exit 1, uma linha só, sem escrita", async () => {
  const stub = novoStub({ modo: "lanca", linhas: [LINHA("SKU-SINTETICO-X1", `https://127.0.0.1:${FECHADA}/x`)] });
  const r = await correrComStub(stub);
  assert.equal(r.status, 1);
  assert.deepEqual(r.linhas, ["IC_ERRO: classe=catalogo_falhou"]);
  assert.ok(!r.stdout.includes("falha simulada"), "a mensagem do erro não pode sair");
  semEscritas(stub);
});
await check("catálogo que muda entre count() e a leitura: IC_ERRO catalogo_mudou, exit 1, sem escrita", async () => {
  const stub = novoStub({ modo: "muda", linhas: [LINHA("SKU-SINTETICO-X1", `https://127.0.0.1:${FECHADA}/x`)] });
  const r = await correrComStub(stub);
  assert.equal(r.status, 1);
  assert.deepEqual(r.linhas, ["IC_ERRO: classe=catalogo_mudou"]);
  semEscritas(stub);
});
await check("módulo do Prisma em falta: IC_ERRO modulo_falhou, exit 1", async () => {
  const r = await correr({ IMAGE_CHECK_PRISMA: path.join(tmp, "nao-existe", "prisma.mjs") });
  assert.equal(r.status, 1);
  assert.deepEqual(r.linhas, ["IC_ERRO: classe=modulo_falhou"]);
});
await check("sem BD no volume: sai antes do Prisma, sem criar o ficheiro", async () => {
  const ficheiro = path.join(tmp, "sem-bd", "dev.sqlite");
  const r = await correr({ DATABASE_URL: `file:${ficheiro}` });
  assert.equal(r.status, 1);
  assert.deepEqual(r.linhas, ["IC_ERRO: classe=catalogo_falhou"]);
  assert.ok(!fs.existsSync(ficheiro), "o SQLite não pode ser criado");
});

await new Promise((r) => servidor.close(r));
fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) {
  console.error(`\nimage-check: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nimage-check: todos os casos passaram");
