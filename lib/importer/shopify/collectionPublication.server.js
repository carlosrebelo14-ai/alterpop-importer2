/**
 * Publicação automática de coleções Universe/Line no Online Store — B14 (briefing
 * backend, 24/09/2026), secção 6.
 *
 * A revisão em rascunho no Admin (ADENDA 2, 13/09) deixou de existir: a coleção sai da
 * app já publicada. Duas guardas correm ANTES de qualquer publishablePublish, e
 * qualquer uma delas SALTA SÓ A PUBLICAÇÃO — nunca aborta o resto do ciclo
 * (universeCollections.server.js continua a criar coleções na mesma):
 *   1. checkAccessScopes — write_publications (e read_publications) têm de estar
 *      concedidos AGORA, não só pedidos no shopify.app.toml (ver accessScopesGuard.js).
 *   2. validatePublicationId — o ONLINE_STORE_PUBLICATION_ID de config tem de aparecer
 *      em publications(first: 50). Nunca confiado às cegas, nunca validado só no
 *      arranque do contentor (o valor pode mudar sem redeploy).
 *
 * Âmbito: coleções com templateSuffix em (UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX).
 * Uma coleção Line publica-se pelo status do universo PARENT (franchiseLines.js) — a
 * Line não tem status próprio, é subdivisão do universo.
 *
 * A app NUNCA despublica (regra dura do briefing, secção 2) — só o Carlos, no Admin.
 * Um universo que passa de "open" a "closed" fica com a coleção publicada como estava;
 * só deixa de ganhar NOVAS publicações.
 *
 * V14 (secção 7, trigger-sync — por escrever): consome o resultado destas funções para
 * decidir vermelho/amarelo/verde. Este módulo não escreve estado nenhum de gate.
 */
import { getDefaultConfig } from "../config.js";
import { checkAccessScopes, REQUIRED_PUBLISH_SCOPES } from "./accessScopesGuard.js";
import { checkSupplierTokens } from "../curation/prePublishChecks.server.js";
import { FRANCHISE_UNIVERSES, UNIVERSE_TEMPLATE_SUFFIX } from "../catalog/franchiseUniverses.js";
import { FRANCHISE_LINES, LINE_TEMPLATE_SUFFIX } from "../catalog/franchiseLines.js";

/** Trava de segurança por ciclo (secção 7) — nunca publica em lote acima disto de uma vez. */
export const MAX_AUTO_PUBLISH = 5;

/** Nunca inline na mutation — sempre por aqui. Validado a cada ciclo, nunca no arranque. */
export const ONLINE_STORE_PUBLICATION_ID = getDefaultConfig().shopify.onlineStorePublicationId;

const ACCESS_SCOPES_QUERY = `
  query CollPubAccessScopes {
    currentAppInstallation { accessScopes { handle } }
  }
`;

const PUBLICATIONS_QUERY = `
  query CollPubPublications {
    publications(first: 50) { nodes { id name } }
  }
`;

const PUBLISH_MUTATION = `
  mutation CollPubPublish($id: ID!, $pub: ID!) {
    publishablePublish(id: $id, input: [{ publicationId: $pub }]) {
      userErrors { field message }
    }
  }
`;

/**
 * Scopes concedidos AGORA (não os pedidos em shopify.app.toml).
 * @param {string[]} grantedHandles
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateAccessScopes(grantedHandles) {
  const result = checkAccessScopes(grantedHandles, REQUIRED_PUBLISH_SCOPES);
  return { ok: result.ok, missing: result.missing };
}

/**
 * O publicationId de config existe mesmo na loja agora.
 * @param {string[]} availablePublicationIds
 * @param {string} publicationId
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validatePublicationId(availablePublicationIds, publicationId) {
  const ids = Array.isArray(availablePublicationIds) ? availablePublicationIds : [];
  if (!publicationId) return { ok: false, reason: "ONLINE_STORE_PUBLICATION_ID vazio" };
  if (!ids.includes(publicationId)) {
    return { ok: false, reason: `publicationId "${publicationId}" não encontrado em publications(first: 50)` };
  }
  return { ok: true, reason: null };
}

/**
 * Guardas de início de ciclo — só leitura. Falha em qualquer uma devolve ok:false; o
 * chamador salta SÓ a publicação deste ciclo, nunca o resto (criação de coleções,
 * franchiseConditionsGuard, etc. continuam).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} publicationId
 * @returns {Promise<{ ok: boolean, reason: string|null }>}
 */
export async function checkCyclePreconditions(client, publicationId) {
  const scopesData = await client.graphql(ACCESS_SCOPES_QUERY);
  const grantedHandles = (scopesData.currentAppInstallation?.accessScopes || []).map((s) => s.handle);
  const scopes = validateAccessScopes(grantedHandles);
  if (!scopes.ok) {
    return { ok: false, reason: `scope(s) em falta: ${scopes.missing.join(", ")}` };
  }

  const pubData = await client.graphql(PUBLICATIONS_QUERY);
  const availableIds = (pubData.publications?.nodes || []).map((p) => p.id);
  const pubCheck = validatePublicationId(availableIds, publicationId);
  if (!pubCheck.ok) {
    return { ok: false, reason: pubCheck.reason };
  }

  return { ok: true, reason: null };
}

/**
 * Status do universo dono da coleção — "open"/"closed"/null (universo/line desconhecido
 * da tabela, nunca assumido "open" por omissão). Uma coleção Line herda o status do
 * universo PARENT; não tem status próprio.
 * @param {{ templateSuffix: string|null, title: string }} collection
 * @returns {"open"|"closed"|null}
 */
export function resolveOwningUniverseStatus({ templateSuffix, title }) {
  if (templateSuffix === UNIVERSE_TEMPLATE_SUFFIX) {
    const universe = FRANCHISE_UNIVERSES.find((u) => u.name === title);
    return universe ? universe.status : null;
  }
  if (templateSuffix === LINE_TEMPLATE_SUFFIX) {
    const line = FRANCHISE_LINES.find((l) => l.line === title);
    if (!line) return null;
    const parent = FRANCHISE_UNIVERSES.find((u) => u.name === line.parent);
    return parent ? parent.status : null;
  }
  return null;
}

/**
 * Classifica UMA coleção existente para a reconciliação (secção 7) — nunca decide
 * sozinha, só classifica. A app nunca despublica: uma coleção "closed" já publicada
 * fica só registada, nunca some do Online Store.
 * @param {{ templateSuffix: string|null, title: string, publishedOnPublication: boolean }} collection
 * @returns {{ action: "publish"|"register-only"|"noop"|"unknown-universe", status: "open"|"closed"|null }}
 */
export function classifyReconciliationAction(collection) {
  const status = resolveOwningUniverseStatus(collection);
  const published = !!collection.publishedOnPublication;

  if (status == null) return { action: "unknown-universe", status };
  if (status === "open" && !published) return { action: "publish", status };
  if (status === "closed" && published) return { action: "register-only", status };
  return { action: "noop", status };
}

/**
 * Plano de reconciliação sobre um lote de coleções já existentes (secção 7). Trava:
 * mais de MAX_AUTO_PUBLISH por publicar não publica NENHUMA — antes uma coleção por
 * publicar do que a loja inteira publicada de uma vez por um erro na tabela.
 * @param {Array<{ handle: string, title: string, templateSuffix: string|null, productsCount?: number, publishedOnPublication: boolean }>} collections
 * @returns {{ classified: object[], toPublish: object[], brakeTriggered: boolean }}
 */
export function planReconciliation(collections) {
  const classified = (collections || []).map((c) => ({ ...c, ...classifyReconciliationAction(c) }));
  const wouldPublish = classified.filter((c) => c.action === "publish");
  const brakeTriggered = wouldPublish.length > MAX_AUTO_PUBLISH;
  return {
    classified,
    toPublish: brakeTriggered ? [] : wouldPublish,
    brakeTriggered,
  };
}

/**
 * Publica UMA coleção recém-criada no Online Store, se o universo estiver "open".
 * Nunca chamada sem checkCyclePreconditions já ter passado neste ciclo.
 *
 * SUPPLIER_TOKENS sobre a descriptionHtml corre sempre antes do publishablePublish —
 * o aviso fica registado (console.warn) mas NUNCA bloqueia: a coleção nasce sem
 * descrição (B14 secção 3) e o aviso só apanha regressão futura de quem voltar a
 * escrever um placeholder interno.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ collection: { id: string, handle: string, title: string, templateSuffix: string|null, descriptionHtml?: string }, publicationId: string }} args
 * @returns {Promise<{ published: boolean, skipped?: boolean, failed?: boolean, reason?: string, warning?: object|null, errors?: object[] }>}
 */
export async function publishCollectionOnCreation(client, { collection, publicationId }) {
  const status = resolveOwningUniverseStatus(collection);

  if (status !== "open") {
    const reason = status === "closed" ? "universo closed" : "universo/line não está na tabela";
    console.log(`[collectionPublication] "${collection.title}" (${collection.handle}) não publicada — ${reason}.`);
    return { published: false, skipped: true, reason };
  }

  const warning = checkSupplierTokens({ descriptionHtml: collection.descriptionHtml });
  if (warning) {
    console.warn(
      `[collectionPublication] aviso em "${collection.title}" (${collection.handle}): ${warning.message} — publica na mesma.`
    );
  }

  const res = await client.graphql(PUBLISH_MUTATION, { id: collection.id, pub: publicationId });
  const errs = res.publishablePublish?.userErrors || [];
  if (errs.length) {
    console.error(`[collectionPublication] userErrors ao publicar "${collection.title}" (${collection.handle}):`, errs);
    return { published: false, failed: true, warning, errors: errs };
  }

  console.log(`[collectionPublication] publicada "${collection.title}" (${collection.handle}).`);
  return { published: true, warning: warning || null };
}
