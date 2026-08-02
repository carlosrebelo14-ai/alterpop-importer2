#!/usr/bin/env node
/**
 * Validação cirúrgica das regras de Curadoria Activa (whitelist, categorias bloqueadas, excepção franchise).
 *
 * Procura no feed OcioStock (stream) os primeiros casos:
 *  1) Marca autorizada + categoria bloqueada → DRAFT (blocked_category)
 *  2) Idem + franchise prioritária → ACTIVE (priority_franchise_exception)
 *
 * Uso:
 *   node scripts/curation-spot-check.js
 *
 * Env: DRY_RUN=true (só teoria) | DRY_RUN=false (mutations reais na Dev Store)
 *      SPOT_CHECK_SHOP=alterpop-store.myshopify.com (live)
 *      SPOT_CHECK_SYNTHETIC=false — não derivar Caso 2 se ausente no CSV (falha explícita)
 */
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { config } from "../../lib/importer/config.js";
import { mapOcioStockRow } from "../../lib/importer/connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../../lib/importer/connectors/ociostock/streamCsv.js";
import { transformOcioStockRecord } from "../../lib/importer/core/transformRow.js";
import {
  evaluateCurationRules,
  resolveProductStatus,
  shouldImport,
  loadCuration,
} from "../../lib/importer/curation/index.js";
import { validateRecord } from "../../lib/importer/validation/validateRecord.js";
import { ImportJob } from "../../lib/importer/jobs/ImportJob.js";
import { ProductImporter } from "../../lib/importer/importers/ProductImporter.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { assertLiveImportAllowed } from "../../lib/importer/jobs/dryRunGuard.js";
import prisma from "../../app/db.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const SKIPPED_FILE = path.join(PROJECT_ROOT, "results", "spot-check-skipped.json");

/** Quando o feed não tem Caso 2 real, derivar do Caso 1 (mesmo SKU base + franchise no título). */
const ALLOW_SYNTHETIC_CASE2 =
  process.env.SPOT_CHECK_SYNTHETIC !== "false" && process.env.SPOT_CHECK_SYNTHETIC !== "0";

/** Cores ANSI para leitura no terminal */
const cor = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  verde: "\x1b[32m",
  amarelo: "\x1b[33m",
  vermelho: "\x1b[31m",
  ciano: "\x1b[36m",
  magenta: "\x1b[35m",
};

const CASE_KEYS = {
  BLOCKED: "blocked_category",
  PRIORITY: "priority_franchise_exception",
};

/**
 * @param {string} msg
 * @param {string} color
 */
function logCor(msg, color = cor.reset) {
  console.log(`${color}${msg}${cor.reset}`);
}

/**
 * Envolve o cliente Shopify com logs coloridos por resposta GraphQL (spot-check live).
 * O p-limit permanece activo via shopifyClient → runThrottled.
 * @param {import('../../lib/importer/shopifyClient.js').ShopifyClient} client
 */
function wrapShopifyClientWithSpotCheckLogs(client) {
  const baseGraphql = client.graphql.bind(client);

  client.graphql = async (query, variables = {}) => {
    const mutationName = (query.match(/mutation\s+(\w+)/i) || [])[1] || "GraphQL";
    const skuHint =
      variables?.variants?.[0]?.sku ||
      variables?.metafields?.[0]?.ownerId ||
      variables?.product?.title ||
      "—";

    try {
      const data = await baseGraphql(query, variables);
      logShopifyApiSuccess(mutationName, data, variables, skuHint);
      return data;
    } catch (err) {
      logShopifyApiError(mutationName, err, skuHint);
      throw err;
    }
  };

  return client;
}

/**
 * @param {string} mutationName
 * @param {object} data
 * @param {object} variables
 * @param {string} skuHint
 */
function logShopifyApiSuccess(mutationName, data, variables, skuHint) {
  const productId =
    data?.productCreate?.product?.id ||
    data?.productUpdate?.product?.id ||
    variables?.productId ||
    variables?.input?.id;

  if (mutationName === "ProductCreate" && productId) {
    logCor(
      `[SHOPIFY_API] ✓ Produto criado com sucesso ID: ${productId} (SKU: ${skuHint})`,
      cor.verde
    );
    return;
  }

  if (mutationName === "ProductUpdate" && productId) {
    logCor(
      `[SHOPIFY_API] ✓ Produto actualizado ID: ${productId} (SKU: ${skuHint})`,
      cor.verde
    );
    return;
  }

  if (mutationName === "MetafieldsSet") {
    const mf = variables?.metafields?.[0];
    if (mf?.namespace === "ociostock" && mf?.key === "net_price") {
      logCor(
        `[SHOPIFY_API] ✓ Metafield ociostock.net_price = ${mf.value} (owner: ${mf.ownerId})`,
        cor.verde
      );
      return;
    }
  }

  if (mutationName === "ProductCreateMedia") {
    const count = data?.productCreateMedia?.media?.length || 0;
    logCor(
      `[SHOPIFY_API] ✓ Imagem(ns) anexada(s): ${count} (produto: ${variables?.productId || "—"})`,
      cor.verde
    );
    return;
  }

  if (mutationName === "ProductVariantsBulkUpdate") {
    const variantSku = data?.productVariantsBulkUpdate?.productVariants?.[0]?.sku || skuHint;
    logCor(`[SHOPIFY_API] ✓ Variante actualizada SKU: ${variantSku}`, cor.verde);
    return;
  }

  logCor(`[SHOPIFY_API] ✓ ${mutationName} concluída`, cor.verde);
}

/**
 * @param {string} mutationName
 * @param {Error} err
 * @param {string} skuHint
 */
function logShopifyApiError(mutationName, err, skuHint) {
  logCor(
    `[SHOPIFY_ERROR] ✗ Falha em ${mutationName} (SKU: ${skuHint}): ${err.message}`,
    cor.vermelho
  );
}

function printLiveRunInstructions() {
  console.log("");
  logCor("╔══════════════════════════════════════════════════════════════╗", cor.vermelho);
  logCor("║  GO-LIVE CONTROLADO — Escrita real na Dev Store              ║", cor.vermelho);
  logCor("╚══════════════════════════════════════════════════════════════╝", cor.vermelho);
  logCor("Pré-requisitos:", cor.bold);
  logCor("  1. .env com DRY_RUN=false e SYNC_LIMIT=2", cor.dim);
  logCor("  2. Sessão OAuth activa (shopify app dev + app instalada na Dev Store)", cor.dim);
  logCor("  3. Metafield ociostock.net_price definido no Admin (PRODUCT)", cor.dim);
  console.log("");
  logCor("Execute:", cor.bold);
  logCor("  npm run curation:spot-check", cor.ciano);
  console.log("");
  logCor(
    `Rate limiter: p-limit concorrência=${config.shopify.graphqlConcurrency}, intervalo mín=${config.shopify.graphqlMinMs}ms`,
    cor.dim
  );
  console.log("");
}

/**
 * Motor de curadoria (alias público shouldImport = resolveProductStatus).
 * @param {import('../../lib/importer/types.js').ProductRecord} record
 */
function evaluateCuration(record) {
  return evaluateCurationRules(record);
}

/**
 * Motor de preparação: CSV → ProductRecord + glossário + validação.
 * @param {Record<string, string>} rawRow
 * @param {ImportJob} job
 */
function prepareRecord(rawRow, job) {
  const record = mapOcioStockRow(rawRow);
  if (!record) return null;

  transformOcioStockRecord(record, job);

  // Spot-check: rejeitar preço <= 0 e URLs de imagem inválidas antes de testar curadoria.
  const validation = validateRecord(record, {
    syncPrices: true,
    requirePrice: true,
    syncImages: true,
    requireTitle: true,
  });

  if (!validation.valid) {
    return { record, validationErrors: validation.errors };
  }

  const curation = evaluateCuration(record);
  return { record, curation, validationErrors: null };
}

/**
 * O catálogo OcioStock não tem (hoje) Funko + Papelería + franchise prioritária no mesmo SKU.
 * Clona o Caso 1 e injeta sinais de One Piece para validar priority_franchise_exception no motor.
 * @param {{ record: object, curation: object, rowIndex: number }} blockedCase
 */
function buildSyntheticPriorityCase(blockedCase) {
  const record = structuredClone(blockedCase.record);
  const rules = loadCuration();
  const franchiseLabel = rules.priorityFranchises[0] || "One Piece";

  if (!normalizeTitleHasFranchise(record.title, franchiseLabel)) {
    record.title = `${record.title} — ${franchiseLabel}`;
  }

  const franchiseRef = franchiseLabel.replace(/\s+/g, "").toLowerCase();
  record.franchises = [...new Set([...(record.franchises || []), franchiseRef, franchiseLabel])];

  const curation = evaluateCuration(record);
  return {
    record,
    curation,
    rowIndex: blockedCase.rowIndex,
    synthetic: true,
    derivedFromSku: blockedCase.record.sku,
  };
}

/**
 * @param {string} title
 * @param {string} franchise
 */
function normalizeTitleHasFranchise(title, franchise) {
  return String(title || "")
    .toUpperCase()
    .includes(String(franchise || "").toUpperCase());
}

/**
 * Identifica se o resultado corresponde a um dos casos-alvo do spot-check.
 * @param {{ status: string, reasons: string[] }} curation
 */
function matchSpotCase(curation) {
  if (curation.reasons.includes(CASE_KEYS.PRIORITY)) {
    return CASE_KEYS.PRIORITY;
  }
  if (curation.reasons.includes(CASE_KEYS.BLOCKED)) {
    return CASE_KEYS.BLOCKED;
  }
  return null;
}

/**
 * Imprime painel detalhado de um caso encontrado.
 * @param {string} label
 * @param {object} payload
 */
function printCasePanel(label, payload) {
  const { record, curation, synthetic, derivedFromSku } = payload;
  const statusColor = curation.status === "ACTIVE" ? cor.verde : cor.amarelo;

  console.log("");
  logCor(`${cor.bold}━━━ ${label} ━━━${cor.reset}`, cor.ciano);
  if (synthetic) {
    logCor(
      `Origem:     validação sintética (derivado do SKU ${derivedFromSku} — combo ausente no CSV)`,
      cor.amarelo
    );
  }
  logCor(`SKU:        ${record.sku}`, cor.bold);
  logCor(`Título:     ${record.title}`, cor.dim);
  logCor(`Marca:      ${record.vendor}`, cor.magenta);
  logCor(
    `Categoria:  ${record.categoryMain || record.category} (ES: ${record._source?.category || "—"})`,
    cor.ciano
  );
  if (record.productTypePath) {
    logCor(`Tipo Ocio:  ${record.productTypePath}`, cor.ciano);
  }
  logCor(`Franchises: ${(record.franchises || []).join(", ") || "—"}`, cor.dim);
  logCor(`Status:     ${curation.status}`, statusColor);
  logCor(`Motivos:    ${curation.reasons.join(", ")}`, cor.amarelo);
  logCor(`Esperado:   ${label}`, cor.verde);
}

/**
 * Percorre o CSV em stream até encontrar os casos-alvo (máx. 2 tipos).
 * @param {ImportJob} job
 */
async function scanFeedForSpotCases(job) {
  const found = {
    [CASE_KEYS.BLOCKED]: null,
    [CASE_KEYS.PRIORITY]: null,
  };
  const skipped = [];

  const allFound = () => found[CASE_KEYS.BLOCKED] && found[CASE_KEYS.PRIORITY];

  const { rowsRead, stoppedEarly } = await streamOcioStockRows({
    shouldStop: allFound,
    onRow: async (mapped, rowIndex) => {
      try {
        const prepared = prepareRecord(mapped, job);

        if (!prepared?.record) return;

        if (prepared.validationErrors) {
          skipped.push({
            sku: prepared.record.sku || "(unknown)",
            vendor: prepared.record.vendor,
            title: prepared.record.title,
            errors: prepared.validationErrors,
            rowIndex: rowIndex + 1,
          });
          return;
        }

        const caseKey = matchSpotCase(prepared.curation);
        if (!caseKey || found[caseKey]) return;

        found[caseKey] = {
          record: prepared.record,
          curation: prepared.curation,
          rowIndex: rowIndex + 1,
        };
      } catch (err) {
        skipped.push({
          sku: mapped.referencia || mapped.ean || "(unknown)",
          errors: [err.message || String(err)],
          rowIndex: rowIndex + 1,
        });
      }
    },
  });

  return { found, skipped, rowsScanned: rowsRead, stoppedEarly };
}

/**
 * Grava rejeições de validação (preço, imagem, etc.).
 * @param {object[]} skipped
 */
async function writeSkippedLog(skipped) {
  await fsPromises.mkdir(path.dirname(SKIPPED_FILE), { recursive: true });
  await fsPromises.writeFile(
    SKIPPED_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        totalSkipped: skipped.length,
        entries: skipped,
      },
      null,
      2
    )
  );
}

/**
 * Obtém sessão Shopify para modo live (Dev Store).
 */
async function loadDevStoreSession() {
  const shop =
    process.env.SPOT_CHECK_SHOP ||
    process.env.SHOP ||
    "alterpop-store.myshopify.com";

  const session = await prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Sessão Shopify não encontrada para ${shop}. Corre shopify app dev e instala a app na Dev Store.`
    );
  }

  if (session.expires && new Date(session.expires) <= new Date()) {
    throw new Error(
      `Sessão OAuth expirada para ${shop} (${session.expires}). ` +
        `Renova com: npm run dev (shopify app dev) e volta a abrir a app na Dev Store.`
    );
  }

  return { shop: session.shop, accessToken: session.accessToken };
}

/**
 * Executa upsert real ou simulado via ProductImporter.
 * @param {object[]} cases
 * @param {boolean} dryRun
 */
async function executeSpotCases(cases, dryRun) {
  const job = new ImportJob({
    jobId: `spot-check-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
    dryRun,
    importMode: "CREATE_AND_UPDATE",
  });
  await job.ensureResultsDir();

  let client;
  if (dryRun) {
    client = {
      graphql: async () => {
        throw new Error("GraphQL bloqueado: DRY_RUN=true");
      },
    };
  } else {
    const session = await loadDevStoreSession();
    client = createShopifyClientFromSession(session);
    client = wrapShopifyClientWithSpotCheckLogs(client);
    logCor(`Ligação live: ${session.shop}`, cor.verde);
    logCor(
      `Metafield alvo: ociostock.net_price (preço de tabela / custo neto OcioStock)`,
      cor.dim
    );
  }

  const importer = new ProductImporter(job, client, {
    syncImages: !dryRun,
    syncPrices: true,
    importMode: "CREATE_AND_UPDATE",
  });

  await importer.prepare();

  for (const item of cases) {
    const { record } = item;

    // Caso 2 sintético partilha o mesmo EAN do Caso 1 — em live usamos SKU de teste para não sobrescrever o DRAFT.
    if (item.synthetic && !dryRun) {
      record.sku = `${record.sku}-spot-priority`;
      logCor(`SKU de teste (sintético): ${record.sku}`, cor.amarelo);
    }

    try {
      logCor(
        `\n▶ ${dryRun ? "Simular" : "Executar"} upsert: ${record.sku} → ${item.curation.status}`,
        cor.bold
      );
      await importer.upsertOne(record);
    } catch (err) {
      logCor(`✗ Erro no SKU ${record.sku}: ${err.message}`, cor.vermelho);
      job.recordFailed({
        sku: record.sku,
        type: "spot_check",
        reason: err.message || String(err),
      });
    }
  }

  if (!dryRun) {
    await job.finalize("completed");
    logCor(`Resultados do job: results/${job.jobId}/`, cor.dim);
  }

  return job;
}

async function main() {
  const dryRun = config.import.dryRun;

  logCor("╔══════════════════════════════════════════════════════════╗", cor.ciano);
  logCor("║  Alterpop — Curation Spot Check (Curadoria Activa)      ║", cor.ciano);
  logCor("╚══════════════════════════════════════════════════════════╝", cor.ciano);

  logCor(`DRY_RUN=${dryRun}`, dryRun ? cor.amarelo : cor.vermelho);
  logCor(`Feed: ${config.ociostock.localPath || config.ociostock.csvUrl}`, cor.dim);

  const rules = loadCuration();
  logCor(`Marcas autorizadas: ${rules.allowedBrands.join(", ")}`, cor.dim);
  logCor(`Categorias bloqueadas: ${rules.blockedCategories.join(", ")}`, cor.dim);
  logCor(`Franchises prioritárias: ${rules.priorityFranchises.join(", ")}`, cor.dim);
  console.log("");

  if (!dryRun) {
    assertLiveImportAllowed(false);
    printLiveRunInstructions();
    logCor("Modo LIVE — mutations GraphQL reais (p-limit activo no shopifyClient)", cor.vermelho);
  } else {
    logCor("Modo simulação — sem chamadas à API Shopify", cor.verde);
    logCor("Para Go-Live: defina DRY_RUN=false no .env e execute npm run curation:spot-check", cor.dim);
  }

  const scanJob = new ImportJob({ jobId: "spot-check-scan", dryRun: true });

  logCor("A varrer o CSV em stream…", cor.ciano);
  const { found, skipped, rowsScanned } = await scanFeedForSpotCases(scanJob);

  await writeSkippedLog(skipped);
  if (skipped.length > 0) {
    logCor(`Validação: ${skipped.length} linha(s) em results/spot-check-skipped.json`, cor.amarelo);
  }

  logCor(`Linhas analisadas: ${rowsScanned}`, cor.dim);

  const casesToRun = [];

  if (found[CASE_KEYS.BLOCKED]) {
    printCasePanel("Caso 1 — Bloqueio padrão (blocked_category → DRAFT)", found[CASE_KEYS.BLOCKED]);
    casesToRun.push({ ...found[CASE_KEYS.BLOCKED], label: CASE_KEYS.BLOCKED });
  } else {
    logCor("✗ Caso 1 não encontrado no feed (Funko + Papelería / Escolar, sem franchise prioritária)", cor.vermelho);
  }

  let case2 = found[CASE_KEYS.PRIORITY];

  if (!case2 && found[CASE_KEYS.BLOCKED] && ALLOW_SYNTHETIC_CASE2) {
    case2 = buildSyntheticPriorityCase(found[CASE_KEYS.BLOCKED]);
    if (case2.curation.reasons.includes(CASE_KEYS.PRIORITY)) {
      logCor(
        "\nCaso 2: ausente no CSV (~29k linhas). A aplicar cenário sintético sobre o Caso 1 (SPOT_CHECK_SYNTHETIC=false para desactivar).",
        cor.amarelo
      );
      found[CASE_KEYS.PRIORITY] = case2;
    } else {
      case2 = null;
      logCor("✗ Falha ao construir Caso 2 sintético — rever shouldImport / curation.json", cor.vermelho);
    }
  }

  if (case2) {
    const case2Label = case2.synthetic
      ? "Caso 2 — Excepção franchise (sintético → ACTIVE)"
      : "Caso 2 — Excepção franchise (priority_franchise_exception → ACTIVE)";
    printCasePanel(case2Label, case2);
    casesToRun.push({ ...case2, label: CASE_KEYS.PRIORITY });
  } else if (!found[CASE_KEYS.PRIORITY]) {
    logCor(
      "✗ Caso 2 não encontrado (marca autorizada + Papelería + franchise prioritária, ex: One Piece)",
      cor.vermelho
    );
  }

  if (casesToRun.length === 0) {
    logCor("\nNenhum caso-alvo capturado. Alarga o feed ou ajusta config/curation.json.", cor.vermelho);
    process.exit(1);
  }

  console.log("");
  logCor("━━━ Execução no motor (ProductImporter + shouldImport / translateCategory) ━━━", cor.bold);
  await executeSpotCases(casesToRun, dryRun);

  logCor("\n✓ Spot-check concluído.", cor.verde);

  if (!dryRun) {
    console.log("");
    logCor("Validação visual no Admin Shopify (Dev Store):", cor.bold);
    logCor("  • Caso 1 (SKU 889698486569) → Products → filtrar Draft", cor.ciano);
    logCor("    Deve estar DRAFT (blocked_category — Papelería / Escolar)", cor.dim);
    logCor("  • Caso 2 (SKU 889698486569-spot-priority) → Products → Active", cor.ciano);
    logCor("    Deve estar ACTIVE com imagem e metafield ociostock.net_price", cor.dim);
    logCor(`  • URL: https://${process.env.SPOT_CHECK_SHOP || "alterpop-store.myshopify.com"}/admin/products`, cor.dim);
  }
}

main().catch((err) => {
  console.error(`${cor.vermelho}Spot-check falhou: ${err.message}${cor.reset}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
