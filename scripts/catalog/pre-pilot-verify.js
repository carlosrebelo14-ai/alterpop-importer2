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
 *   SAÚDE CORRENTE (V3, V5–V13), por omissão — invariantes que têm de valer sempre, em
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
 * A lógica do estado vive em lib/health/gateState.server.js, não aqui: este script só
 * arranca com BD e sessão da loja, e os ramos VERMELHOS do estado são justamente os que
 * ninguém consegue provocar em produção sem partir alguma coisa. Lá fora, testam-se com
 * estado fabricado (scripts/tests/health-gate-state.test.js).
 *
 * Tarefa 49 (2026-09-13) — V6 e V8 corrigidos. A primeira versão (Tarefa 40) tinha as
 * DUAS mal calibradas contra o comportamento real, não contra os dados:
 *   V6  era "cleanTitle IS NOT NULL = 854" — mas a Tarefa 10 grava cleanTitle no
 *       catálogo INTEIRO desde o primeiro --execute (cópia de title quando não há
 *       alteração), por desenho nunca fica NULL fora das linhas ainda não passadas
 *       pelo backfill. Passa a "cleanTitle <> title", em INTERVALO 800–900 (não valor
 *       cravado — o feed muda entre corridas, um valor fixo transformava reindexação
 *       normal em falso alarme).
 *
 * PR #68 (2026-09-15, averbamento à Decisão 17) — intervalo alargado para 800–5400,
 * TRANSITÓRIO, para cobrir as duas pontas da transição de regime sem cravar nenhuma
 * (861 no deploy, sync ainda não corrido; ~5 087 depois do sync recalcular cleanTitle).
 *
 * FECHADO 16/09/2026 (gatilho do PR #68/#69, disparado na primeira corrida em que o
 * valor estabilizou perto de 5 087 — na prática, 5 884, catálogo cresceu entretanto).
 * V6 convertido à forma comparativa (avaliarQueda: corrida anterior + horizonte das
 * últimas verdes), igual a V5/V7, em vez do intervalo absoluto — que envelhecia a cada
 * mudança de regra de limpeza. Limiar V6_QUEDA_MAX_PCT = 15% (ver definição abaixo).
 *   V8  era "coleções na loja = 35" — mas a loja tem coleções fora do âmbito do
 *       resolver (ex.: new-arrivals, janela published_at, sem templateSuffix de
 *       universo/line). Passa a contar só coleções com templateSuffix ∈
 *       {UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX} — as únicas que a guarda
 *       (V9) e a tabela de franquias realmente governam.
 *
 * B7 (briefing backend, 17/09/2026) — V12: para cada Character ACTIVE, `products` do
 * metaobject tem de ser exatamente o conjunto de produtos ACTIVE cujo `alterpop.character`
 * o contém (secção 6 do arranque). Vermelho de verdade, não amarelo — os dois campos são
 * escritos na MESMA corrida do character-pages-sync.js; uma divergência aqui só acontece
 * se algo escreveu um dos dois lados sem o outro. Sem Character ACTIVE ainda, é informativo.
 *
 * Correr na Fly:
 *   node scripts/catalog/pre-pilot-verify.js              # saúde corrente (V3, V5–V13)
 *   node scripts/catalog/pre-pilot-verify.js --pre-wipe   # + histórico (V1, V2, V4)
 *   node scripts/catalog/pre-pilot-verify.js --aceitar-base  # aceita descida legítima
 */
import path from "path";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";
import {
  avaliarQueda,
  carregarEstado,
  gravarReferencia,
  maxDe,
} from "../../lib/health/gateState.server.js";
import { planUniverseCollections } from "../../lib/importer/shopify/universeCollections.server.js";
import { loadLiveDriftCycleState, MAX_AUTO_RECONCILE } from "../../lib/importer/shopify/liveDriftReconcileCycle.server.js";
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
  ALTERPOP_MANUFACTURER_LINE_DEFINITION_GID,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";
import { CHARACTER_METAOBJECT_TYPE } from "../../lib/importer/shopify/characterMetaobjectSetup.js";

const GOVERNED_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

const args = process.argv.slice(2);
/** Histórico (V1, V2, V4): pré-condições da Tarefa 48, só válidas entre um wipe e o primeiro
 *  publish. Fora disso são falso alarme garantido — ver ADENDA 2 no cabeçalho. */
const PRE_WIPE = args.includes("--pre-wipe");
/** Caminho de recuperação (ADENDA 5): aceita os valores desta corrida como base nova e
 *  REINICIA o histórico. Para um humano usar depois de julgar que a descida é real —
 *  sem isto, uma queda legítima prende o portão em vermelho para sempre e a única saída
 *  é apagar o ficheiro, que leva a base e o histórico à frente. */
const ACEITAR_BASE = args.includes("--aceitar-base");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const PRODUCTS_COUNT_QUERY = `query { productsCount { count } }`;
const METAFIELD_DEFS_QUERY = `
  query { metafieldDefinitions(first: 10, ownerType: PRODUCT, namespace: "alterpop") { nodes { id key type { name } } } }
`;
const COLLECTIONS_PAGE_QUERY = `
  query CollCount($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle templateSuffix }
    }
  }
`;

/** V12 — metaobjects `character` ACTIVE, com o campo `products`. */
const ACTIVE_CHARACTER_METAOBJECTS_QUERY = `
  query ActiveCharacterMetaobjects($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        capabilities { publishable { status } }
        productsField: field(key: "products") { value }
      }
    }
  }
`;

/** V12 — produtos ACTIVE com o valor atual de alterpop.character. */
const ACTIVE_PRODUCTS_CHARACTER_QUERY = `
  query ActiveProductsCharacter($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        characterField: metafield(namespace: "alterpop", key: "character") { value }
      }
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

/** V12 (B7, secção 6 do arranque, 17/09/2026) — para cada Character ACTIVE, o conjunto em
 *  `products` tem de ser igual ao conjunto de produtos ACTIVE cujo `alterpop.character` o
 *  contém. Qualquer diferença é o metaobject e o metafield a divergir — nunca deveriam,
 *  porque character-pages-sync.js escreve os dois na mesma corrida. */
async function checkCharacterProductsInvariant(client) {
  const activeCharacters = new Map(); // handle -> { id, products: Set<gid> }
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_CHARACTER_METAOBJECTS_QUERY, { type: CHARACTER_METAOBJECT_TYPE, cursor });
    const conn = data?.metaobjects;
    for (const n of conn?.nodes || []) {
      if (n.capabilities?.publishable?.status !== "ACTIVE") continue;
      let products = [];
      try {
        products = JSON.parse(n.productsField?.value || "[]");
      } catch {
        products = [];
      }
      activeCharacters.set(n.handle, { id: n.id, products: new Set(products) });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  const actualByCharacterGid = new Map(); // metaobject gid -> Set<product gid>
  cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_CHARACTER_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) {
      let refs = [];
      try {
        refs = JSON.parse(n.characterField?.value || "[]");
      } catch {
        refs = [];
      }
      for (const ref of refs) {
        if (!actualByCharacterGid.has(ref)) actualByCharacterGid.set(ref, new Set());
        actualByCharacterGid.get(ref).add(n.id);
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  const divergencias = [];
  for (const [handle, character] of activeCharacters) {
    const actual = actualByCharacterGid.get(character.id) || new Set();
    const soNoMetaobject = [...character.products].filter((p) => !actual.has(p));
    const soNoMetafield = [...actual].filter((p) => !character.products.has(p));
    if (soNoMetaobject.length || soNoMetafield.length) {
      divergencias.push({ handle, soNoMetaobject, soNoMetafield });
    }
  }
  return { totalActive: activeCharacters.size, divergencias };
}

/** Estado entre corridas — só o que o V5/V7 precisam de comparar com a corrida anterior. */
const STATE_PATH = path.join(getDefaultConfig().paths.data, "health-gate-state.json");

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


/** V5 — queda acentuada face à referência. Crescimento nunca é vermelho. */
const V5_QUEDA_MAX_PCT = 10;
/** V7 — quanto o rácio pode cair (pontos percentuais) antes de ser extrator partido. */
const V7_QUEDA_MAX_PP = 3;
/** V6 — apertado 16/09/2026 (gatilho registado no PR #68/#69: primeira corrida em que o
 *  valor estabilizasse perto de 5 087). Converteu-se à mesma forma de V5/V7 — anterior +
 *  horizonte, crescimento nunca vermelho — em vez de intervalo absoluto cravado, que
 *  envelhece a cada mudança de regra de limpeza. 15%, mais folgado que o V5 (10%): o
 *  número de títulos que mudam tem mais ruído natural (feed, novas regras) do que o
 *  total do catálogo. Palpite, como os outros — calibrar com corridas a mais. */
const V6_QUEDA_MAX_PCT = 15;
/** V3 — a partir de quantas horas um APPROVED por publicar deixa de ser normal.
 *  24h e não 6h: a publicação é manual e ao ritmo do Carlos — aprovar à sexta e publicar
 *  à segunda é cadência normal, e 6h dava vermelho todo o fim de semana por nada.
 *  ANOTADO, não é para agora: a forma melhor não é a idade, é "há aprovados e o publisher
 *  correu depois da aprovação sem os consumir" — distingue fila parada de fila à espera
 *  do humano. Precisa de um carimbo da última corrida do publisher, que ainda não existe. */
const V3_STALE_HORAS = 24;
/** Quantas corridas verdes entram no horizonte longo (ADENDA 4). */
const HORIZONTE_N = 10;

function horasDesde(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 36e5;
}

async function main() {
  console.log(
    `\n=== pre-pilot-verify (${SHOP}) — ${PRE_WIPE ? "histórico (V1, V2, V4) + saúde corrente (V3, V5–V13)" : "saúde corrente (V3, V5–V13)"} ===\n`
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

  const state = await carregarEstado(STATE_PATH);

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
    const v5 = avaliarQueda({
      anterior: totalAnterior,
      horizonte: totalHorizonte,
      atual: totalProducts,
      limiar: V5_QUEDA_MAX_PCT,
    });
    check(
      "V5",
      `queda do total (anterior ${totalAnterior ?? "—"}, horizonte ${totalHorizonte ?? "—"})`,
      `< ${V5_QUEDA_MAX_PCT}%`,
      `${v5.pior.toFixed(1)}% (total ${totalProducts})`,
      v5.passa
    );
  }

  const cleanTitleDiffRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) as c FROM CatalogProduct WHERE shop = ? AND cleanTitle IS NOT NULL AND cleanTitle <> title`,
    SHOP
  );
  const cleanTitleDiffCount = Number(cleanTitleDiffRows?.[0]?.c ?? 0);
  // Apertado 16/09/2026 — forma comparativa, como V5/V7 (ver V6_QUEDA_MAX_PCT acima).
  const cleanTitleDiffAnterior = state?.cleanTitleDiff ?? null;
  const cleanTitleDiffHorizonte = maxDe(state?.cleanTitleDiffHistorico);
  if (cleanTitleDiffAnterior == null && cleanTitleDiffHorizonte == null) {
    info("V6", "cleanTitle <> title (sem referência — gravada se a corrida for verde)", cleanTitleDiffCount);
  } else {
    const v6 = avaliarQueda({
      anterior: cleanTitleDiffAnterior,
      horizonte: cleanTitleDiffHorizonte,
      atual: cleanTitleDiffCount,
      limiar: V6_QUEDA_MAX_PCT,
    });
    check(
      "V6",
      `queda de cleanTitle <> title (anterior ${cleanTitleDiffAnterior ?? "—"}, horizonte ${cleanTitleDiffHorizonte ?? "—"})`,
      `< ${V6_QUEDA_MAX_PCT}%`,
      `${v6.pior.toFixed(1)}% (total ${cleanTitleDiffCount})`,
      v6.passa
    );
  }

  // V7 — rácio, não absoluto (ADENDA 3): um absoluto que se mexe é o feed, um rácio que
  // cai é o extrator partido.
  const resolvedFormatCount = await prisma.catalogProduct.count({ where: { shop: SHOP, resolvedFormat: { not: null } } });
  const racio = totalProducts ? (resolvedFormatCount / totalProducts) * 100 : 0;
  const racioAnterior = state?.resolvedFormatRatio ?? null;
  const racioHorizonte = maxDe(state?.resolvedFormatRatioHistorico);
  if (racioAnterior == null && racioHorizonte == null) {
    info("V7", `resolvedFormat rácio (sem referência — gravada se a corrida for verde)`, `${racio.toFixed(1)}% (${resolvedFormatCount}/${totalProducts})`);
  } else {
    const v7 = avaliarQueda({
      anterior: racioAnterior,
      horizonte: racioHorizonte,
      atual: racio,
      limiar: V7_QUEDA_MAX_PP,
      modo: "pp",
    });
    check(
      "V7",
      `queda do rácio (anterior ${racioAnterior?.toFixed(1) ?? "—"}%, horizonte ${racioHorizonte?.toFixed(1) ?? "—"}%)`,
      `< ${V7_QUEDA_MAX_PP} pp`,
      `${v7.pior.toFixed(1)} pp (rácio ${racio.toFixed(1)}%, ${resolvedFormatCount}/${totalProducts})`,
      v7.passa
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

  // V10 — definições de metafield alterpop.*. Conjunto explícito de {key, type}, não
  // contagem: uma contagem fixa parte sozinha sempre que se acrescenta uma definição
  // nova (aconteceu com manufacturer_line no B6) — e vai partir outra vez no B7, quando
  // entrar alterpop.character. Aqui só falha o que está NESTA lista e está ausente ou
  // com o tipo errado; uma definição a mais (uma futura do B7, por exemplo) não reprova
  // o gate — o gate cresce quando alguém a acrescentar aqui de propósito, não sozinho.
  const EXPECTED_METAFIELD_DEFS = [
    { key: "franchise", type: "list.single_line_text_field" },
    { key: "line", type: "list.single_line_text_field" },
    { key: "format", type: "list.single_line_text_field" },
    { key: "manufacturer_line", type: "single_line_text_field" },
  ];
  const defs = (await client.graphql(METAFIELD_DEFS_QUERY))?.metafieldDefinitions?.nodes || [];
  const defByKey = new Map(defs.map((d) => [d.key, d.type?.name]));
  const missingOrWrongType = EXPECTED_METAFIELD_DEFS.filter(
    (exp) => defByKey.get(exp.key) !== exp.type
  );
  check(
    "V10",
    "definições de metafield alterpop.* (chave+tipo)",
    "✓ todas presentes com o tipo certo",
    missingOrWrongType.length === 0 ? "✓ todas presentes com o tipo certo" : `✗ ${missingOrWrongType.length} em falta/tipo errado`,
    missingOrWrongType.length === 0
  );
  if (missingOrWrongType.length > 0) {
    for (const exp of missingOrWrongType) {
      const found = defByKey.get(exp.key);
      console.log(`      ${exp.key}: esperado type=${exp.type}, encontrado=${found ?? "AUSENTE"}`);
    }
    console.log(
      `      GIDs esperados: franchise=${ALTERPOP_FRANCHISE_DEFINITION_GID}, line=${ALTERPOP_LINE_DEFINITION_GID}, format=${ALTERPOP_FORMAT_DEFINITION_GID}, manufacturer_line=${ALTERPOP_MANUFACTURER_LINE_DEFINITION_GID}`
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

  // V13 — drift alterpop.{franchise,line,format,manufacturer_line} entre o esperado
  // (Prisma) e o real (Shopify), item 7 (ADENDA 7, 17/09/2026). Este script não corre o
  // ciclo — só lê o último estado que trigger-sync gravou (liveDriftReconcileCycle.
  // server.js) e reporta. Verde sem drift; amarelo com drift corrigido sozinho no ciclo
  // (dentro do travão); vermelho quando o travão dispara — aí é fail de verdade, não só
  // aviso, porque significa que ninguém corrigiu nada e a loja ficou com a lista toda
  // por resolver.
  const v13State = await loadLiveDriftCycleState();
  if (!v13State) {
    info("V13", "live-drift por ciclo", "sem estado — trigger-sync ainda não correu com esta versão");
  } else if (v13State.status === "green") {
    check("V13", `live-drift por ciclo (${v13State.ranAt})`, "0 produtos em drift", "0", true);
  } else if (v13State.status === "yellow") {
    const lista = v13State.corrected.map((c) => `${c.sku}.${c.field}`).join(", ");
    warn(
      "V13",
      `live-drift por ciclo (${v13State.ranAt}) — corrigido sozinho`,
      "0 produtos em drift",
      `${v13State.corrected.length} corrigido(s): ${lista}`,
      false
    );
  } else {
    const lista = v13State.blocked.map((b) => b.sku).join(", ");
    check(
      "V13",
      `live-drift por ciclo (${v13State.ranAt}) — TRAVÃO disparado (> ${MAX_AUTO_RECONCILE})`,
      `≤ ${MAX_AUTO_RECONCILE} produtos em drift`,
      `${v13State.blocked.length} produto(s): ${lista}`,
      false
    );
  }

  // V12 (B7, secção 6) — invariante products (metaobject) == produtos com alterpop.character.
  const v12 = await checkCharacterProductsInvariant(client);
  if (v12.totalActive === 0) {
    info("V12", "Characters ACTIVE × alterpop.character (produtos)", "sem Character ACTIVE ainda");
  } else {
    check(
      "V12",
      `products do metaobject == produtos com alterpop.character (${v12.totalActive} Character(s) ACTIVE)`,
      "0 divergência(s)",
      `${v12.divergencias.length} divergência(s)`,
      v12.divergencias.length === 0
    );
    for (const d of v12.divergencias) {
      if (d.soNoMetaobject.length) {
        console.log(`      ${d.handle}: só no metaobject (produto sem alterpop.character): ${d.soNoMetaobject.join(", ")}`);
      }
      if (d.soNoMetafield.length) {
        console.log(`      ${d.handle}: só no alterpop.character (fora de products): ${d.soNoMetafield.join(", ")}`);
      }
    }
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
  const { escreveu, baseReiniciada } = await gravarReferencia(STATE_PATH, {
    estadoAnterior: state,
    houveVermelho: !allPass,
    catalogTotal: totalProducts,
    resolvedFormatRatio: racio,
    cleanTitleDiff: cleanTitleDiffCount,
    shop: SHOP,
    horizonteN: HORIZONTE_N,
    aceitarNovaBase: ACEITAR_BASE,
  });
  if (baseReiniciada) {
    console.log(
      `  (--aceitar-base: base nova em ${totalProducts} / ${racio.toFixed(1)}%, histórico reiniciado.` +
        ` Esta corrida mantém o resultado que deu; é a seguinte que compara com a base nova.)`
    );
  } else if (!escreveu) {
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
