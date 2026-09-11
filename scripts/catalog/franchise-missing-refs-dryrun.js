#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 13 — refs em falta. DRY-RUN SEMPRE — este script nunca
 * escreve em franchiseUniverses.js nem em Shopify. Só conta quantos órfãos passariam
 * a resolver se um candidato de ref/titlePattern fosse adicionado a um universo já
 * existente (prioridade sobre criar universos novos, Tarefa 15).
 *
 * Candidatos do briefing:
 *   Iron Man  → Avengers  (ref "IRON MAN", título "Iron Man")
 *   Deadpool  → X-Men     (ref "DEADPOOL", título "Deadpool")
 *
 * "Demon Slayer" do briefing NÃO tem candidato aqui — ver aviso no output. Os órfãos
 * com token "demon"/"hunters" (Tarefa 12) são "KPop Demon Hunters" (filme Netflix
 * 2025, ref real "KPopDemonHunters"), NÃO a franquia anime "Demon Slayer / Kimetsu no
 * Yaiba" que já está na tabela (handle demon-slayer). Juntar os dois seria etiquetar
 * mal os produtos — fica reportado para decisão, sem candidato aplicado.
 *
 * Correr na Fly:  node scripts/catalog/franchise-missing-refs-dryrun.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function normRef(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}
function parseRefs(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

const CANDIDATES = [
  {
    label: "Iron Man → Avengers",
    targetHandle: "avengers",
    addRefs: ["IRON MAN", "Iron Man", "Ironman"].map(normRef),
    addTitleNeedles: [` ${normText("Iron Man")} `],
  },
  {
    label: "Deadpool → X-Men",
    targetHandle: "x-men",
    addRefs: ["DEADPOOL", "Deadpool"].map(normRef),
    addTitleNeedles: [` ${normText("Deadpool")} `],
  },
];

async function main() {
  console.log(`\n=== franchise-missing-refs-dryrun (${SHOP}) — DRY-RUN, nada escrito ===\n`);

  const tallies = CANDIDATES.map((c) => ({ ...c, count: 0, samples: [] }));
  let cursor = null;
  let orphansSeen = 0;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: null },
      select: { sku: true, title: true, franchiseRefs: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      orphansSeen += 1;
      const refs = parseRefs(r.franchiseRefs).map(normRef);
      const haystack = ` ${normText(r.title)} `;
      for (const c of tallies) {
        const refHit = refs.some((ref) => c.addRefs.includes(ref));
        const titleHit = c.addTitleNeedles.some((n) => haystack.includes(n));
        if (refHit || titleHit) {
          c.count += 1;
          if (c.samples.length < 8) c.samples.push({ sku: r.sku, title: r.title, via: refHit ? "ref" : "título" });
        }
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`órfãos analisados: ${orphansSeen}\n`);
  for (const c of tallies) {
    console.log(`── ${c.label} (universo alvo: ${c.targetHandle}) ──`);
    console.log(`  órfãos que passariam a resolver: ${c.count}`);
    c.samples.forEach((s) => console.log(`    ${s.sku}  "${s.title}"  (via ${s.via})`));
    console.log("");
  }

  console.log(
    `⚠ "Demon Slayer" (briefing) — SEM candidato aplicado. Os órfãos "demon"/"hunters" da\n` +
    `  Tarefa 12 são "KPop Demon Hunters" (ref real "KPopDemonHunters"), propriedade\n` +
    `  diferente da franquia anime "Demon Slayer / Kimetsu no Yaiba" já na tabela\n` +
    `  (handle demon-slayer). Precisa de decisão: universo novo próprio (Tarefa 15) ou\n` +
    `  confirmar que é para juntar ao Demon Slayer existente (não recomendado — são\n` +
    `  IPs diferentes, juntar etiquetaria mal os produtos).`
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
