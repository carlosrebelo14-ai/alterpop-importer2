#!/usr/bin/env node
/* eslint-env node */
/**
 * Aprovação por personagem (briefing backend 04/11/2026) — ficheiro de dados, seleção,
 * resumo, escrita e reversão. Funções puras, sem Prisma nem Shopify.
 * Uso: node scripts/tests/character-approve.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import {
  buildApprovalScopes,
  buildMatcher,
  classifyRow,
  createApprovalCollector,
  buildApprovalCsv,
  buildOrphanCsv,
  assertAllHaveFranchise,
  BRIEFING_ALIASES,
  RISK_NAMES,
  ORIGIN,
  buildApprovalSummary,
  applyApproval,
  revertApproval,
  detectLoungefly,
  scopeFilter,
  universeKey,
  formatDuration,
  CSV_COLUMNS,
  META_ORIGIN,
} from "../../lib/importer/catalog/characterApproval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "../catalog/character-import-2026-10-09.json"), "utf8"));
const SCOPES = buildApprovalScopes(REAL);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

let n = 0;
function row(over = {}) {
  n += 1;
  return { sku: `SKU${String(n).padStart(4, "0")}`, title: "x", cleanTitle: null, originalTitle: null, vendor: "FUNKO", stock: 3, distributorPrice: 9.5, resolvedFranchise: null, resolvedLine: null, resolvedFormat: null, ...over };
}
const pending = (...rows) => new Map(rows.map((r) => [r.sku, { status: "PENDING", deletedAt: null }]));
const match = buildMatcher(SCOPES);
const names = (r) => [...match(r.cleanTitle || r.title).values()].map((e) => e.name);

console.log("ficheiro de dados");
check("fonte é a lista de 09/10: 27 âmbitos; origem character-import-2026-11-04", () => {
  assert.equal(REAL.id, "character-import-2026-10-09");
  assert.equal(REAL.universes.length, 27);
  assert.equal(ORIGIN, "character-import-2026-11-04");
});
check("todos os nomes da tabela de aliases do briefing existem na lista", () => {
  const all = new Set(SCOPES.flatMap((s) => s.names).map((e) => e.name));
  for (const k of Object.keys(BRIEFING_ALIASES)) assert.ok(all.has(k), k);
});
check("todos os universos existem na tabela canónica", () => {
  const canon = new Set(FRANCHISE_UNIVERSES.map((u) => u.name.normalize("NFC")));
  for (const s of SCOPES) assert.ok(canon.has(s.universe), s.universe);
});
check("passagem B: só os 9 nomes do briefing", () => {
  const b = SCOPES.flatMap((s) => s.names).filter((e) => e.mode === "A+B").map((e) => e.name).sort();
  assert.deepEqual(b, ["Captain America", "Catwoman", "Harley Quinn", "Hulk", "Joker", "Supergirl", "Thor", "Venom", "Wolverine"]);
});
check("27 nomes de risco, todos na lista", () => {
  assert.equal(RISK_NAMES.length, 27);
  const all = new Set(SCOPES.flatMap((s) => s.names).map((e) => e.name));
  for (const r of RISK_NAMES) assert.ok(all.has(r), r);
});

console.log("correspondência e aliases");
check("aliases obrigatórios batem", () => {
  const casos = [
    ["Funko POP Spiderman", "Spider-Man"],
    ["Figure Spider Man Homecoming", "Spider-Man"],
    ["Figure Ghost-Spider", "Spider-Gwen"],
    ["Figure Gwen Stacy", "Spider-Gwen"],
    ["Figure Black Suit", "fato simbionte"],
    ["Figure Symbiote Suit Spider", "fato simbionte"],
    ["Figure Colossal Titan", "Titã Colossal"],
    ["Figure Armoured Titan", "Titã Blindado"],
    ["Model Kit Char's Zaku", "Zaku II de Char"],
    ["Model Kit Char Zaku", "Zaku II de Char"],
    ["Figure Witch King of Angmar", "Nazgûl"],
    ["Figure Ringwraith", "Nazgûl"],
    ["Figure Nazgul", "Nazgûl"],
    ["Figure Vegetto Blue", "Gogeta"],
    ["Figure Phoenix", "Jean Grey"],
    ["Figure Obi Wan", "Obi-Wan Kenobi"],
    ["Figure R2D2", "R2-D2"],
    ["Figure C3PO", "C-3PO"],
    ["Figure Unit 01", "EVA-01"],
    ["Figure Unit-02", "EVA-02"],
    ["Plush Kaonashi", "No-Face"],
    ["Figure Ironman", "Iron Man"],
    ["Figure Charles Xavier", "Professor X"],
    ["Figure Dr. Strange", "Doctor Strange"],
    ["Figure Doc Ock", "Doctor Octopus"],
    ["Figure Dr. Octopus", "Doctor Octopus"],
    ["Figure Dr. Doom", "Doctor Doom"],
    ["Plush Little Green Men", "Alien"],
    ["Figure Aliens", "Alien"],
    ["Figure Itadori", "Yuji Itadori"],
  ];
  for (const [title, name] of casos) assert.ok(names({ title }).includes(name), `${title} → ${name} (bateu: ${names({ title }).join(", ")})`);
});
check("Mew não apanha Mewtwo", () => {
  const got = names({ title: "Funko POP Mewtwo" });
  assert.ok(got.includes("Mewtwo"));
  assert.ok(!got.includes("Mew"));
});
check("palavra inteira, sem acentos nem maiúsculas", () => {
  assert.ok(!names({ title: "Figure Maximus" }).includes("Max"));
  assert.ok(names({ title: "FIGURE VEGETA" }).includes("Vegeta"));
  assert.ok(names({ title: "figure nazgûl" }).includes("Nazgûl"));
});
check("cleanTitle vence title; sem cleanTitle usa title", () => {
  const r1 = row({ title: "Figure Goku", cleanTitle: "Figure Vegeta", resolvedFranchise: "Dragon Ball" });
  const r2 = row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball" });
  assert.deepEqual(names(r1), ["Vegeta"]);
  assert.deepEqual(names(r2), ["Goku"]);
});
check("Spy × Family: universo aceita x e ×", () => {
  assert.equal(universeKey("Spy × Family"), universeKey("Spy x Family"));
  const r = row({ title: "Figure Anya", resolvedFranchise: "Spy x Family" });
  const c = classifyRow(r, match(r.title), SCOPES, pending(r));
  assert.equal(c.reason, null);
});

console.log("universo");
check("Robin separa por universo", () => {
  for (const [u, scope] of [["Batman", "Batman"], ["Stranger Things", "Stranger Things"], ["One Piece", "One Piece"]]) {
    const r = row({ title: "Figure Robin", resolvedFranchise: u });
    const c = classifyRow(r, match(r.title), SCOPES, pending(r));
    assert.equal(c.reason, null, u);
    assert.equal(SCOPES[c.primary.scopeIndex].universe, scope);
    assert.equal(c.matched.length, 1);
  }
});
check("universo errado é excluído", () => {
  const r = row({ title: "Figure Goku", resolvedFranchise: "Naruto" });
  assert.equal(classifyRow(r, match(r.title), SCOPES, pending(r)).reason, "universo_errado");
});
check("Mandalorian: basta Star Wars, sem Line", () => {
  const r = row({ title: "Figure Grogu", resolvedFranchise: "Star Wars", resolvedLine: null });
  const c = classifyRow(r, match(r.title), SCOPES, pending(r));
  assert.equal(c.reason, null);
  assert.equal(SCOPES[c.primary.scopeIndex].line, "The Mandalorian");
});
check("Star Wars não exclui a Line The Mandalorian", () => {
  const r = row({ title: "Figure Darth Vader", resolvedFranchise: "Star Wars", resolvedLine: "The Mandalorian" });
  assert.equal(classifyRow(r, match(r.title), SCOPES, pending(r)).reason, null);
});
check("órfão da passagem B nunca é candidato: lista à parte", () => {
  const joker = row({ title: "Figure Joker", resolvedFranchise: null });
  const c = classifyRow(joker, match(joker.title), SCOPES, pending(joker));
  assert.equal(c.reason, "orfao_sem_franquia");
  assert.equal(c.source, "B");
  assert.equal(c.orphanEligible, true);
  const barato = row({ title: "Figure Joker", resolvedFranchise: null, distributorPrice: 2 });
  const cb = classifyRow(barato, match(barato.title), SCOPES, pending(barato));
  assert.equal(cb.orphanEligible, false);
  assert.equal(cb.orphanReason, "preco");
  const goku = row({ title: "Figure Goku", resolvedFranchise: null });
  assert.equal(classifyRow(goku, match(goku.title), SCOPES, pending(goku)).reason, "universo_errado");
});

console.log("estado, preço, âmbito");
check("só PENDING; REJECTED contado à parte", () => {
  const r = row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball" });
  const q = (status) => new Map([[r.sku, { status, deletedAt: null }]]);
  assert.equal(classifyRow(r, match(r.title), SCOPES, q("REJECTED")).reason, "rejected");
  assert.equal(classifyRow(r, match(r.title), SCOPES, q("APPROVED")).reason, "estado_approved");
  assert.equal(classifyRow(r, match(r.title), SCOPES, q("PUBLISHED")).reason, "estado_published");
  assert.equal(classifyRow(r, match(r.title), SCOPES, new Map()).reason, "fora_da_fila");
  const apagado = classifyRow(r, match(r.title), SCOPES, new Map([[r.sku, { status: "PENDING", deletedAt: "2026-10-01" }]]));
  assert.equal(apagado.reason, null, "PENDING apagado no admin entra");
  assert.equal(apagado.deletedInAdmin, true);
});
check("custo bruto > 5,00 €, exclusivo", () => {
  for (const [cost, want] of [[5, "preco"], [4.99, "preco"], [null, "preco"], [5.01, null]]) {
    const r = row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball", distributorPrice: cost });
    assert.equal(classifyRow(r, match(r.title), SCOPES, pending(r)).reason, want, String(cost));
  }
});
check("stock não filtra", () => {
  const r = row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball", stock: 0 });
  assert.equal(classifyRow(r, match(r.title), SCOPES, pending(r)).reason, null);
});
check("âmbito: coleccionáveis passam, resto fora, Loungefly entra sempre", () => {
  assert.equal(scopeFilter({ vendor: "BANPRESTO" }).pass, true);
  assert.equal(scopeFilter({ vendor: "CERDA" }).pass, false);
  assert.deepEqual(detectLoungefly({ vendor: "LOUNGEFLY" }), { loungefly: true, via: "vendor" });
  assert.deepEqual(detectLoungefly({ vendor: "X", resolvedFormat: "Loungefly" }), { loungefly: true, via: "formato" });
  assert.deepEqual(detectLoungefly({ vendor: "X", originalTitle: "Loungefly Marvel Backpack" }), { loungefly: true, via: "titulo" });
  assert.deepEqual(detectLoungefly({ vendor: "X", title: "Backpack Loungefly" }), { loungefly: false, via: null });
  const lf = scopeFilter({ vendor: "FUNKO", title: "Loungefly Stitch wallet" });
  assert.equal(lf.base, true);
  assert.equal(lf.loungefly, true);
});

console.log("colector");
check("um SKU conta uma vez; contagens e Loungefly", () => {
  const rows = [
    row({ title: "Figure Goku Vegeta", resolvedFranchise: "Dragon Ball" }),
    row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball", vendor: "CERDA" }),
    row({ title: "Loungefly Stitch backpack", originalTitle: "Loungefly Stitch backpack", resolvedFranchise: "Stitch", vendor: "LOUNGEFLY" }),
    row({ title: "Loungefly Stitch wallet", resolvedFranchise: "Stitch", vendor: "FUNKO", stock: 0 }),
    row({ title: "Figure Goku", resolvedFranchise: "Dragon Ball", distributorPrice: 3 }),
    row({ title: "Figure Goku", resolvedFranchise: "Naruto" }),
  ];
  const queue = pending(...rows);
  const orfao = row({ title: "Figure Hulk", resolvedFranchise: null });
  const apagado = row({ title: "Figure Gohan", resolvedFranchise: "Dragon Ball" });
  queue.set(orfao.sku, { status: "PENDING", deletedAt: null });
  queue.set(apagado.sku, { status: "PENDING", deletedAt: "2026-10-01" });
  rows.push(orfao, apagado);
  const col = createApprovalCollector({ scopes: SCOPES, queueBySku: queue });
  for (const r of rows) col.addRow(r);
  col.addRow(rows[0]); // repetido: ignorado
  const res = col.finalize();
  assert.equal(res.totals.total, 4);
  assert.equal(res.totals.semFiltro, 5);
  assert.equal(res.totals.soBase, 3);
  assert.equal(res.totals.apagados, 1);
  assert.equal(res.totals.orfaos, 1);
  assert.equal(res.totals.orfaosElegiveis, 1);
  assert.equal(res.excluded.orfao_sem_franquia, 1);
  assert.ok(!res.candidates.some((c) => c.sku === orfao.sku), "órfão fora dos candidatos");
  assert.doesNotThrow(() => assertAllHaveFranchise(res.candidates));
  const orf = buildOrphanCsv(res, SCOPES).split("\r\n").filter(Boolean);
  assert.equal(orf.length, 2);
  assert.ok(orf[1].startsWith(`${orfao.sku},Figure Hulk,Avengers,Hulk,`));
  assert.equal(res.totals.loungefly, 2);
  assert.equal(res.totals.loungeflyBase, 1);
  assert.equal(res.totals.loungeflyExcecao, 1);
  assert.equal(res.totals.semStock, 1);
  assert.equal(res.excluded.fora_ambito, 1);
  assert.equal(res.excluded.preco, 1);
  assert.equal(res.excluded.universo_errado, 1);
  assert.deepEqual(res.topExcludedVendors, [{ vendor: "CERDA", count: 1 }]);
  const db = res.perScope.find((s) => s.universe === "Dragon Ball");
  assert.equal(db.total, 2);
  assert.equal(db.apagados, 1);
  assert.equal(res.perName.find((x) => x.name === "Vegeta").candidates, 1);
  assert.equal(res.perName.find((x) => x.name === "Goku").candidates, 1);
  assert.equal(res.totals.publishSeconds, Math.round(4 * 5.3));
  const csv = buildApprovalCsv(res, SCOPES).split("\r\n");
  assert.equal(csv[0], CSV_COLUMNS.join(","));
  assert.equal(csv.filter(Boolean).length, 5);
  assert.ok(csv.some((l) => l.includes("Goku | Vegeta")));
  const md = buildApprovalSummary(res);
  assert.ok(md.includes("Nomes de risco"));
  assert.ok(md.includes("Top 20 fabricantes"));
  assert.ok(md.includes("PENDING apagados no admin incluídos nos candidatos | 1"));
  assert.ok(md.includes("Aliases do B7 fora do briefing"));
  assert.ok(!/9\.50|9,50/.test(md), "o resumo não leva custos");
});
check("aliases do B7 fora do briefing: contagem por alias e 'só por este alias'", () => {
  const vocab = { Goku: ["Kakarot"], Vegeta: ["Vegeta"] };
  const scopes = buildApprovalScopes(REAL, { vocabAliases: vocab });
  const goku = scopes.flatMap((s) => s.names).find((e) => e.name === "Goku");
  assert.equal(goku.phraseInfo.get("kakarot").via, "b7");
  assert.equal(goku.phraseInfo.get("goku").via, "lista");
  const a = row({ title: "Figure Kakarot", resolvedFranchise: "Dragon Ball" });
  const b = row({ title: "Figure Goku Kakarot", resolvedFranchise: "Dragon Ball" });
  const c = row({ title: "Figure Kakarot", resolvedFranchise: "Naruto" });
  const col = createApprovalCollector({ scopes, queueBySku: pending(a, b, c) });
  for (const x of [a, b, c]) col.addRow(x);
  const res = col.finalize();
  assert.deepEqual(res.b7Aliases, [{ scope: "Dragon Ball", name: "Goku", alias: "Kakarot", inUniverse: 2, candidates: 2, onlyVia: 1 }]);
});
check("guarda do execute: candidato sem resolvedFranchise para tudo", () => {
  assert.throws(() => assertAllHaveFranchise([{ sku: "X", resolvedFranchise: null }]), /sem resolvedFranchise/);
  assert.throws(() => assertAllHaveFranchise([{ sku: "X", resolvedFranchise: "  " }]), /sem resolvedFranchise/);
});
check("formatDuration", () => {
  assert.equal(formatDuration(5.3 * 1000), "1 h 28 min");
  assert.equal(formatDuration(90), "2 min");
});

console.log("escrita e reversão");
check("applyApproval: PENDING → APPROVED com origem; revalida; idempotente", () => {
  const fila = {
    items: [
      { sku: "A", status: "PENDING", shopifyStatus: "DRAFT", statusChangedAt: null, metadata: { origem: "regra", despublicadoEm: "x" } },
      { sku: "B", status: "REJECTED", metadata: {} },
      { sku: "C", status: "PENDING", metadata: { deletedInAdmin: { at: "2026-10-01" } } },
    ],
  };
  const r = applyApproval(fila, ["A", "B", "C", "D"], { origin: ORIGIN, now: "2026-11-04T10:00:00.000Z" });
  assert.deepEqual(r.approved, ["A", "C"]);
  assert.deepEqual(r.dropped.map((d) => d.sku), ["B", "D"]);
  assert.deepEqual(fila.items[2].metadata.deletedInAdmin, { at: "2026-10-01" }, "a marca de apagado fica");
  const a = fila.items[0];
  assert.equal(a.status, "APPROVED");
  assert.equal(a.shopifyStatus, "ACTIVE");
  assert.equal(a.metadata.approvedAt, "2026-11-04T10:00:00.000Z");
  assert.equal(a.metadata[META_ORIGIN], ORIGIN);
  assert.equal(a.metadata.origem, "humano");
  assert.ok(!("despublicadoEm" in a.metadata));
  assert.equal(fila.items[1].status, "REJECTED");
  const again = applyApproval(fila, ["A"], { origin: ORIGIN });
  assert.deepEqual(again.approved, []);
  assert.deepEqual(again.already.map((x) => x.sku), ["A"]);
});
check("revertApproval: só APPROVED desta origem volta ao estado anterior", () => {
  const fila = {
    items: [
      { sku: "A", status: "PENDING", shopifyStatus: "DRAFT", statusChangedAt: null, metadata: { origem: "regra", vendor: "FUNKO" } },
      { sku: "B", status: "PENDING", shopifyStatus: "DRAFT", metadata: {} },
      { sku: "C", status: "APPROVED", shopifyStatus: "ACTIVE", metadata: { origem: "humano", approvedAt: "2026-10-01" } },
    ],
  };
  applyApproval(fila, ["A", "B"], { origin: ORIGIN });
  fila.items[1].status = "PUBLISHED";
  fila.items[1].metadata.shopifyProductId = "gid://shopify/Product/1";
  const r = revertApproval(fila, { origin: ORIGIN });
  assert.deepEqual(r.reverted, ["A"]);
  assert.deepEqual(r.kept.map((k) => k.sku), ["B"]);
  const a = fila.items[0];
  assert.equal(a.status, "PENDING");
  assert.equal(a.shopifyStatus, "DRAFT");
  assert.ok(!("statusChangedAt" in a), "statusChangedAt volta a ausente");
  assert.deepEqual(a.metadata, { origem: "regra", vendor: "FUNKO" });
  assert.equal(fila.items[2].status, "APPROVED", "APPROVED de outra origem fica");
  assert.deepEqual(revertApproval(fila, { origin: ORIGIN }).reverted, [], "segunda corrida não faz nada");
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
