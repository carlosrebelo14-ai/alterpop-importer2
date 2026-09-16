#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · B1 — export CSV por universo, para a curadoria manual
 * dos ~300 produtos entre os 30 493. Um ficheiro por universo (34 ativos), não um só com
 * 30 493 linhas — centenas por lote, para o Sheets aguentar miniaturas por `=IMAGE()`
 * sem engasgar.
 *
 * Colunas exatamente as do briefing. `escolher`, `imagem_principal` e `nota` saem
 * vazias — o Carlos preenche. Personagem e tier acrescentam-se depois, sem refazer
 * (não são colunas aqui).
 *
 * FILTRO DE COLECCIONÁVEIS (briefing 15/09/2026, revisão) — só entram produtos de
 * fabricante COLLECTOR ou CORE (isCollectibleVendor, manufacturerTierResolver.server.js).
 * Medido antes de gerar os 34 (collectibles-filter-census.js): 4 universos ficam em
 * osso com o filtro — Studio Ghibli (0), The Legend of Zelda (2), Spy × Family (18),
 * G.I. Joe (19). `--sem-filtro` desliga, para comparação ou para um universo que o
 * Carlos decida abrir magro.
 *
 * SÓ LEITURA + ESCRITA DE FICHEIRO LOCAL. Não escreve na BD nem na loja. Paginação por
 * cursor (padrão Tarefa 17). Qualquer falha de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:
 *   node scripts/catalog/universe-csv-export.js --universo "G.I. Joe"   (uma amostra)
 *   node scripts/catalog/universe-csv-export.js --all                  (os 34 ativos)
 *   node scripts/catalog/universe-csv-export.js --all --outdir ./tmp   (destino custom)
 *   node scripts/catalog/universe-csv-export.js --all --sem-filtro     (sem filtro de fabricante)
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { isCollectibleVendor } from "../../lib/importer/catalog/manufacturerTierResolver.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const UM_UNIVERSO = valOf("--universo", null);
const TODOS = args.includes("--all");
const OUTDIR = valOf("--outdir", path.join(getDefaultConfig().paths.data, "universe-export"));
const COM_FILTRO = !args.includes("--sem-filtro");
const PAGE = 500;

const COLUNAS = [
  "SKU",
  "Título",
  "Universo",
  "Line",
  "Formato",
  "Fabricante",
  "Preço de custo",
  "Stock",
  "URLs de imagem",
  "escolher",
  "imagem_principal",
  "nota",
];

/** CSV RFC 4180 — aspas sempre que houver vírgula, aspas ou quebra de linha. */
function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvLine(cols) {
  return cols.map(csvCell).join(",") + "\r\n";
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function exportUniverso(universo, outdir) {
  const filePath = path.join(outdir, `${slugify(universo.name)}.csv`);
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  stream.write(csvLine(COLUNAS));

  let lidos = 0;
  let escritos = 0;
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP, resolvedFranchise: universo.name },
        select: {
          sku: true,
          cleanTitle: true,
          title: true,
          resolvedFranchise: true,
          resolvedLine: true,
          resolvedFormat: true,
          vendor: true,
          netPrice: true,
          stock: true,
          imageUrl: true,
        },
        orderBy: [{ shop: "asc" }, { sku: "asc" }],
        take: PAGE,
        ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
      });
    } catch (err) {
      stream.close();
      throw new Error(`FALHA DE LEITURA (CatalogProduct, universo "${universo.name}"): ${err?.message || err}`);
    }
    if (!rows.length) break;

    for (const r of rows) {
      lidos += 1;
      if (COM_FILTRO && !isCollectibleVendor(r.vendor)) continue;
      escritos += 1;
      stream.write(
        csvLine([
          r.sku,
          r.cleanTitle || r.title,
          r.resolvedFranchise || "",
          r.resolvedLine || "",
          r.resolvedFormat || "",
          r.vendor || "",
          r.netPrice != null ? r.netPrice : "",
          r.stock,
          r.imageUrl || "",
          "",
          "",
          "",
        ])
      );
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  return { filePath, linhas: escritos, lidos };
}

async function main() {
  if (!UM_UNIVERSO && !TODOS) {
    console.error(`Falta --universo "<nome>" (amostra) ou --all (os 34 ativos).`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUTDIR, { recursive: true });

  const alvos = UM_UNIVERSO
    ? FRANCHISE_UNIVERSES.filter((u) => u.name === UM_UNIVERSO)
    : FRANCHISE_UNIVERSES.filter((u) => u.active);

  if (UM_UNIVERSO && !alvos.length) {
    console.error(`Universo "${UM_UNIVERSO}" não existe em FRANCHISE_UNIVERSES.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== universe-csv-export (${SHOP}) — briefing backend B1 ===\n`);
  console.log(`Destino: ${OUTDIR}`);
  console.log(`Filtro de coleccionáveis (COLLECTOR/CORE): ${COM_FILTRO ? "ligado" : "desligado (--sem-filtro)"}`);
  console.log(`Universos: ${alvos.length}\n`);

  let totalLinhas = 0;
  let totalLidos = 0;
  const emOsso = [];
  for (const universo of alvos) {
    const { filePath, linhas, lidos } = await exportUniverso(universo, OUTDIR);
    totalLinhas += linhas;
    totalLidos += lidos;
    if (COM_FILTRO && linhas < 20) emOsso.push({ nome: universo.name, linhas });
    console.log(`  ${String(linhas).padStart(6)} / ${String(lidos).padStart(6)}  ${path.basename(filePath)}`);
  }

  console.log(`\nTotal: ${alvos.length} ficheiro(s), ${totalLinhas} linha(s) escritas de ${totalLidos} lidas.`);
  if (emOsso.length) {
    console.log(`\nEm osso (< 20 depois do filtro): ${emOsso.map((e) => `${e.nome} (${e.linhas})`).join(", ")}`);
  }
  console.log();
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
