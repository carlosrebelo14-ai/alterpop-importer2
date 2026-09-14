#!/usr/bin/env node
/**
 * Tarefa 40 — verificação pós-wipe, portão obrigatório antes da Tarefa 48 (publicação
 * do lote piloto).
 *
 * Não escreve em catálogo, fila nem loja — a única escrita é o seu próprio ficheiro de
 * estado (ver ADENDA 3). Qualquer verificação vermelha sai com exit code 1.
 *
 * V4 é a crítica: `shopifyProductId` órfão (aponta para um produto apagado no wipe)
 * faz o publisher tentar `productUpdate` em vez de `productCreate` e falhar com 404
 * no piloto inteiro.
 *
 * ADENDA 2 (2026-09-14) — portão separado em dois. Depois da Tarefa 48 ter corrido, V1,
 * V2 e V4 ficaram vermelhas para sempre: medem loja vazia e fila sem publicações, que
 * são pré-condições de um momento que já passou. Fixar o esperado em 8 só adiava o
 * problema até ao nono produto.
 *   SAÚDE CORRENTE (V3, V5–V11), por omissão — invariantes que têm de valer sempre, em
 *     qualquer altura da vida da loja. É este que se corre de rotina.
 *   HISTÓRICO (V1, V2, V4), só com `--pre-wipe` — pré-condições da Tarefa 48, verdadeiras
 *     entre o wipe e o primeiro publish. Guardadas para poderem voltar a servir se
 *     houver outro wipe, nunca para correr de rotina.
 *
 * ADENDA 3 (2026-09-14) — a banda de ±2% da ADENDA 2 era outra fotografia, só que com
 * margem: ±2% sobre 25 421 são 508 linhas, e um ingest que perdesse 400 produtos passava
 * verde. A forma certa separa deriva de feed de avaria de pipeline:
 *   V5  compara com o valor da corrida anterior (health-gate-state.json). Vermelho só em
 *       QUEDA acentuada (≥10%). Crescimento é normal e nunca é vermelho.
 *   V7  medido como RÁCIO do total, não como absoluto. Um absoluto que se mexe é o feed;
 *       um rácio que cai é o extrator partido.
 *   V3  volta à saúde corrente. `APPROVED = 0` por igualdade era falso alarme, mas mandá-
 *       lo para o histórico perdia sinal real: um item aprovado e por publicar é normal
 *       durante minutos e é avaria ao fim de horas. Mede-se a IDADE (metadata.approvedAt,
 *       que já existe na fila), não a contagem — e a contagem aparece sempre.
 *   V11 divergência de título entre `franchiseUniverses.js` e a loja, AMARELA. A adoção
 *       reporta e pára (saída 1): não escreve títulos, para não desfazer em silêncio
 *       edições feitas no admin. Vive aqui, no artefacto que já corre sempre, em vez de
 *       num script à parte que ninguém se lembra de correr.
 *
 * Deixou de ser 100% read-only por causa do V5: escreve `health-gate-state.json` no
 * diretório de dados, e mais nada. Nunca toca em catálogo, fila ou loja.
 *
 * ADENDA 4 (2026-09-14) — dois verdes falsos no estado:
 *   1. Referência que se auto-cura. Se uma corrida vermelha gravasse a referência, a
 *      seguinte comparava com o valor já partido e passava verde — o alarme apagava-se
 *      sozinho. Agora SÓ corridas verdes gravam; vermelha reporta e não escreve.
 *   2. Deriva lenta. Comparar só com a corrida anterior deixa passar a queda gradual —
 *      quatro corridas a perder 8% cada passam todas e o catálogo fica em 72%. V5 e V7
 *      comparam com DUAS referências: a corrida anterior e um chão de horizonte (máximo
 *      das últimas HORIZONTE_N corridas verdes). Vermelho se qualquer uma falhar.
 * V3 passou de 6h para 24h: publicação manual ao ritmo do Carlos, aprovar à sexta e
 * publicar à segunda é cadência normal.
 *
 * Tarefa 49 (2026-09-13) — V6 e V8 corrigidos. A primeira versão (Tarefa 40) tinha as
 * DUAS mal calibradas contra o comportamento real, não contra os dados:
 *   V6  era "cleanTitle IS NOT NULL = 854" — mas a Tarefa 10 grava cleanTitle no
 *       catálogo INTEIRO desde o primeiro --execute (cópia de title quando não há
 *       alteração), por desenho nunca fica NULL fora das linhas ainda não passadas
 *       pelo backfill. Passa a "cleanTitle <> title", em INTERVALO 800–900 (não valor
 *       cravado — o feed muda entre corridas, um valor fixo transformava reindexação
 *       normal em falso alarme).
 *   V8  era "coleções na loja = 35" — mas a loja tem coleções fora do âmbito do
 *       resolver (ex.: new-arrivals, janela published_at, sem templateSuffix de
 *       universo/line). Passa a contar só coleções com templateSuffix ∈
 *       {UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX} — as únicas que a guarda
 *       (V9) e a tabela de franquias realmente governam.
 *
 * Correr na Fly:
 *   node scripts/catalog/pre-pilot-verify.js              # saúde corrente (V3, V5–V11)
 *   node scripts/catalog/pre-pilot-verify.js --pre-wipe   # + histórico (V1, V2, V4)
 */
import fs from "fs/promises";
import path from "path";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { planUniverseCollections } from "../../lib/importer/shopify/universeCollections.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { assertFranchiseConditionsAligned } from "../../lib/importer/shopify/franchiseConditionsGuard.server.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";
import {
  ALTERPOP_FRANCHISE_DEFINITION_GID,
  ALTERPOP_LINE_DEFINITION_GID,
  ALTERPOP_FORMAT_DEFINITION_GID,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const GOVERNED_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

const args = process.argv.slice(2);
/** Histórico (V1, V2, V4): pré-condições da Tarefa 48, só válidas entre um wipe e o primeiro
 *  publish. Fora disso são falso alarme garantido — ver ADENDA 2 no cabeçalho. */
const PRE_WIPE = args.includes("--pre-wipe");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const PRODUCTS_COUNT_QUERY = `query { productsCount { count } }`;
const METAFIELD_DEFS_QUERY = `
  query { metafieldDefinitions(first: 10, ownerType: PRODUCT, namespace: "alterpop") { nodes { id key } } }
`;
const COLLECTIONS_PAGE_QUERY = `
  query CollCount($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle templateSuffix }
    }
  }
`;

/** Tarefa 49 — só conta coleções que a tabela de franquias governa (universo/line).
 *  Coleções fora do âmbito (ex.: new-arrivals) ficam de fora por desenho. */
async function countGovernedCollections(client) {
  let count = 0;
  let cursor = null;
  for (let p = 0; p < 20; p++) {
    const data = await client.graphql(COLLECTIONS_PAGE_QUERY, { cursor });
    const conn = data?.collections;
    for (const node of conn?.nodes || []) {
      if (GOVERNED_TEMPLATE_SUFFIXES.has(node.templateSuffix)) count += 1;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return count;
}

/** Estado entre corridas — só o que o V5/V7 precisam de comparar com a corrida anterior. */
const STATE_PATH = path.join(getDefaultConfig().paths.data, "health-gate-state.json");

/** Ficheiro ausente é ausência legítima (primeira corrida) e devolve null. Ficheiro que
 *  existe mas não se lê LANÇA — Decisão 30, falha de leitura nunca vira "sem histórico",
 *  que aqui daria verde a uma queda de catálogo por não ter com que a comparar. */
async function loadState() {
  let raw;
  try {
    raw = await fs.readFile(STATE_PATH, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${STATE_PATH}): ${err?.message || err}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`FALHA DE LEITURA (${STATE_PATH}): JSON inválido — ${err?.message || err}`);
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

const results = [];
function check(id, label, expected, actual, pass) {
  results.push({ id, label, expected, actual, level: pass ? "pass" : "fail" });
  console.log(`  ${pass ? "✓" : "✗"} ${id}  ${label} — esperado ${expected}, obtido ${actual}`);
}

/** Amarelo: aparece sempre, nunca faz o portão falhar. Para divergências que pedem juízo
 *  humano em vez de bloqueio automático (V11). */
function warn(id, label, expected, actual, clean) {
  results.push({ id, label, expected, actual, level: clean ? "pass" : "warn" });
  console.log(`  ${clean ? "✓" : "!"} ${id}  ${label} — esperado ${expected}, obtido ${actual}`);
}

/** Informativo: imprime e nunca julga. */
function info(id, label, value) {
  results.push({ id, label, expected: "—", actual: value, level: "pass" });
  console.log(`  · ${id}  ${label} — ${value}`);
}

/** V6 — intervalo, não valor cravado (Tarefa 49). */
function checkRange(id, label, min, max, actual) {
  const pass = actual >= min && actual <= max;
  check(id, label, `${min}–${max}`, actual, pass);
}

/** V5 — queda acentuada face à referência. Crescimento nunca é vermelho. */
const V5_QUEDA_MAX_PCT = 10;
/** V7 — quanto o rácio pode cair (pontos percentuais) antes de ser extrator partido. */
const V7_QUEDA_MAX_PP = 3;
/** V3 — a partir de quantas horas um APPROVED por publicar deixa de ser normal.
 *  24h e não 6h: a publicação é manual e ao ritmo do Carlos — aprovar à sexta e publicar
 *  à segunda é cadência normal, e 6h dava vermelho todo o fim de semana por nada.
 *  ANOTADO, não é para agora: a forma melhor não é a idade, é "há aprovados e o publisher
 *  correu depois da aprovação sem os consumir" — distingue fila parada de fila à espera
 *  do humano. Precisa de um carimbo da última corrida do publisher, que ainda não existe. */
const V3_STALE_HORAS = 24;
/** Quantas corridas verdes entram no horizonte longo (ADENDA 4). */
const HORIZONTE_N = 10;

/** Máximo de um histórico, ou null se não houver nenhum. */
function maxDe(historico) {
  if (!Array.isArray(historico) || !historico.length) return null;
  const nums = historico.filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

/** Queda percentual de `atual` face a `ref`, ou null sem referência. Negativa = cresceu. */
function quedaPct(ref, atual) {
  if (ref == null || !ref) return null;
  return ((ref - atual) / ref) * 100;
}

function horasDesde(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 36e5;
}

async function main() {
  console.log(
    `\n=== pre-pilot-verify (${SHOP}) — ${PRE_WIPE ? "histórico (V1, V2, V4) + saúde corrente (V3, V5–V11)" : "saúde corrente (V3, V5–V11)"} ===\n`
  );

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  if (PRE_WIPE) {
    console.log(`  — histórico: pré-condições da Tarefa 48, válidas só entre wipe e primeiro publish —`);

    // V1 — produtos na loja
    const productsCount = (await client.graphql(PRODUCTS_COUNT_QUERY))?.productsCount?.count ?? null;
    check("V1", "produtos na loja", 0, productsCount, productsCount === 0);

    // V2/V3 — status da fila de curadoria
    const published = await listCurationQueueItems("PUBLISHED");
    check("V2", "fila status=PUBLISHED", 0, published.length, published.length === 0);

    // V4 — shopifyProductId órfão (a crítica)
    const allItems = await listCurationQueueItems();
    const withShopifyId = allItems.filter((i) => i.metadata?.shopifyProductId != null);
    check("V4", "fila com shopifyProductId preenchido", 0, withShopifyId.length, withShopifyId.length === 0);
    if (withShopifyId.length) {
      console.log(`      SKUs órfãos: ${withShopifyId.slice(0, 10).map((i) => i.sku).join(", ")}${withShopifyId.length > 10 ? "…" : ""}`);
    }

    console.log(`\n  — saúde corrente —`);
  }

  const state = await loadState();

  // V3 — aprovados por publicar: mede a IDADE, não a contagem (ADENDA 3). A contagem
  // aparece sempre; publicação manual não é razão para deixar de olhar para a fila.
  const approved = await listCurationQueueItems("APPROVED");
  info("V3", "fila status=APPROVED (contagem)", approved.length);
  const semCarimbo = approved.filter((i) => horasDesde(i.metadata?.approvedAt) == null);
  const parados = approved.filter((i) => (horasDesde(i.metadata?.approvedAt) ?? 0) > V3_STALE_HORAS);
  check(
    "V3",
    `aprovados parados há mais de ${V3_STALE_HORAS}h`,
    0,
    parados.length,
    parados.length === 0
  );
  if (parados.length) {
    console.log(`      SKUs: ${parados.slice(0, 10).map((i) => i.sku).join(", ")}${parados.length > 10 ? "…" : ""}`);
  }
  // Sem carimbo não se prova idade nenhuma — reporta-se, não se conclui (Decisão 30).
  if (semCarimbo.length) {
    console.log(`      ${semCarimbo.length} aprovado(s) sem metadata.approvedAt — idade indeterminada, não contam para o vermelho`);
  }

  // V5–V7 — Prisma CatalogProduct
  const totalProducts = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const totalAnterior = state?.catalogTotal ?? null;
  const totalHorizonte = maxDe(state?.catalogTotalHistorico);
  if (totalAnterior == null && totalHorizonte == null) {
    info("V5", "CatalogProduct total (sem referência — gravada se a corrida for verde)", totalProducts);
  } else {
    const q = quedaPct(totalAnterior, totalProducts);
    const qh = quedaPct(totalHorizonte, totalProducts);
    const pior = Math.max(q ?? 0, qh ?? 0);
    check(
      "V5",
      `queda do total (anterior ${totalAnterior ?? "—"}, horizonte ${totalHorizonte ?? "—"})`,
      `< ${V5_QUEDA_MAX_PCT}%`,
      `${pior > 0 ? pior.toFixed(1) : "0.0"}% (total ${totalProducts})`,
      pior < V5_QUEDA_MAX_PCT
    );
  }

  const cleanTitleDiffRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) as c FROM CatalogProduct WHERE shop = ? AND cleanTitle IS NOT NULL AND cleanTitle <> title`,
    SHOP
  );
  const cleanTitleDiffCount = Number(cleanTitleDiffRows?.[0]?.c ?? 0);
  checkRange("V6", "cleanTitle <> title", 800, 900, cleanTitleDiffCount);

  // V7 — rácio, não absoluto (ADENDA 3): um absoluto que se mexe é o feed, um rácio que
  // cai é o extrator partido.
  const resolvedFormatCount = await prisma.catalogProduct.count({ where: { shop: SHOP, resolvedFormat: { not: null } } });
  const racio = totalProducts ? (resolvedFormatCount / totalProducts) * 100 : 0;
  const racioAnterior = state?.resolvedFormatRatio ?? null;
  const racioHorizonte = maxDe(state?.resolvedFormatRatioHistorico);
  if (racioAnterior == null && racioHorizonte == null) {
    info("V7", `resolvedFormat rácio (sem referência — gravada se a corrida for verde)`, `${racio.toFixed(1)}% (${resolvedFormatCount}/${totalProducts})`);
  } else {
    const queda = racioAnterior == null ? 0 : racioAnterior - racio;
    const quedaH = racioHorizonte == null ? 0 : racioHorizonte - racio;
    const pior = Math.max(queda, quedaH);
    check(
      "V7",
      `queda do rácio (anterior ${racioAnterior?.toFixed(1) ?? "—"}%, horizonte ${racioHorizonte?.toFixed(1) ?? "—"}%)`,
      `< ${V7_QUEDA_MAX_PP} pp`,
      `${pior > 0 ? pior.toFixed(1) : "0.0"} pp (rácio ${racio.toFixed(1)}%, ${resolvedFormatCount}/${totalProducts})`,
      pior < V7_QUEDA_MAX_PP
    );
  }

  // V8 — coleções governadas pela tabela de franquias (universo/line), não todas as
  // coleções da loja — new-arrivals e afins ficam de fora por desenho (Tarefa 49).
  const governedCollectionsCount = await countGovernedCollections(client);
  check("V8", "coleções com templateSuffix universo/line", 35, governedCollectionsCount, governedCollectionsCount === 35);

  // V9 — guarda de condições de franquia
  let v9Pass = false;
  try {
    await assertFranchiseConditionsAligned(client);
    v9Pass = true;
  } catch (err) {
    console.log(`      ${err?.message || err}`);
  }
  check("V9", "franchise:conditions-diff", "✓ tudo alinhado", v9Pass ? "✓ tudo alinhado" : "✗ desalinhado", v9Pass);

  // V10 — definições de metafield
  const defs = (await client.graphql(METAFIELD_DEFS_QUERY))?.metafieldDefinitions?.nodes || [];
  check("V10", "definições de metafield alterpop.*", 3, defs.length, defs.length === 3);
  if (defs.length !== 3) {
    console.log(`      encontradas: ${defs.map((d) => d.key).join(", ") || "nenhuma"}`);
    console.log(
      `      GIDs esperados: franchise=${ALTERPOP_FRANCHISE_DEFINITION_GID}, line=${ALTERPOP_LINE_DEFINITION_GID}, format=${ALTERPOP_FORMAT_DEFINITION_GID}`
    );
  }

  // V11 — títulos: tabela versionada vs loja. AMARELO por desenho (saída 1 da adoção):
  // reporta e pára, nunca escreve o título, para não desfazer em silêncio uma edição
  // feita no admin. Um nome corrigido no repo fica visível aqui em vez de preso.
  const plano = await planUniverseCollections(client);
  const titulosDivergentes = plano.toAdopt.filter((a) => a.existing?.title !== a.name);
  warn(
    "V11",
    "títulos iguais entre franchiseUniverses.js e a loja",
    0,
    `${titulosDivergentes.length} divergência(s)`,
    titulosDivergentes.length === 0
  );
  for (const d of titulosDivergentes) {
    console.log(`      ${d.handle}: tabela "${d.name}" · loja "${d.existing?.title}" — aplicar no admin`);
  }

  console.log(``);
  const allPass = results.every((r) => r.level !== "fail");
  const failed = results.filter((r) => r.level === "fail");
  const warned = results.filter((r) => r.level === "warn");

  // ADENDA 4 — só corridas VERDES actualizam a referência. Se uma corrida vermelha
  // gravasse o valor novo, a seguinte comparava com o valor já partido e passava verde:
  // o alarme apagava-se sozinho da segunda vez que alguém olhasse. A referência tem de
  // ficar a apontar ao último estado que o portão inteiro considerou são — por isso é
  // qualquer vermelha que trava a gravação, não só V5/V7. Nota: em `--pre-wipe` depois do
  // piloto, V1/V2/V4 estão vermelhas por desenho, logo esse modo nunca grava referência.
  // Amarelos (V11) não travam — não põem em causa a sanidade dos números.
  if (allPass) {
    const histTotal = [...(state?.catalogTotalHistorico || []), totalProducts].slice(-HORIZONTE_N);
    const histRacio = [...(state?.resolvedFormatRatioHistorico || []), Number(racio.toFixed(2))].slice(-HORIZONTE_N);
    await saveState({
      ...(state || {}),
      catalogTotal: totalProducts,
      resolvedFormatRatio: Number(racio.toFixed(2)),
      catalogTotalHistorico: histTotal,
      resolvedFormatRatioHistorico: histRacio,
      shop: SHOP,
      ranAt: new Date().toISOString(),
    });
  } else {
    console.log(`  (corrida vermelha — referência NÃO actualizada, continua a apontar ao último estado são)`);
  }

  if (warned.length) {
    console.log(`! ${warned.length} aviso(s) (não bloqueiam): ${warned.map((r) => r.id).join(", ")}.`);
  }
  if (allPass) {
    console.log(
      PRE_WIPE ? `✓ histórico + saúde corrente verdes. Tarefa 48 pode correr.` : `✓ saúde corrente verde.`
    );
  } else {
    console.log(`✗ ${failed.length} verificação(ões) falhou/falharam: ${failed.map((r) => r.id).join(", ")}.`);
    if (PRE_WIPE) console.log(`  Tarefa 48 TRAVADA — não corre com falhas pendentes.`);
  }

  await prisma.$disconnect();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
