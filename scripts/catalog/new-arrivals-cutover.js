#!/usr/bin/env node
/**
 * Corte do N1 (briefing 27/09) — passos 1 a 3 da sequência, antes do deploy:
 *   1. definitions  alterpop.is_new_arrival / first_published_at, forma final na criação (P4)
 *   2. backfill     first_published_at + is_new_arrival nos ACTIVE publicados
 *   3. rule         new-arrivals passa a alterpop.is_new_arrival EQUALS true (CREATED_DESC)
 * O passo 4 (deploy com newArrivals.server.js, sem newArrivalsSync) é fora daqui.
 *
 * DRY-RUN por omissão: lê tudo e mostra os três passos, a distribuição por dia (lotes
 * que expiram juntos), os produtos com a tag por status (o "produto 160"), os leitores
 * da tag nas smart collections da loja e as divergências fila × Shopify.
 *
 * Escrita: `--execute --step <definitions|backfill|rule>`, um passo de cada vez, cada
 * um com OK próprio do Carlos. Cada passo relê a loja e recusa se o anterior não estiver
 * provado (só a leitura por API conta como prova).
 *
 * Escreve só metafieldDefinitionCreate/Update, metafieldsSet e collectionUpdate (regra).
 * Nunca tags, nunca productUpdate.
 *
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/new-arrivals-cutover.js"
 *   flyctl ssh console -a alterpop-importer-app -C "node scripts/catalog/new-arrivals-cutover.js --execute --step definitions"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  ensureMetafieldDefinition,
  buildDefinitionShapeUpdateInput,
  readMetafieldDefinitionShape,
  readSmartCollectionDefinitionUsage,
  updateMetafieldDefinitionShape,
} from "../../lib/importer/shopify/metafieldSetup.js";
import {
  ALTERPOP_IS_NEW_ARRIVAL_DEFINITION,
  ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION,
  NEW_ARRIVALS_DEFINITIONS,
  checkDefinitionReadyForCollectionRule,
} from "../../lib/importer/shopify/newArrivalsDefinitions.js";
import {
  NEW_ARRIVAL_DAYS,
  fetchActiveNewArrivalState,
  writeNewArrivalMetafields,
} from "../../lib/importer/shopify/newArrivals.server.js";
import {
  planNewArrivalsBackfill,
  distributionByDay,
  buildNewArrivalsRuleSet,
  DIVERGENCE_THRESHOLD_MS,
} from "../../lib/importer/shopify/newArrivalsCutover.js";
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";

const TAG = "new-arrivals-cutover";
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const STEP = args.includes("--step") ? args[args.indexOf("--step") + 1] : null;
const STEPS = ["definitions", "backfill", "rule"];
const OLD_TAG = "new-arrival";

const TAGGED_QUERY = `
  query NewArrivalsTagged($cursor: String) {
    products(first: 250, after: $cursor, query: "tag:'new-arrival'") {
      pageInfo { hasNextPage endCursor }
      nodes { id handle status createdAt publishedAt }
    }
  }
`;

const SMART_TAG_RULES = `
  query CutoverSmartTagRules($after: String) {
    collections(first: 250, after: $after, query: "collection_type:smart") {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title ruleSet { appliedDisjunctively rules { column relation condition } } }
    }
  }
`;

const NEW_ARRIVALS_COLLECTION = `
  query CutoverNewArrivalsCollection {
    collectionByIdentifier(identifier: { handle: "new-arrivals" }) {
      id handle sortOrder
      productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }
`;

const RULE_UPDATE = `
  mutation NewArrivalsRuleUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle sortOrder productsCount { count } ruleSet { appliedDisjunctively rules { column relation condition } } }
      userErrors { field message }
    }
  }
`;

const fatal = (msg) => {
  console.error(`[${TAG}] FATAL: ${msg}`);
  process.exit(1);
};

/** Pagina uma connection. `cursorVar` é o nome da variável que a query declara. */
async function pageAll(client, query, key, cursorVar) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(query, { [cursorVar]: cursor });
    const conn = data?.[key];
    out.push(...(conn?.nodes || []));
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

const describeDef = (d) =>
  d
    ? `type=${d.type?.name} storefront=${d.access?.storefront} scc=${d.capabilities?.smartCollectionCondition?.enabled} id=${d.id}`
    : "não existe";

const fpaReady = (d) =>
  !!d?.id && d.type?.name === ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION.type && buildDefinitionShapeUpdateInput(ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION, d) === null;

async function readDefinitions(client) {
  return {
    isNew: await readMetafieldDefinitionShape(client, ALTERPOP_IS_NEW_ARRIVAL_DEFINITION),
    fpa: await readMetafieldDefinitionShape(client, ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION),
  };
}

async function readQueuePublishedAt() {
  const queue = await loadCurationQueue();
  const map = new Map();
  for (const item of queue?.items || []) {
    const at = item?.metadata?.publishedAt;
    if (item?.sku && at) map.set(item.sku, at);
  }
  return map;
}

async function main() {
  if (EXECUTE && !STEPS.includes(STEP)) {
    fatal(`--execute exige --step ${STEPS.join("|")} (um passo de cada vez).`);
  }
  console.log(`=== ${TAG} (${SHOP}) · ${EXECUTE ? `EXECUTE ${STEP}` : "dry-run"} · janela ${NEW_ARRIVAL_DAYS}d ===`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const now = new Date();

  // ── leituras comuns ──────────────────────────────────────────────────────────
  const defs = await readDefinitions(client);
  const collection = (await client.graphql(NEW_ARRIVALS_COLLECTION)).collectionByIdentifier;
  if (!collection?.id) fatal("coleção new-arrivals não existe na loja.");
  const active = await fetchActiveNewArrivalState(client);
  const queueBySku = await readQueuePublishedAt();
  const plan = planNewArrivalsBackfill(active, queueBySku, now);
  if (plan.processed !== active.length) fatal(`backfill processed (${plan.processed}) != ACTIVE lidos (${active.length})`);

  if (!EXECUTE) {
    await dryRunReport(client, { defs, collection, active, queueBySku, plan });
    return;
  }

  if (STEP === "definitions") await stepDefinitions(client, defs);
  else if (STEP === "backfill") await stepBackfill(client, defs, active, plan);
  else await stepRule(client, defs, collection, active);
}

// ── dry-run ────────────────────────────────────────────────────────────────────
async function dryRunReport(client, { defs, collection, active, queueBySku, plan }) {
  // 0. Leitores da tag nas smart collections da loja.
  const smart = await pageAll(client, SMART_TAG_RULES, "collections", "after");
  const tagReaders = smart.filter((c) =>
    (c.ruleSet?.rules || []).some((r) => r.column === "TAG" && String(r.condition).toLowerCase() === OLD_TAG),
  );
  console.log(`\n--- 0. smart collections com condição TAG "${OLD_TAG}" (${smart.length} smart lidas) ---`);
  for (const c of tagReaders) console.log(`  ${c.handle} — "${c.title}"${c.handle === "new-arrivals" ? " (alvo do passo 3)" : "  ← LEITOR A MIGRAR"}`);
  if (!tagReaders.length) console.log("  nenhuma");

  // 1. Definições.
  console.log(`\n--- 1. definições ---`);
  for (const [label, def, cur] of [
    ["is_new_arrival", ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, defs.isNew],
    ["first_published_at", ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION, defs.fpa],
  ]) {
    const action = !cur ? "criar" : buildDefinitionShapeUpdateInput(def, cur) ? "alinhar forma" : "já na forma final";
    console.log(`  alterpop.${label}: ${describeDef(cur)} → ${action}`);
    console.log(`    forma: type=${def.type} storefront=${def.access.storefront} scc=${def.capabilities.smartCollectionCondition.enabled}`);
  }

  // 2. Backfill.
  console.log(`\n--- 2. backfill (ACTIVE: ${active.length}) ---`);
  console.log(`  a escrever: ${plan.rows.length} produto(s), ${plan.writes.length} metafield(s)`);
  console.log(`  já com first_published_at: ${plan.alreadySet.length}`);
  console.log(`  ACTIVE sem publishedAt (não publicados no Online Store): ${plan.unpublished.length}`);
  for (const u of plan.unpublished) console.log(`    ${u.sku}  ${u.handle}`);
  const bySource = plan.rows.reduce((m, r) => ((m[r.source] = (m[r.source] || 0) + 1), m), {});
  console.log(`  fonte da data escolhida: ${JSON.stringify(bySource)} (fila lida: ${queueBySku.size} SKU com publishedAt)`);
  console.log(`  is_new_arrival=true esperado depois do backfill: ${plan.expectedTrue}`);
  const maxDiv = Math.max(0, ...plan.rows.map((r) => r.divergenceMs ?? 0));
  console.log(`  divergências fila × Shopify > ${DIVERGENCE_THRESHOLD_MS / 60000} min: ${plan.divergences.length} (maior diferença: ${(maxDiv / 3600000).toFixed(2)} h)`);
  for (const d of plan.divergences) console.log(`    ${d.sku}  ${d.handle}  fila=${d.queue}  shopify=${d.shopify}  → ${d.chosen}`);
  const createdGap = plan.rows.filter((r) => {
    const a = active.find((x) => x.productId === r.productId);
    return a?.createdAt && new Date(r.backfillAt).getTime() < new Date(a.createdAt).getTime();
  });
  if (createdGap.length) {
    console.log(`  ⚠ data escolhida anterior ao createdAt do produto: ${createdGap.length}`);
    for (const r of createdGap) console.log(`    ${r.sku}  ${r.handle}  escolhida=${r.backfillAt}`);
  }

  console.log(`\n  publicações por dia (lotes que expiram juntos):`);
  for (const d of distributionByDay(plan.rows)) {
    console.log(`    ${d.day}  ${String(d.count).padStart(4)}  → sai a ${d.expiresOn}`);
  }

  // Produtos com a tag, por status — o "produto 160".
  const tagged = await pageAll(client, TAGGED_QUERY, "products", "cursor");
  const byStatus = tagged.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
  console.log(`\n  produtos com a tag "${OLD_TAG}": ${tagged.length} — por status ${JSON.stringify(byStatus)}`);
  const activeIds = new Set(active.map((a) => a.productId));
  const outsiders = tagged.filter((t) => !activeIds.has(t.id) || !t.publishedAt);
  for (const t of outsiders) {
    console.log(`    fora da regra nova: ${t.handle}  status=${t.status}  publishedAt=${t.publishedAt}  createdAt=${t.createdAt}`);
  }
  const activeWithoutTag = active.filter((a) => a.publishedAt && !tagged.some((t) => t.id === a.productId));
  if (activeWithoutTag.length) {
    console.log(`  ACTIVE publicados SEM a tag (entram pela regra nova): ${activeWithoutTag.length}`);
    for (const a of activeWithoutTag) console.log(`    ${a.sku}  ${a.handle}  publishedAt=${a.publishedAt}`);
  }

  // 3. Regra.
  console.log(`\n--- 3. regra da new-arrivals ---`);
  console.log(`  atual:  ${JSON.stringify(collection.ruleSet)} sort=${collection.sortOrder} produtos=${collection.productsCount?.count}`);
  const gid = defs.isNew?.id || "<GID criado no passo 1>";
  console.log(`  nova:   ${JSON.stringify({ ...buildNewArrivalsRuleSet(gid) })} sort=CREATED_DESC`);
  console.log(`  productsCount esperado depois do passo 3: ${plan.expectedTrue}`);
  const guard = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, defs.isNew);
  console.log(`  precondição P4 hoje: ${guard.ok ? "ok" : `por cumprir (${guard.reasons.join("; ")}) — esperado até ao passo 1`}`);

  reportBatchDone({
    tag: TAG,
    itemsRead: active.length,
    processed: plan.processed,
    total: active.length,
    extra: `dry-run, nada escrito · a escrever=${plan.rows.length} true_esperado=${plan.expectedTrue} com_tag=${tagged.length}`,
  });
}

// ── passo 1 ────────────────────────────────────────────────────────────────────
async function stepDefinitions(client, defs) {
  let usage = null;
  let errorCount = 0;
  let processed = 0;
  for (const [def, cur] of [
    [ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, defs.isNew],
    [ALTERPOP_FIRST_PUBLISHED_AT_DEFINITION, defs.fpa],
  ]) {
    const label = `${def.namespace}.${def.key}`;
    try {
      if (!cur) {
        const r = await ensureMetafieldDefinition(client, def);
        console.log(`  ${label}: criada ${r.definition.id}`);
      } else {
        const input = buildDefinitionShapeUpdateInput(def, cur);
        if (!input) {
          console.log(`  ${label}: já na forma final, salta`);
        } else {
          usage = usage || (await readSmartCollectionDefinitionUsage(client));
          const inUse = usage.get(cur.id) || [];
          if (inUse.length) throw new Error(`BLOQUEADA_POR_COLECAO (${inUse.join(", ")}) — não dá para alinhar`);
          await updateMetafieldDefinitionShape(client, input);
          console.log(`  ${label}: forma alinhada`);
        }
      }
      processed += 1;
    } catch (err) {
      errorCount += 1;
      console.error(`[${TAG}] ERRO ${label}: ${err.message}`);
    }
  }

  const after = await readDefinitions(client);
  console.log(`\nreleitura:`);
  console.log(`  alterpop.is_new_arrival: ${describeDef(after.isNew)}`);
  console.log(`  alterpop.first_published_at: ${describeDef(after.fpa)}`);
  const guard = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, after.isNew);
  if (!guard.ok) {
    errorCount += 1;
    console.error(`[${TAG}] P4 FALHOU em is_new_arrival: ${guard.reasons.join("; ")}`);
  } else {
    console.log(`  P4 is_new_arrival: ok (PUBLIC_READ, smartCollectionCondition ligado)`);
  }
  if (!fpaReady(after.fpa)) {
    errorCount += 1;
    console.error(`[${TAG}] first_published_at fora da forma: ${describeDef(after.fpa)}`);
  }
  reportBatchDone({ tag: TAG, itemsRead: NEW_ARRIVALS_DEFINITIONS.length, processed, total: NEW_ARRIVALS_DEFINITIONS.length, errorCount });
}

// ── passo 2 ────────────────────────────────────────────────────────────────────
async function stepBackfill(client, defs, active, plan) {
  const guard = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, defs.isNew);
  if (!guard.ok) fatal(`passo 1 por provar — is_new_arrival: ${guard.reasons.join("; ")}`);
  if (!fpaReady(defs.fpa)) fatal(`passo 1 por provar — first_published_at: ${describeDef(defs.fpa)}`);

  console.log(`  a escrever: ${plan.rows.length} produto(s), ${plan.writes.length} metafield(s)`);
  const { written, errors } = await writeNewArrivalMetafields(client, plan.writes);
  for (const e of errors) console.error(`[${TAG}] ERRO metafieldsSet (${e.productIds.join(", ")}): ${e.message}`);

  const after = await fetchActiveNewArrivalState(client);
  const trueCount = after.filter((p) => p.isNewArrival === true).length;
  const withDate = after.filter((p) => p.firstPublishedAt).length;
  const published = after.filter((p) => p.publishedAt).length;
  console.log(`\nreleitura: ACTIVE=${after.length} publicados=${published} com_first_published_at=${withDate} is_new_arrival=true: ${trueCount} (esperado ${plan.expectedTrue})`);

  let errorCount = errors.length;
  if (trueCount !== plan.expectedTrue) {
    errorCount += 1;
    console.error(`[${TAG}] contagem true ${trueCount} ≠ esperado ${plan.expectedTrue}`);
  }
  if (withDate !== published) {
    errorCount += 1;
    console.error(`[${TAG}] ${published - withDate} ACTIVE publicado(s) ainda sem first_published_at`);
  }
  reportBatchDone({
    tag: TAG,
    itemsRead: plan.writes.length,
    processed: written,
    total: plan.writes.length,
    errorCount,
    extra: `true=${trueCount}`,
  });
}

// ── passo 3 ────────────────────────────────────────────────────────────────────
async function stepRule(client, defs, collection, active) {
  const guard = checkDefinitionReadyForCollectionRule(ALTERPOP_IS_NEW_ARRIVAL_DEFINITION, defs.isNew);
  if (!guard.ok) fatal(`P4 por cumprir — is_new_arrival: ${guard.reasons.join("; ")}. A regra fecharia a definição assim.`);

  const trueCount = active.filter((p) => p.isNewArrival === true).length;
  const published = active.filter((p) => p.publishedAt).length;
  const withDate = active.filter((p) => p.firstPublishedAt).length;
  if (trueCount === 0) fatal("0 produtos com is_new_arrival=true — a coleção ficava vazia. Passo 2 por provar.");
  if (withDate !== published) fatal(`${published - withDate} ACTIVE publicado(s) sem first_published_at — passo 2 por provar.`);

  const ruleSet = buildNewArrivalsRuleSet(defs.isNew.id);
  console.log(`  antes: ${JSON.stringify(collection.ruleSet)} sort=${collection.sortOrder} produtos=${collection.productsCount?.count}`);
  console.log(`  nova:  ${JSON.stringify(ruleSet)} sort=CREATED_DESC`);
  const data = await client.graphql(RULE_UPDATE, { input: { id: collection.id, ruleSet, sortOrder: "CREATED_DESC" } });
  const userErrors = data.collectionUpdate?.userErrors || [];
  if (userErrors.length) fatal(`collectionUpdate: ${userErrors.map((e) => e.message).join("; ")}`);

  // A Shopify reindexa a smart collection de forma assíncrona — relê até bater (máx. ~2 min).
  let count = null;
  let rules = null;
  for (let i = 0; i < 12; i++) {
    const c = (await client.graphql(NEW_ARRIVALS_COLLECTION)).collectionByIdentifier;
    count = c?.productsCount?.count;
    rules = c?.ruleSet;
    if (count === trueCount) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`\nreleitura: ${JSON.stringify(rules)} productsCount=${count} (esperado ${trueCount})`);
  const ok = count === trueCount;
  if (!ok) console.error(`[${TAG}] productsCount ${count} ≠ ${trueCount}. Se a Shopify ainda estiver a reindexar, reler com o dry-run antes de concluir.`);
  reportBatchDone({ tag: TAG, itemsRead: 1, processed: 1, total: 1, errorCount: ok ? 0 : 1, extra: `productsCount=${count}` });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
