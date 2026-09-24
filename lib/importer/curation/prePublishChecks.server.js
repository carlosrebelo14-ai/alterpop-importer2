/**
 * prePublishChecks — B18 (briefing backend, 17/09/2026), item 2 da ordem.
 *
 * Funções puras. Cada verificação recebe o payload de buildPublishPayload
 * (shopifyMapper.server.js) e um contexto, e devolve `{ code, severity, message,
 * evidence }` quando dispara, ou `null` quando não há nada a avisar.
 *
 * Regra que não muda: isto avisa, nunca bloqueia. A aprovação do Carlos continua a ser
 * a decisão final — ver runPrePublishChecks, que só agrega, nunca decide.
 *
 * Regra para defeitos futuros (documentada também no README):
 *   1. Defeito encontrado no live.
 *   2. Nova verificação aqui, com teste que reproduz o caso real.
 *   3. Auditoria live corrida de novo (scripts/catalog/live-publish-audit.js).
 *   4. Correção pela regra, nunca pelo produto.
 */
import { matchFormatPrefix, NOISE_PREFIXES } from "../catalog/franchiseResolver.server.js";
import { PLACEHOLDER_SNIPPETS } from "../shopify/collectionDescriptionPlaceholder.js";

export const SEVERITY = { WARNING: "warning" };

/** lowercase + NFC + espaços colapsados — mesma convenção de comparação usada no resto
 *  do repo (normalizeForMatch em universeCollections.server.js), mas sem remover
 *  pontuação: um título com pontuação diferente ainda é visivelmente diferente ao
 *  cliente, só espaço/caixa/acentuação-de-composição não deviam contar. */
export function normalizeTitleForDuplicate(title) {
  return String(title || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * TITLE_DUPLICATE — título final igual a um produto ACTIVE ou a outro item do lote em
 * aprovação. Caso real: "Star Wars Luke Skywalker", SKUs 889698675369 e 889698837972.
 * @param {{ sku: string, title: string }} payload
 * @param {{ activeProducts?: Array<{sku: string, title: string}>, batch?: Array<{sku: string, title: string}> }} context
 */
export function checkTitleDuplicate(payload, context = {}) {
  const norm = normalizeTitleForDuplicate(payload.title);
  if (!norm) return null;

  const collisions = [];
  for (const p of context.activeProducts || []) {
    if (p.sku !== payload.sku && normalizeTitleForDuplicate(p.title) === norm) {
      collisions.push({ sku: p.sku, source: "active" });
    }
  }
  for (const p of context.batch || []) {
    if (p.sku !== payload.sku && normalizeTitleForDuplicate(p.title) === norm) {
      collisions.push({ sku: p.sku, source: "batch" });
    }
  }
  if (!collisions.length) return null;

  return {
    code: "TITLE_DUPLICATE",
    severity: SEVERITY.WARNING,
    message: `Título igual a ${collisions.length} outro(s) produto(s): "${payload.title}".`,
    evidence: { title: payload.title, collisions },
  };
}

/**
 * PREFIX_RESIDUE — a primeira palavra (ou frase) do título final ainda é um prefixo de
 * formato/ruído que devia ter sido limpo. Caso real: "Rides Star Wars Luke Skywalker in
 * T-47 Airspeeder Exclusive" (SKU 889698744041) — achado nesta auditoria e corrigido
 * pela regra: "Rides" entrou em NOISE_PREFIXES (franchiseResolver.server.js), não aqui.
 * Verifica as DUAS listas — FORMAT_PREFIXES (via matchFormatPrefix, default) e
 * NOISE_PREFIXES — porque titleCleaner também as usa as duas (a guarda do averbamento
 * só restringe a NOISE_PREFIXES quando falta resolvedFormat; nunca escreve as palavras
 * à mão aqui, lê sempre da tabela.
 * @param {{ title: string }} payload
 */
export function checkPrefixResidue(payload) {
  const prefix = matchFormatPrefix(payload.title) || matchFormatPrefix(payload.title, NOISE_PREFIXES);
  if (!prefix) return null;

  return {
    code: "PREFIX_RESIDUE",
    severity: SEVERITY.WARNING,
    message: `Título começa com um prefixo que devia ter sido limpo: "${prefix}".`,
    evidence: { title: payload.title, prefix },
  };
}

/**
 * MISSING_FRANCHISE — payload sem universo resolvido. Produto cai numa página genérica,
 * sem sala de universo.
 * @param {{ resolvedFranchise: string|null }} payload
 */
export function checkMissingFranchise(payload) {
  if (payload.resolvedFranchise) return null;
  return {
    code: "MISSING_FRANCHISE",
    severity: SEVERITY.WARNING,
    message: "Sem universo (alterpop.franchise) resolvido — o produto cai numa página genérica.",
    evidence: {},
  };
}

/**
 * MISSING_FORMAT — payload sem formato resolvido. Slot de formato vazio na PDP.
 * @param {{ resolvedFormat: string|null }} payload
 */
export function checkMissingFormat(payload) {
  if (payload.resolvedFormat) return null;
  return {
    code: "MISSING_FORMAT",
    severity: SEVERITY.WARNING,
    message: "Sem formato (alterpop.format) resolvido — slot de formato vazio na PDP.",
    evidence: {},
  };
}

/** Lista inicial (16/09/2026) — tokens internos do feed que não deviam chegar à
 *  descrição pública. Caso real: descrições de 15/09 (B15, antes da correção da fonte —
 *  ver backlog, a correção da fonte continua por fazer; isto apanha a regressão).
 *
 *  Estendida (B14, 24/09/2026, secção 3) com os dois placeholders internos de
 *  descrição de coleção — importados de collectionDescriptionPlaceholder.js, fonte
 *  única, nunca escritos aqui à mão. Caso real: as 21+2 coleções live com o texto
 *  "Coleção Universe — produtos com..." / "Coleção criada automaticamente — ...". */
export const SUPPLIER_TOKENS = [
  "Xoff",
  "Clearance",
  "Offers",
  "Relojes",
  "Pop Culture Collectibles",
  ...PLACEHOLDER_SNIPPETS.map((p) => p.text),
];

/**
 * SUPPLIER_TOKENS — descrição gerada contém tokens internos do feed.
 * @param {{ descriptionHtml: string }} payload
 */
export function checkSupplierTokens(payload) {
  const html = String(payload.descriptionHtml || "");
  const htmlLower = html.toLowerCase();
  const found = SUPPLIER_TOKENS.filter((tok) => htmlLower.includes(tok.toLowerCase()));
  if (!found.length) return null;

  return {
    code: "SUPPLIER_TOKENS",
    severity: SEVERITY.WARNING,
    message: `Descrição contém token(s) interno(s) do feed: ${found.join(", ")}.`,
    evidence: { tokens: found },
  };
}

/**
 * PRICE_RULE — B10 (arredondamento: abaixo de 50 termina em ,99; a partir de 50,
 * inteiro, sempre para cima). Implementada já para não reescrever a lógica quando o B10
 * fechar, mas FICA DE FORA de PRE_PUBLISH_CHECKS (a lista ativa) até o B10 existir —
 * ligá-la agora avisaria em ~100% dos produtos, o mesmo problema que o briefing pediu
 * para evitar. Ligar: acrescentar a PRE_PUBLISH_CHECKS quando o B10 fechar.
 * @param {{ retailPrice: number|null }} payload
 */
export function checkPriceRule(payload) {
  const price = payload.retailPrice;
  if (price == null || !Number.isFinite(price)) return null;

  const expectedRounded = price < 50 ? Math.ceil(price) - 0.01 : Math.ceil(price);
  const roundedOk = price < 50
    ? Math.abs(price - (Math.floor(price) + 0.99)) < 0.001
    : Number.isInteger(price);

  if (roundedOk) return null;

  return {
    code: "PRICE_RULE",
    severity: SEVERITY.WARNING,
    message: `Preço ${price} fora da regra de arredondamento (B10).`,
    evidence: { price, expectedRounded },
  };
}

/** Verificações ativas na primeira versão do B18 — PRICE_RULE fica de fora de
 *  propósito (ver checkPriceRule). */
export const PRE_PUBLISH_CHECKS = [
  checkTitleDuplicate,
  checkPrefixResidue,
  checkMissingFranchise,
  checkMissingFormat,
  checkSupplierTokens,
];

/**
 * Corre todas as verificações ativas sobre um payload. Nunca lança, nunca bloqueia —
 * só agrega o que disparou.
 * @param {ReturnType<typeof import('../shopify/shopifyMapper.server.js').buildPublishPayload>} payload
 * @param {object} [context]
 * @returns {Array<{code: string, severity: string, message: string, evidence: object}>}
 */
export function runPrePublishChecks(payload, context = {}) {
  const warnings = [];
  for (const fn of PRE_PUBLISH_CHECKS) {
    const result = fn(payload, context);
    if (result) warnings.push(result);
  }
  return warnings;
}
