#!/usr/bin/env node
/**
 * Importação por personagem (briefing backend 09/10/2026) — T1 (ficheiro de dados) e T2
 * (seleção, CSV, aprovação). Funções puras, sem Prisma nem Shopify.
 * Uso: node scripts/tests/character-import.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { FRANCHISE_LINES } from "../../lib/importer/catalog/franchiseLines.js";
import { CHARACTER_ALIASES, PASSAGEM_B_NAMES } from "../../lib/importer/catalog/characterVocabulary.js";
import {
  normalizeForMatch,
  titleHasPhrase,
  buildScopes,
  filterDataByHandle,
  createCollector,
  evaluateRow,
  compareCandidates,
  buildCsv,
  parseApprovalCsv,
  planApproval,
  scopeHandleOf,
  buildSummaryMarkdown,
  CSV_COLUMNS,
} from "../../lib/importer/catalog/characterImportSelect.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "../catalog/character-import-2026-10-09.json"), "utf8"));

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

// ───────────────────────── T1 · ficheiro de dados ─────────────────────────

const allNames = REAL.universes.flatMap((u) => u.characters.map((c) => ({ ...c, universe: u.universe, line: u.line })));

check("T1 · 282 nomes, 116 em P1 e 166 em P2", () => {
  assert.equal(allNames.length, 282);
  assert.equal(allNames.filter((c) => c.priority === 1).length, 116);
  assert.equal(allNames.filter((c) => c.priority === 2).length, 166);
});

check("T1 · 26 universos mais 1 Line (27 linhas)", () => {
  assert.equal(REAL.universes.length, 27);
  assert.equal(new Set(REAL.universes.map((u) => u.universe)).size, 26);
  assert.equal(REAL.universes.filter((u) => u.line).length, 1);
});

check("T1 · todo o universo existe em FRANCHISE_UNIVERSES e não é dormente", () => {
  for (const u of REAL.universes) {
    const entry = FRANCHISE_UNIVERSES.find((x) => x.name === u.universe);
    assert.ok(entry, `universo "${u.universe}" não existe em FRANCHISE_UNIVERSES (grafia/NFC?)`);
    assert.ok(!entry.dormant, `universo "${u.universe}" é dormente`);
    assert.ok(entry.active, `universo "${u.universe}" não está ativo`);
  }
});

check("T1 · a Line The Mandalorian existe e o pai é Star Wars; Star Wars exclui-a", () => {
  const line = FRANCHISE_LINES.find((l) => l.line === "The Mandalorian");
  assert.ok(line);
  const row = REAL.universes.find((u) => u.line === "The Mandalorian");
  assert.equal(row.universe, line.parent);
  const sw = REAL.universes.find((u) => u.universe === "Star Wars" && !u.line);
  assert.deepEqual(sw.excludeLines, ["The Mandalorian"]);
});

check("T1 · cada âmbito resolve um handle (universo ou Line)", () => {
  for (const s of buildScopes(REAL)) assert.ok(s.handle, `sem handle: ${s.label}`);
  assert.equal(scopeHandleOf({ universo: "Star Wars", line: "The Mandalorian" }), "the-mandalorian");
  assert.equal(scopeHandleOf({ universo: "Pokémon", line: "" }), "pokemon-universe");
});

check("T1 · passagem B: exatamente os 9 nomes do briefing, e todos fazem parte dos 10 de B7", () => {
  const b = allNames.filter((c) => c.mode === "A+B").map((c) => c.name).sort();
  assert.deepEqual(b, ["Captain America", "Catwoman", "Harley Quinn", "Hulk", "Joker", "Supergirl", "Thor", "Venom", "Wolverine"]);
  for (const n of b) assert.ok(PASSAGEM_B_NAMES.includes(n), `${n} não está em PASSAGEM_B_NAMES`);
});

check("T1 · epónimos marcados: Harry, Stitch, Naruto, Superman, Batman, Spider-Man", () => {
  assert.deepEqual(allNames.filter((c) => c.eponym).map((c) => c.name).sort(), ["Batman", "Harry", "Naruto", "Spider-Man", "Stitch", "Superman"]);
});

check("T1 · amostra obrigatória nos nomes curtos/comuns do briefing", () => {
  const must = ["Max", "Will", "Mike", "Law", "Pain", "Cell", "Ace", "Rex", "Eren", "Robin", "Steve", "Power", "Bond", "Angel", "Storm", "Rogue", "Jazz", "Alien", "Unicorn", "Eleven", "Luna", "Ron", "San", "Rei", "Mari", "Aki", "Din Djarin"];
  for (const n of must) {
    const entries = allNames.filter((c) => c.name === n);
    assert.ok(entries.length > 0, `${n} não está no ficheiro`);
    assert.ok(entries.every((c) => c.sample), `${n} sem sample:true`);
  }
});

check("T1 · aliases do briefing presentes e os do vocabulário B7 juntam-se", () => {
  const scopes = buildScopes(REAL);
  const find = (universe, name, line = null) => scopes.find((s) => s.universe === universe && s.line === line).names.find((n) => n.name === name);
  assert.ok(find("Star Wars", "Leia").aliases.includes("Princess Leia"));
  assert.ok(find("The Lord of the Rings", "Nazgûl").aliases.includes("Ringwraith"));
  assert.ok(find("Evangelion", "EVA-02").aliases.includes("Unit-02"));
  assert.ok(find("Star Wars", "Din Djarin", "The Mandalorian").aliases.includes("The Mandalorian"), "alias da linha mantém-se");
  assert.ok(find("Star Wars", "Din Djarin", "The Mandalorian").aliases.includes("Mando"), "alias B7");
  assert.ok(find("Dragon Ball", "Frieza").aliases.includes("Freezer"), "alias B7 (Freezer)");
  assert.ok(find("Dragon Ball", "Frieza").aliases.includes("Freeza"), "alias do briefing");
  assert.ok(find("Spider-Man", "Spider-Man").aliases.includes("Peter Parker"), "alias B7");
  for (const [nome, aliases] of Object.entries(CHARACTER_ALIASES)) {
    for (const s of scopes) {
      const n = s.names.find((x) => x.name === nome);
      if (n) for (const a of aliases) assert.ok(n.aliases.includes(a), `${nome} perdeu o alias B7 ${a}`);
    }
  }
});

// ───────────────────────── T2 · correspondência ─────────────────────────

check("normalização: acentos, maiúsculas, pontuação e NFC/NFD", () => {
  assert.equal(normalizeForMatch("  Nazgûl-Witch_King! "), "nazgul witch king");
  assert.equal(normalizeForMatch("Nazgûl"), normalizeForMatch("Nazgûl"));
  assert.equal(normalizeForMatch("Spy × Family"), "spy family");
});

check("palavra inteira: 'Max' não bate em 'Maximus' nem 'Rex' em 'Rexy'", () => {
  assert.equal(titleHasPhrase("Stranger Things Max Mayfield figure", "Max"), true);
  assert.equal(titleHasPhrase("Gladiator Maximus figure", "Max"), false);
  assert.equal(titleHasPhrase("Toy Story Rexy plush", "Rex"), false);
  assert.equal(titleHasPhrase("Toy Story REX figure", "rex"), true);
});

check("insensível a acentos e a hífen/espaço: 'Nazgul' = 'Nazgûl'; 'Obi Wan' = 'Obi-Wan'", () => {
  assert.equal(titleHasPhrase("LOTR Nazgul on horse", "Nazgûl"), true);
  assert.equal(titleHasPhrase("Star Wars Obi Wan Kenobi", "Obi-Wan Kenobi"), true);
  assert.equal(titleHasPhrase("One Piece Monkey.D.Luffy", "Monkey D. Luffy"), true);
});

// ───────────────────────── T2 · seleção ─────────────────────────

const mk = (aliases = {}) => (data) => buildScopes(data, { vocabAliases: aliases });
let skuSeq = 0;
function row(over = {}) {
  skuSeq += 1;
  return {
    sku: String(1000000000000 + skuSeq),
    title: "x",
    cleanTitle: "x",
    vendor: "Funko",
    stock: 5,
    imageUrl: "https://img/x.jpg",
    distributorPrice: 10,
    grossPrice: 30,
    resolvedFranchise: "Batman",
    resolvedLine: null,
    resolvedFormat: "Figure",
    ...over,
  };
}
const pendingFor = (rows, extra = {}) => new Map(rows.map((r) => [r.sku, { status: "PENDING", ...(extra[r.sku] || {}) }]));
function run(data, rows, { queue, caps = {}, vocab = {} } = {}) {
  const scopes = mk(vocab)(data);
  const collector = createCollector({ scopes, queueBySku: queue || pendingFor(rows), globalMarginPct: 40, ...caps });
  rows.forEach((r) => collector.addRow(r));
  return collector.finalize();
}
const chosen = (res, name, scope) => res.rows.filter((r) => r.kind === "escolhido" && r.entry.name === name && (!scope || r.scope.label === scope)).map((r) => r.cand.sku);
const subs = (res, name) => res.rows.filter((r) => r.kind === "suplente" && r.entry.name === name).map((r) => r.cand.sku);
const ch = (name, priority = 1, extra = {}) => ({ name, priority, aliases: [], mode: "A", ...extra });
const DATA = {
  id: "t",
  universes: [
    { universe: "Batman", line: null, excludeLines: [], characters: [ch("Batman", 1, { eponym: true }), ch("Joker", 1, { mode: "A+B" }), ch("Robin", 2, { sample: true })] },
    { universe: "Star Wars", line: null, excludeLines: ["The Mandalorian"], characters: [ch("Darth Vader"), ch("Boba Fett", 2)] },
    { universe: "Star Wars", line: "The Mandalorian", excludeLines: [], characters: [ch("Grogu"), ch("Boba Fett", 2)] },
    { universe: "Stranger Things", line: null, excludeLines: [], characters: [ch("Robin", 2)] },
  ],
};

check("universo errado: 'Robin' só conta em Batman, nunca em TMNT/outro universo", () => {
  const a = row({ cleanTitle: "Batman Robin figure" });
  const b = row({ cleanTitle: "Robin Hood figure", resolvedFranchise: "TMNT" });
  const res = run(DATA, [a, b]);
  assert.deepEqual(chosen(res, "Robin", "Batman"), [a.sku]);
  assert.equal(res.rows.some((r) => r.cand.sku === b.sku), false);
});

check("Robin em Batman e em Stranger Things: cada universo só vê os seus", () => {
  const bat = row({ cleanTitle: "Batman Robin figure" });
  const st = row({ cleanTitle: "Stranger Things Robin figure", resolvedFranchise: "Stranger Things" });
  const res = run(DATA, [bat, st]);
  assert.deepEqual(chosen(res, "Robin", "Batman"), [bat.sku]);
  assert.deepEqual(chosen(res, "Robin", "Stranger Things"), [st.sku]);
});

check("Line: Mandalorian exige resolvedLine; Star Wars exclui a Line", () => {
  const mando = row({ cleanTitle: "Star Wars Grogu plush", resolvedFranchise: "Star Wars", resolvedLine: "The Mandalorian" });
  const boba1 = row({ cleanTitle: "Star Wars Boba Fett figure", resolvedFranchise: "Star Wars", resolvedLine: null });
  const boba2 = row({ cleanTitle: "Star Wars Boba Fett Mandalorian figure", resolvedFranchise: "Star Wars", resolvedLine: "The Mandalorian" });
  const res = run(DATA, [mando, boba1, boba2]);
  assert.deepEqual(chosen(res, "Boba Fett", "Star Wars"), [boba1.sku], "Star Wars sem a Line");
  assert.deepEqual(chosen(res, "Boba Fett", "Star Wars / The Mandalorian"), [boba2.sku], "Mandalorian só com a Line");
  assert.deepEqual(chosen(res, "Grogu", "Star Wars / The Mandalorian"), [mando.sku]);
});

check("teto: P1 = 2, P2 = 1 por omissão; flags mudam o teto", () => {
  const vader = [1, 2, 3, 4].map((i) => row({ cleanTitle: `Star Wars Darth Vader ${i}`, resolvedFranchise: "Star Wars", stock: i }));
  const boba = [1, 2, 3].map((i) => row({ cleanTitle: `Star Wars Boba Fett ${i}`, resolvedFranchise: "Star Wars", stock: i }));
  const res = run(DATA, [...vader, ...boba]);
  assert.equal(chosen(res, "Darth Vader").length, 2);
  assert.equal(chosen(res, "Boba Fett", "Star Wars").length, 1);
  const res3 = run(DATA, [...vader, ...boba], { caps: { capP1: 3, capP2: 2 } });
  assert.equal(chosen(res3, "Darth Vader").length, 3);
  assert.equal(chosen(res3, "Boba Fett", "Star Wars").length, 2);
});

check("teto 0 = sem teto; finalize com e sem teto sobre o mesmo estado dá resultados independentes", () => {
  const vader = [1, 2, 3, 4, 5].map((i) => row({ cleanTitle: `Star Wars Darth Vader ${i}`, resolvedFranchise: "Star Wars", stock: i, resolvedFormat: `F${i}` }));
  const scopes = mk({})(DATA);
  const col = createCollector({ scopes, queueBySku: pendingFor(vader), globalMarginPct: 40 });
  vader.forEach((r) => col.addRow(r));
  const capped = col.finalize({ capP1: 2, capP2: 1 });
  const free = col.finalize({ capP1: 0, capP2: 0 });
  const again = col.finalize({ capP1: 2, capP2: 1 });
  const n = (res) => res.rows.filter((r) => r.kind === "escolhido" && r.entry.name === "Darth Vader").length;
  assert.equal(n(capped), 2);
  assert.equal(n(free), 5);
  assert.deepEqual(again.rows.map((r) => r.cand.sku), capped.rows.map((r) => r.cand.sku));
  assert.equal(free.perName.find((x) => x.name === "Darth Vader").suplentes, 0, "sem teto não há suplentes");
  const md = buildSummaryMarkdown(capped, { uncapped: free });
  assert.match(md, /Escolhidos com teto \| Escolhidos sem teto/);
  assert.match(md, /## Passagem B/);
});

check("suplentes: até 3 abaixo do teto, sem repetir os escolhidos", () => {
  const vader = [1, 2, 3, 4, 5, 6, 7].map((i) => row({ cleanTitle: `Star Wars Darth Vader ${i}`, resolvedFranchise: "Star Wars", stock: i }));
  const res = run(DATA, vader);
  const c = chosen(res, "Darth Vader");
  const s = subs(res, "Darth Vader");
  assert.equal(c.length, 2);
  assert.equal(s.length, 3);
  assert.equal(new Set([...c, ...s]).size, 5);
});

check("unicidade: um SKU com dois nomes é escolhido uma só vez, no nome P1 antes do P2", () => {
  const both = row({ cleanTitle: "Star Wars Darth Vader and Boba Fett set", resolvedFranchise: "Star Wars" });
  const onlyBoba = row({ cleanTitle: "Star Wars Boba Fett figure", resolvedFranchise: "Star Wars", stock: 1 });
  const res = run(DATA, [both, onlyBoba]);
  assert.deepEqual(chosen(res, "Darth Vader"), [both.sku], "fica no P1");
  assert.deepEqual(chosen(res, "Boba Fett", "Star Wars"), [onlyBoba.sku], "o P2 passa ao seguinte");
  const all = res.rows.filter((r) => r.kind === "escolhido").map((r) => r.cand.sku);
  assert.equal(new Set(all).size, all.length);
});

check("desempate: COLLECTOR antes de CORE, depois maior stock, depois SKU", () => {
  const core = row({ cleanTitle: "Star Wars Darth Vader core", resolvedFranchise: "Star Wars", vendor: "Funko", stock: 99 });
  const collector = row({ cleanTitle: "Star Wars Darth Vader collector", resolvedFranchise: "Star Wars", vendor: "Good Smile Company", stock: 1, resolvedFormat: "Statue" });
  const res = run(DATA, [core, collector], { caps: { capP1: 1 } });
  assert.deepEqual(chosen(res, "Darth Vader"), [collector.sku]);
  const a = { source: "A", tier: "CORE", stock: 5, sku: "2" };
  const b = { source: "A", tier: "CORE", stock: 5, sku: "1" };
  const c = { source: "A", tier: "CORE", stock: 9, sku: "3" };
  assert.deepEqual([a, b, c].sort(compareCandidates).map((x) => x.sku), ["3", "1", "2"]);
});

check("variedade: os 2 lugares de P1 preferem formatos diferentes", () => {
  const f1 = row({ cleanTitle: "Star Wars Darth Vader fig A", resolvedFranchise: "Star Wars", stock: 50, resolvedFormat: "Figure" });
  const f2 = row({ cleanTitle: "Star Wars Darth Vader fig B", resolvedFranchise: "Star Wars", stock: 40, resolvedFormat: "Figure" });
  const p = row({ cleanTitle: "Star Wars Darth Vader plush", resolvedFranchise: "Star Wars", stock: 1, resolvedFormat: "Plush" });
  const res = run(DATA, [f1, f2, p]);
  assert.deepEqual(chosen(res, "Darth Vader").sort(), [f1.sku, p.sku].sort());
  // sem alternativa de formato, preenche com o seguinte do ranking
  const res2 = run(DATA, [f1, f2]);
  assert.equal(chosen(res2, "Darth Vader").length, 2);
});

check("já publicados contam para o teto do personagem", () => {
  const pub = row({ cleanTitle: "Star Wars Darth Vader published", resolvedFranchise: "Star Wars" });
  const pend = [1, 2, 3].map((i) => row({ cleanTitle: `Star Wars Darth Vader ${i}`, resolvedFranchise: "Star Wars", stock: i, resolvedFormat: `F${i}` }));
  const queue = pendingFor(pend);
  queue.set(pub.sku, { status: "PUBLISHED" });
  const res = run(DATA, [pub, ...pend], { queue });
  assert.equal(chosen(res, "Darth Vader").length, 1, "2 de teto − 1 publicado");
  const full = row({ cleanTitle: "Star Wars Darth Vader published 2", resolvedFranchise: "Star Wars" });
  queue.set(full.sku, { status: "APPROVED" });
  const res2 = run(DATA, [pub, full, ...pend], { queue });
  assert.equal(chosen(res2, "Darth Vader").length, 0, "teto cheio: 1 publicado + 1 aprovado");
  assert.match(res2.perName.find((n) => n.name === "Darth Vader").zero, /teto cheio/);
});

check("epónimo: só produtos que não batem noutro nome do universo", () => {
  const generic = row({ cleanTitle: "Batman Gotham skyline statue" });
  const withJoker = row({ cleanTitle: "Batman vs Joker statue" });
  const res = run(DATA, [generic, withJoker]);
  assert.deepEqual(chosen(res, "Batman"), [generic.sku]);
  assert.deepEqual(chosen(res, "Joker"), [withJoker.sku]);
  const batman = res.perName.find((n) => n.name === "Batman");
  assert.equal(batman.dentro, 2);
  assert.equal(batman.candidatos, 1);
});

check("passagem B: órfão só entra nos nomes A+B, depois dos candidatos A, e fica sem 'sim'", () => {
  const orphanJoker = row({ cleanTitle: "Joker laughing figure", resolvedFranchise: null });
  const orphanRobin = row({ cleanTitle: "Robin figure", resolvedFranchise: null });
  const res = run(DATA, [orphanJoker, orphanRobin]);
  assert.deepEqual(chosen(res, "Joker"), [orphanJoker.sku]);
  assert.deepEqual(chosen(res, "Robin", "Batman"), [], "Robin é só passagem A");
  const a = row({ cleanTitle: "Batman Joker A" });
  const b = row({ cleanTitle: "Batman Joker B", resolvedFormat: "Statue" });
  const res2 = run(DATA, [orphanJoker, a, b]);
  assert.deepEqual(chosen(res2, "Joker").sort(), [a.sku, b.sku].sort(), "A tem prioridade sobre B");
  const csv = buildCsv(res.rows);
  const parsed = parseApprovalCsv(csv);
  assert.equal(parsed.find((r) => r.sku === orphanJoker.sku).aprovar, "");
  assert.match(csv, /órfão \(passagem B\)/);
});

check("filtros mínimos: stock, imagem, custo, preço, fabricante e estado da fila", () => {
  const base = { cleanTitle: "Star Wars Darth Vader x", resolvedFranchise: "Star Wars" };
  const ok = row(base);
  const noStock = row({ ...base, stock: 0 });
  const noImg = row({ ...base, imageUrl: "" });
  const noCost = row({ ...base, distributorPrice: null });
  const hotToys = row({ ...base, vendor: "Hot Toys" });
  const unknownVendor = row({ ...base, vendor: "Marca Qualquer" });
  const rejected = row(base);
  const queue = pendingFor([ok, noStock, noImg, noCost, hotToys, unknownVendor]);
  queue.set(rejected.sku, { status: "REJECTED" });
  const res = run(DATA, [ok, noStock, noImg, noCost, hotToys, unknownVendor, rejected], { queue });
  assert.deepEqual(res.rows.filter((r) => r.kind === "escolhido").map((r) => r.cand.sku), [ok.sku]);
  const reasons = res.perName.find((n) => n.name === "Darth Vader").reasons;
  assert.equal(reasons.sem_stock, 1);
  assert.equal(reasons.sem_imagem, 1);
  assert.equal(reasons.sem_custo, 1);
  assert.equal(reasons.fora_coleccionaveis, 2, "ARTISAN/SIGNATURE e sem tier ficam fora");
  assert.equal(reasons.estado_rejected, 1);
});

check("evaluateRow: ordem fixa dos motivos e preço da regra (margem do produto vence a global)", () => {
  const r = row({ grossPrice: 20 }); // PVPR 20: o piso (80 %) e o teto não mexem na margem de 40 %
  const q = new Map([[r.sku, { status: "PENDING" }]]);
  const ev = evaluateRow(r, { queueBySku: q, globalMarginPct: 40 });
  assert.equal(ev.reason, null);
  assert.equal(ev.cost, 12.1); // 10 × 1,21
  assert.equal(ev.calcPrice, 17.5); // 12,10 × 1,40 = 16,94 → ,50
  assert.equal(ev.priceStatus, "MARGEM");
  const q2 = new Map([[r.sku, { status: "PENDING", queueItem: { metadata: { overrides: { marginPct: 100 } } } }]]);
  assert.ok(evaluateRow(r, { queueBySku: q2, globalMarginPct: 40 }).calcPrice > ev.calcPrice);
  assert.equal(evaluateRow(row(), { queueBySku: new Map(), globalMarginPct: 40 }).reason, "fora_da_fila");
});

check("idempotência: a mesma entrada dá a mesma seleção, qualquer que seja a ordem das linhas", () => {
  const rows = [1, 2, 3, 4, 5, 6].map((i) => row({ cleanTitle: `Star Wars Darth Vader ${i}`, resolvedFranchise: "Star Wars", stock: i % 3, resolvedFormat: i % 2 ? "A" : "B" }));
  const a = run(DATA, rows);
  const b = run(DATA, rows.slice().reverse());
  const pick = (res) => res.rows.map((r) => `${r.kind}:${r.cand.sku}`);
  assert.deepEqual(pick(a), pick(b));
});

check("filterDataByHandle limita a um âmbito e mantém os índices consecutivos", () => {
  const sub = filterDataByHandle(REAL, "dragon-ball");
  assert.equal(sub.universes.length, 1);
  assert.equal(buildScopes(sub)[0].index, 0);
  assert.equal(filterDataByHandle(REAL, "the-mandalorian").universes[0].line, "The Mandalorian");
  assert.equal(filterDataByHandle(REAL, "star-wars").universes.length, 1, "star-wars não inclui a Line");
});

// ───────────────────────── T2 · CSV e aprovação ─────────────────────────

check("CSV: cabeçalho do briefing, escolhidos com 'sim', suplentes vazios, aspas escapadas", () => {
  const vader = [1, 2, 3, 4, 5].map((i) => row({ cleanTitle: `Star Wars "Darth Vader", ed. ${i}`, resolvedFranchise: "Star Wars", stock: i, resolvedFormat: `F${i}` }));
  const res = run(DATA, vader);
  const csv = buildCsv(res.rows, { warningsBySku: new Map([[vader[0].sku, ["MISSING_FORMAT", "VENDOR_UNMAPPED"]]]) });
  const header = csv.split("\r\n")[0];
  assert.equal(header, CSV_COLUMNS.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(","));
  const parsed = parseApprovalCsv(csv);
  assert.equal(parsed.filter((r) => r.aprovar === "sim").length, 2);
  assert.equal(parsed.filter((r) => r.aprovar === "").length, 3);
  assert.ok(parsed.every((r) => r.universo === "Star Wars" && r.personagem === "Darth Vader"));
  assert.ok(parsed.every((r) => r.price > 0));
  assert.match(csv, /MISSING_FORMAT VENDOR_UNMAPPED/);
  assert.ok(header.includes("custo_sem_iva,custo_com_iva_es"));
  const first = parseApprovalCsv(csv)[0];
  assert.ok(first.sku);
});

check("parseApprovalCsv aceita cabeçalhos sem acento/maiúsculas e recusa CSV sem SKU/aprovar", () => {
  const rows = parseApprovalCsv("universo,line,sku,preco final,APROVAR\r\nBatman,,1,16.9,Sim\r\n");
  assert.deepEqual(rows.map((r) => [r.sku, r.aprovar, r.price]), [["1", "sim", 16.9]]);
  assert.throws(() => parseApprovalCsv("universo,sku\r\nBatman,1\r\n"), /aprovar/);
  assert.throws(() => parseApprovalCsv("universo,aprovar\r\nBatman,sim\r\n"), /SKU/);
});

const cur = (over = {}) => ({ status: "PENDING", stock: 3, imageUrl: "u", distributorPrice: 10, inCatalog: true, ...over });
const csvRows = [
  { sku: "1", aprovar: "sim", universo: "Dragon Ball", line: "", personagem: "Goku", price: 1 },
  { sku: "2", aprovar: "sim", universo: "Dragon Ball", line: "", personagem: "Goku", price: 1 },
  { sku: "3", aprovar: "", universo: "Dragon Ball", line: "", personagem: "Goku", price: 1 },
  { sku: "4", aprovar: "sim", universo: "Batman", line: "", personagem: "Joker", price: 1 },
  { sku: "5", aprovar: "sim", universo: "Dragon Ball", line: "", personagem: "Vegeta", price: 1 },
  { sku: "5", aprovar: "sim", universo: "Dragon Ball", line: "", personagem: "Vegeta", price: 1 },
  { sku: "6", aprovar: "sim", universo: "Dragon Ball", line: "", personagem: "Vegeta", price: 1 },
];

check("--execute: só as linhas 'sim'; revalida PENDING e stock e reporta os que caíram", () => {
  const current = new Map([
    ["1", cur()],
    ["2", cur({ stock: 0 })],
    ["4", cur()],
    ["5", cur({ status: "REJECTED" })],
    ["6", cur({ status: "PUBLISHED" })],
  ]);
  const plan = planApproval(csvRows, current);
  assert.deepEqual(plan.toApprove, ["1", "4"]);
  assert.deepEqual(plan.alreadyDone, [{ sku: "6", status: "PUBLISHED" }]);
  assert.deepEqual(plan.dropped.map((d) => d.sku).sort(), ["2", "5"]);
  assert.match(plan.dropped.find((d) => d.sku === "2").reason, /stock/);
  assert.match(plan.dropped.find((d) => d.sku === "5").reason, /REJECTED/);
  assert.equal(plan.notMarked, 1);
});

check("--execute --only-universe: só o âmbito pedido", () => {
  const current = new Map(csvRows.map((r) => [r.sku, cur()]));
  const plan = planApproval(csvRows, current, { onlyHandle: "dragon-ball" });
  assert.deepEqual(plan.toApprove, ["1", "2", "5", "6"]);
  assert.equal(plan.outOfScope, 1);
});

check("--execute é idempotente: depois de aprovar, a segunda corrida não gera alterações", () => {
  const current = new Map(csvRows.map((r) => [r.sku, cur()]));
  const first = planApproval(csvRows, current);
  assert.ok(first.toApprove.length > 0);
  for (const sku of first.toApprove) current.set(sku, cur({ status: "APPROVED" }));
  const second = planApproval(csvRows, current);
  assert.equal(second.toApprove.length, 0);
  assert.equal(second.alreadyDone.length, first.toApprove.length);
  assert.equal(second.dropped.length, 0);
});

check("SKU que saiu do catálogo ou da fila cai com motivo legível", () => {
  const plan = planApproval(
    [{ sku: "9", aprovar: "sim", universo: "Batman", line: "" }, { sku: "8", aprovar: "sim", universo: "Batman", line: "" }],
    new Map([["8", cur({ inCatalog: false })]])
  );
  assert.deepEqual(plan.toApprove, []);
  assert.match(plan.dropped.find((d) => d.sku === "9").reason, /fila/);
  assert.match(plan.dropped.find((d) => d.sku === "8").reason, /catálogo/);
});

check("resumo: por universo, por nome, zero candidatos e amostras", () => {
  const res = run(DATA, [row({ cleanTitle: "Batman Robin figure" })]);
  const md = buildSummaryMarkdown(res, { collectionStates: new Map([["batman", "Online Store: publicada"]]) });
  assert.match(md, /## Por universo/);
  assert.match(md, /Online Store: publicada/);
  assert.match(md, /## Nomes sem candidatos/);
  assert.match(md, /sem correspondência/);
  assert.match(md, /### Robin — Batman/);
});

check("amostras obrigatórias: até 5 títulos, também quando só há correspondências filtradas", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => row({ cleanTitle: `Batman Robin ${i}`, stock: 0 }));
  const res = run(DATA, rows);
  const robin = res.perName.find((n) => n.name === "Robin" && n.scope === "Batman");
  assert.equal(robin.escolhidos, 0);
  assert.equal(robin.samples.length, 5);
  assert.ok(robin.samples.every((s) => s.label === "sem stock"));
  assert.match(robin.zero, /sem stock: 8/);
});

console.log(failures ? `\n${failures} falha(s)` : `\ncharacter-import: todos os testes passaram`);
process.exit(failures ? 1 : 0);
