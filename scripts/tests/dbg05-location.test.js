#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-05. Uma só regra de location para o stock dos publicados, para a publicação e para o sync de inventário.
 *   (H1) normalizeLocationId: ID numérico vira GID, GID fica igual, vazio dá undefined.
 *   (H2) locationDasDefinicoes: as definições ganham à variável de ambiente, e a variável entra quando as definições
 *        estão vazias.
 *   (H3) resolverLocationDeEscrita: sem definições nem variável, usa a primária da loja, e não a pede quando há location.
 *   (H4) resolveLocationId (runImport): o ID configurado sai normalizado, numérico vira GID.
 *   (S1) publicador, stock dos publicados e sync de inventário leem a location pelo mesmo helper (estático).
 *   (C1) o ciclo passa a location das definições ao sync de stock dos publicados (estático).
 * Mutações: M34 sem normalização numérica, M35 variável de ambiente antes das definições, M36 o ciclo deixa cair
 * locationId, M37 o sync de stock dos publicados ignora a location das definições.
 * Uso: node scripts/tests/dbg05-location.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";
import {
  locationDasDefinicoes,
  normalizeLocationId,
  resolveLocationId,
  resolverLocationDeEscrita,
} from "../../lib/importer/shopifyClient.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (rel) => semComentarios(fs.readFileSync(path.join(REPO, rel), "utf8"));

const CLIENTE = "lib/importer/shopifyClient.js";
const PUBLICADOR = "lib/importer/shopify/shopifyApprovedSync.server.js";
const STOCK = "lib/importer/shopify/publishedStockSync.server.js";
const INVENTARIO = "lib/importer/shopify/shopifyInventorySync.server.js";
const CICLO = "app/routes/api.trigger-sync.jsx";

const GID = (n) => `gid://shopify/Location/${n}`;

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

/** Cliente falso: só responde à query da primária da loja, e conta as chamadas. */
function clienteFalso(contador) {
  return {
    graphql: async () => {
      contador.n += 1;
      return {
        shop: { locations: { nodes: [{ id: GID(111), isActive: true, fulfillsOnlineOrders: true }] } },
        locations: { nodes: [] },
      };
    },
  };
}

// ---------- verificações estáticas, sobre o texto do ficheiro (sem comentários) ----------

function checarPublicador(texto) {
  assert.match(texto, /const locationId = locationDasDefinicoes\(shopSettings\);/, "o publicador usa locationDasDefinicoes");
  assert.doesNotMatch(texto, /normalizeLocationId\(/, "o publicador não tem normalização própria");
}

function checarStock(texto) {
  assert.match(
    texto,
    /const locationId = await resolverLocationDeEscrita\(client, \{ locationId: opts\.locationId \}\);/,
    "o stock dos publicados lê a location das definições pelo helper"
  );
  assert.doesNotMatch(texto, /\bresolveLocationId\b/, "o stock dos publicados não usa a regra antiga");
}

function checarInventario(texto) {
  assert.match(
    texto,
    /const locationId = await resolverLocationDeEscrita\(client, \{ locationId: params\.locationId \}\);/,
    "o sync de inventário lê a location pelo helper"
  );
  assert.doesNotMatch(texto, /\bresolveLocationId\b/, "o sync de inventário não usa a regra antiga");
}

function checarCiclo(texto) {
  assert.match(
    texto,
    /syncPublishedStockLevels\(stockClient, shop, \{[^}]*locationId: settings\.locationId,/,
    "o ciclo passa a location das definições ao sync de stock dos publicados"
  );
}

console.log("DBG-05 — location única para stock dos publicados, publicação e inventário");

await caso("(H1) normalizeLocationId: numérico vira GID, GID fica igual, vazio dá undefined", () => {
  assert.equal(normalizeLocationId("123"), GID(123));
  assert.equal(normalizeLocationId(" gid://shopify/Location/9 "), GID(9));
  assert.equal(normalizeLocationId("  "), undefined);
  assert.equal(normalizeLocationId(null), undefined);
});

await caso("(H2) locationDasDefinicoes: as definições ganham à variável, a variável entra sem definições", () => {
  assert.equal(locationDasDefinicoes({ locationId: " 42 " }, { SHOPIFY_LOCATION_ID: "7" }), GID(42));
  assert.equal(locationDasDefinicoes({ locationId: "" }, { SHOPIFY_LOCATION_ID: "7" }), GID(7));
  assert.equal(locationDasDefinicoes({}, { SHOPIFY_LOCATION_ID: " 7 " }), GID(7));
  assert.equal(locationDasDefinicoes(null, { SHOPIFY_LOCATION_ID: " " }), undefined);
  assert.equal(locationDasDefinicoes({}, {}), undefined);
});

await caso("(H4) resolveLocationId (runImport): ID numérico configurado sai como GID, sem pedir a primária", async () => {
  const contador = { n: 0 };
  assert.equal(await resolveLocationId(clienteFalso(contador), "123"), GID(123));
  assert.equal(await resolveLocationId(clienteFalso(contador), GID(9)), GID(9));
  assert.equal(contador.n, 0, "com location configurada, a primária não é pedida");
  assert.equal(await resolveLocationId(clienteFalso(contador), ""), GID(111));
  assert.equal(contador.n, 1, "sem location configurada, a primária é pedida");
});

await caso("(H3) resolverLocationDeEscrita: sem location cai na primária; com location não pede a primária", async () => {
  const anterior = process.env.SHOPIFY_LOCATION_ID;
  try {
    delete process.env.SHOPIFY_LOCATION_ID;
    const contador = { n: 0 };
    const cliente = clienteFalso(contador);
    assert.equal(await resolverLocationDeEscrita(cliente, null), GID(111));
    assert.equal(contador.n, 1, "sem location, a primária é pedida uma vez");

    assert.equal(await resolverLocationDeEscrita(cliente, { locationId: "5" }), GID(5));
    assert.equal(contador.n, 1, "com location nas definições, a primária não é pedida");

    process.env.SHOPIFY_LOCATION_ID = "8";
    assert.equal(await resolverLocationDeEscrita(cliente, {}), GID(8));
    assert.equal(contador.n, 1, "com variável de ambiente, a primária não é pedida");
  } finally {
    if (anterior === undefined) delete process.env.SHOPIFY_LOCATION_ID;
    else process.env.SHOPIFY_LOCATION_ID = anterior;
  }
});

await caso("(S1) publicador, stock dos publicados e sync de inventário usam o mesmo helper", () => {
  checarPublicador(ler(PUBLICADOR));
  checarStock(ler(STOCK));
  checarInventario(ler(INVENTARIO));
});

await caso("(C1) o ciclo passa a location das definições ao sync de stock dos publicados", () => {
  checarCiclo(ler(CICLO));
});

// ---------- mutações: cada uma tem de ser apanhada ----------

await caso("mutação M34 (DBG-05): sem normalização numérica, o ID da location vai sem GID", async () => {
  const copia = copiaMutada(CLIENTE, "M34", "if (/^\\d+$/.test(value))", "if (false)");
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M34", async () => {
      assert.equal(m.normalizeLocationId("123"), GID(123));
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M35 (DBG-05): a variável de ambiente antes das definições troca a location escolhida", async () => {
  const copia = copiaMutada(
    CLIENTE,
    "M35",
    "normalizeLocationId(definicoes?.locationId?.trim() || env.SHOPIFY_LOCATION_ID?.trim() || undefined)",
    "normalizeLocationId(env.SHOPIFY_LOCATION_ID?.trim() || definicoes?.locationId?.trim() || undefined)"
  );
  try {
    const m = await import(pathToFileURL(copia).href);
    await mutacaoTemDeFalhar("M35", async () => {
      assert.equal(m.locationDasDefinicoes({ locationId: "5" }, { SHOPIFY_LOCATION_ID: "9" }), GID(5));
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M36 (DBG-05): o ciclo deixa cair a location das definições", async () => {
  const texto = ler(CICLO);
  const mutado = trocaUma(texto, "M36", "            locationId: settings.locationId,\n", "");
  await mutacaoTemDeFalhar("M36", async () => checarCiclo(mutado));
});

await caso("mutação M37 (DBG-05): o stock dos publicados ignora a location das definições", async () => {
  const texto = ler(STOCK);
  const mutado = trocaUma(
    texto,
    "M37",
    "resolverLocationDeEscrita(client, { locationId: opts.locationId })",
    "resolverLocationDeEscrita(client, {})"
  );
  await mutacaoTemDeFalhar("M37", async () => checarStock(mutado));
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("DBG-05 — location única: todos os casos passaram");
