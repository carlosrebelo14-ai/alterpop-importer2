/**
 * collectionPublicationReconcileCycle — V14, B14 (briefing backend, 24/09/2026),
 * secções 7 e 8. Corre no trigger-sync, ao lado do liveDrift (V13,
 * liveDriftReconcileCycle.server.js) — mesmo padrão: decideV14CycleAction pura e
 * testável sem Shopify/fs; reconcileCollectionPublicationCycle orquestra a Shopify e
 * persiste o estado que o portão de saúde lê.
 *
 * Pega no que a publicação-na-criação (universeCollections.server.js +
 * collectionPublication.server.js) não cobre: coleções que já existiam antes deste
 * ciclo, ou que perderam a publicação por um erro pontual.
 *
 * REGRA DURA: A APP NUNCA DESPUBLICA. Uma coleção "closed" já publicada fica só
 * registada (amarelo) — nunca some do Online Store. Só o Carlos, no Admin.
 *
 * V14:
 *   verde    — todas as "open" publicadas, nenhuma "closed" publicada.
 *   amarelo  — publicou no ciclo (com a lista), ou encontrou uma "closed" publicada.
 *   vermelho — travão disparado (> MAX_AUTO_PUBLISH), userErrors, scope em falta, ou
 *              publicationId inválido. Nestes três últimos casos a publicação é
 *              saltada por completo neste ciclo (checkCyclePreconditions/brake), nunca
 *              o resto do trigger-sync.
 */
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { checkSupplierTokens } from "../curation/prePublishChecks.server.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../catalog/franchiseLines.js";
import {
  ONLINE_STORE_PUBLICATION_ID,
  MAX_AUTO_PUBLISH,
  checkCyclePreconditions,
  planReconciliation,
} from "./collectionPublication.server.js";

const IN_SCOPE_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

function v14StatePath() {
  return path.join(getDefaultConfig().paths.data, "v14-collection-publication-state.json");
}

const COLLECTIONS_PAGE = `
  query V14CyclePage($pub: ID!, $after: String) {
    collections(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        templateSuffix
        descriptionHtml
        productsCount { count }
        publishedOnPublication(publicationId: $pub)
      }
    }
  }
`;

const PUBLISH_MUTATION = `
  mutation V14CyclePublish($id: ID!, $pub: ID!) {
    publishablePublish(id: $id, input: [{ publicationId: $pub }]) {
      userErrors { field message }
    }
  }
`;

async function fetchInScopeCollections(client, publicationId) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(COLLECTIONS_PAGE, { pub: publicationId, after: cursor });
    const page = data.collections;
    for (const node of page.nodes) {
      if (IN_SCOPE_TEMPLATE_SUFFIXES.has(node.templateSuffix)) {
        out.push({ ...node, productsCount: node.productsCount?.count ?? null });
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

/**
 * Decide o estado V14 a partir do resultado já apurado do ciclo. Pura — não sabe nada
 * de Shopify/fs, testável sem rede.
 * @param {{ preconditionsOk: boolean, preconditionsReason?: string|null, brakeTriggered?: boolean, overLimitCount?: number, published?: object[], registerOnly?: object[], errors?: object[] }} args
 * @returns {{ status: "green"|"yellow"|"red", reason: string|null }}
 */
export function decideV14CycleAction({
  preconditionsOk,
  preconditionsReason = null,
  brakeTriggered = false,
  overLimitCount = 0,
  published = [],
  registerOnly = [],
  errors = [],
}) {
  if (!preconditionsOk) {
    return { status: "red", reason: preconditionsReason };
  }
  if (brakeTriggered) {
    return {
      status: "red",
      reason: `travão: ${overLimitCount} coleção(ões) por publicar acima de MAX_AUTO_PUBLISH (${MAX_AUTO_PUBLISH})`,
    };
  }
  if (errors.length) {
    return { status: "red", reason: `userErrors ao publicar ${errors.length} coleção(ões)` };
  }
  if (published.length || registerOnly.length) {
    return { status: "yellow", reason: null };
  }
  return { status: "green", reason: null };
}

async function persistV14State(partial, shop) {
  const state = {
    status: partial.status,
    reason: partial.reason,
    shop,
    ranAt: new Date().toISOString(),
    published: partial.published || [],
    registerOnly: partial.registerOnly || [],
    blocked: partial.blocked || [],
    errors: partial.errors || [],
  };
  await fs.mkdir(path.dirname(v14StatePath()), { recursive: true });
  await fs.writeFile(v14StatePath(), JSON.stringify(state, null, 2), "utf8");
  return state;
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 */
export async function reconcileCollectionPublicationCycle(client, shop) {
  const preconditions = await checkCyclePreconditions(client, ONLINE_STORE_PUBLICATION_ID);
  if (!preconditions.ok) {
    const decision = decideV14CycleAction({ preconditionsOk: false, preconditionsReason: preconditions.reason });
    return persistV14State(decision, shop);
  }

  const collections = await fetchInScopeCollections(client, ONLINE_STORE_PUBLICATION_ID);
  const plan = planReconciliation(collections);
  const registerOnly = plan.classified.filter((c) => c.action === "register-only");

  if (plan.brakeTriggered) {
    const overLimit = plan.classified.filter((c) => c.action === "publish");
    const decision = decideV14CycleAction({
      preconditionsOk: true,
      brakeTriggered: true,
      overLimitCount: overLimit.length,
    });
    return persistV14State({ ...decision, registerOnly, blocked: overLimit }, shop);
  }

  const published = [];
  const errors = [];
  for (const c of plan.toPublish) {
    const warning = checkSupplierTokens({ descriptionHtml: c.descriptionHtml });
    if (warning) {
      console.warn(
        `[collectionPublicationCycle] aviso em "${c.title}" (${c.handle}): ${warning.message} — publica na mesma.`
      );
    }

    const res = await client.graphql(PUBLISH_MUTATION, { id: c.id, pub: ONLINE_STORE_PUBLICATION_ID });
    const errs = res.publishablePublish?.userErrors || [];
    if (errs.length) {
      errors.push({ handle: c.handle, title: c.title, errors: errs });
    } else {
      published.push({ handle: c.handle, title: c.title });
    }
  }

  const decision = decideV14CycleAction({ preconditionsOk: true, published, registerOnly, errors });
  return persistV14State({ ...decision, published, registerOnly, errors }, shop);
}

/** Lê o último estado gravado — usado pelo V14 em pre-pilot-verify.js. */
export async function loadCollectionPublicationCycleState() {
  try {
    const raw = await fs.readFile(v14StatePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${v14StatePath()}): ${err?.message || err}`);
  }
}
