#!/usr/bin/env node
/**
 * "Verificação antes de qualquer escrita" (2026-09-13) — portão de leitura que bloqueia
 * o `--execute` da Tarefa 10/10b.
 *
 * Porquê: o censo da Tarefa 31 contou 5 455 produtos na regra `prefixo-formato` (4 327
 * só com prefixo "POP figure"). Uma amostra ao vivo de 2 000 a 2026-09-13 dá ~0,65% —
 * ~165 produtos projetados. O catálogo tem o mesmo tamanho nas duas medições
 * (25 374 → 25 421), por isso rotação de stock não explica a queda: uma coluna de
 * origem diferente explica. Antes de escrever seja o que for por cima de `title`, isto
 * mede de onde é que o texto veio.
 *
 * SÓ LEITURA — nunca escreve. Sai != 0 a qualquer falha de leitura (Decisão 30: falha
 * de leitura nunca se converte em conclusão de negócio; um zero aqui tem de ser um zero
 * medido, não uma query que rebentou).
 *
 * As 6 contagens pedidas, mais 5 que separam as hipóteses (marcadas "extra"): sem a
 * distribuição de `titleSource` não dá para distinguir "o backfill já correu" de "o
 * ingest mudou de coluna" — as duas deixam `title` sem o prefixo.
 *
 * Contagens agregadas em SQL (COUNT/SUM), não paginação por cursor: o SQLite resolve-as
 * do lado do motor sem materializar linha nenhuma, por isso não há o risco de OOM que
 * motivou o padrão da Tarefa 17 (esse aplica-se a varrimentos que trazem as linhas para
 * memória, como o title-clean-rule-sample.js).
 *
 * `--csv` acrescenta a contraprova externa: conta o prefixo no feed do OcioStock em
 * bruto, sem passar pela BD, e reconstrói o título que o pipeline antigo (glossário)
 * teria produzido para cada linha. Streaming — memória constante.
 *
 * Correr na Fly:
 *   node scripts/catalog/title-field-provenance-audit.js
 *   node scripts/catalog/title-field-provenance-audit.js --csv
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { streamOcioStockRows } from "../../lib/importer/connectors/ociostock/streamCsv.js";
import { mapOcioStockRow } from "../../lib/importer/connectors/ociostock/csvFieldMap.js";
import { translateTitleFromGlossary } from "../../lib/importer/transform/glossary/translateTitle.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const WITH_CSV = args.includes("--csv");

/** O prefixo em causa — o que a tradução por glossário produz a partir de "Figura POP ...". */
const PREFIX = "POP figure";
const startsWithPrefix = (s) => String(s || "").toLowerCase().startsWith(PREFIX.toLowerCase());

const n = (v) => Number(v ?? 0);
const pct = (part, total) => (total ? ((part / total) * 100).toFixed(2) : "0.00");

async function auditDatabase() {
  const sql = `
    SELECT
      COUNT(*)                                                                       AS total,
      SUM(CASE WHEN originalTitle IS NOT NULL THEN 1 ELSE 0 END)                     AS orig_not_null,
      SUM(CASE WHEN cleanTitle    IS NOT NULL THEN 1 ELSE 0 END)                     AS clean_not_null,
      SUM(CASE WHEN title         LIKE 'POP figure%' THEN 1 ELSE 0 END)              AS title_pop,
      SUM(CASE WHEN originalTitle LIKE 'POP figure%' THEN 1 ELSE 0 END)              AS orig_pop,
      SUM(CASE WHEN originalTitle IS NOT NULL AND title <> originalTitle
               THEN 1 ELSE 0 END)                                                    AS title_ne_orig,
      SUM(CASE WHEN cleanTitle IS NOT NULL AND cleanTitle <> title THEN 1 ELSE 0 END) AS clean_ne_title,
      SUM(CASE WHEN titleSource = 'supplier' THEN 1 ELSE 0 END)                      AS src_supplier,
      SUM(CASE WHEN titleSource = 'pipeline' THEN 1 ELSE 0 END)                      AS src_pipeline,
      SUM(CASE WHEN titleSource IS NULL THEN 1 ELSE 0 END)                           AS src_null,
      SUM(CASE WHEN titleSource = 'pipeline' AND title LIKE 'POP figure%'
               THEN 1 ELSE 0 END)                                                    AS pipeline_pop
    FROM CatalogProduct
    WHERE shop = ?
  `;

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(sql, SHOP);
  } catch (err) {
    throw new Error(`FALHA DE LEITURA (CatalogProduct): ${err?.message || err}`);
  }
  if (!rows?.length) {
    throw new Error("FALHA DE LEITURA (CatalogProduct): agregado não devolveu nenhuma linha.");
  }

  const r = rows[0];
  const total = n(r.total);
  if (!total) {
    throw new Error(
      `CatalogProduct não tem linhas nenhumas para shop="${SHOP}" — sem base para comparar. ` +
        `Confirmar o --shop antes de ler qualquer conclusão daqui.`
    );
  }

  console.log(`\n=== title-field-provenance-audit (${SHOP}) · BD ===\n`);
  console.log(`  1. total de linhas .................... ${total}`);
  console.log(`  2. originalTitle IS NOT NULL .......... ${n(r.orig_not_null)}  (${pct(n(r.orig_not_null), total)}%)`);
  console.log(`  3. cleanTitle IS NOT NULL ............. ${n(r.clean_not_null)}  (${pct(n(r.clean_not_null), total)}%)`);
  console.log(`  4. title LIKE "${PREFIX}%" ........ ${n(r.title_pop)}  (${pct(n(r.title_pop), total)}%)`);
  console.log(`  5. originalTitle LIKE "${PREFIX}%"  ${n(r.orig_pop)}  (${pct(n(r.orig_pop), total)}%)`);
  console.log(`  6. title <> originalTitle ............. ${n(r.title_ne_orig)}  (${pct(n(r.title_ne_orig), total)}%)`);
  console.log(`\n  extra — o que separa as hipóteses:`);
  console.log(`  7. cleanTitle <> title ................ ${n(r.clean_ne_title)}  (${pct(n(r.clean_ne_title), total)}%)`);
  console.log(`  8. titleSource = "supplier" ........... ${n(r.src_supplier)}  (${pct(n(r.src_supplier), total)}%)`);
  console.log(`  9. titleSource = "pipeline" ........... ${n(r.src_pipeline)}  (${pct(n(r.src_pipeline), total)}%)`);
  console.log(` 10. titleSource IS NULL ................ ${n(r.src_null)}  (${pct(n(r.src_null), total)}%)`);
  console.log(` 11. pipeline E title LIKE "${PREFIX}%" ${n(r.pipeline_pop)}  (${pct(n(r.pipeline_pop), total)}%)`);

  return r;
}

async function auditCsv() {
  console.log(`\n=== contraprova externa · feed OcioStock em bruto (streaming) ===\n`);

  let rowsSeen = 0;
  let mapped = 0;
  let usableSupplier = 0;
  let mappedTitlePop = 0;
  let supplierTitlePop = 0;
  let legacyPipelinePop = 0;

  const { rowsRead } = await streamOcioStockRows({
    onRow: (row) => {
      rowsSeen += 1;
      const record = mapOcioStockRow(row);
      if (!record) return;
      mapped += 1;

      if (record.titleSource === "supplier") usableSupplier += 1;
      if (startsWithPrefix(record.title)) mappedTitlePop += 1;
      if (startsWithPrefix(record.supplierTitleEn)) supplierTitlePop += 1;

      // O título que o pipeline ANTIGO (glossário sobre o nome espanhol) teria produzido
      // para esta linha — independentemente de hoje o supplier ganhar. É este número que
      // diz se os 5 455 da Tarefa 31 eram artefacto da nossa tradução.
      const es = String(row.nombre ?? "").trim();
      if (es && startsWithPrefix(translateTitleFromGlossary(es))) legacyPipelinePop += 1;
    },
  });

  console.log(`  linhas lidas do CSV ................... ${rowsRead}`);
  console.log(`  linhas mapeadas (com SKU) ............. ${mapped}`);
  console.log(`  título EN do fornecedor utilizável .... ${usableSupplier}  (${pct(usableSupplier, mapped)}%)`);
  console.log(`  título FINAL começa por "${PREFIX}" .. ${mappedTitlePop}  (${pct(mappedTitlePop, mapped)}%)`);
  console.log(`  título EN do fornecedor começa por ele  ${supplierTitlePop}  (${pct(supplierTitlePop, mapped)}%)`);
  console.log(`  tradução por glossário começa por ele . ${legacyPipelinePop}  (${pct(legacyPipelinePop, mapped)}%)`);

  return { rowsRead, mapped, usableSupplier, mappedTitlePop, supplierTitlePop, legacyPipelinePop };
}

async function main() {
  await auditDatabase();
  if (WITH_CSV) await auditCsv();
  else console.log(`\n(contraprova externa não corrida — juntar --csv para ler o feed em bruto)`);
  console.log("");
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
