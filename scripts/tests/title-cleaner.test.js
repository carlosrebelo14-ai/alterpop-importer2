#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 10 — titleCleaner.server.js.
 * Uso: node scripts/tests/title-cleaner.test.js
 */
import assert from "node:assert/strict";
import {
  cleanProductTitle,
  cleanProductTitleWithTrace,
  resolveTitleCollisions,
} from "../../lib/importer/catalog/titleCleaner.server.js";

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

check("remove prefixo de formato conhecido (Tarefa 32/Decisão 17: só Assorted/Latino)", () => {
  assert.equal(
    cleanProductTitle({ title: "Assorted Darth Vader", resolvedFranchise: null }),
    "Darth Vader"
  );
  // "POP figure" saiu da lista de propósito — fica intacto.
  assert.equal(
    cleanProductTitle({ title: "POP figure Darth Vader", resolvedFranchise: null }),
    "POP figure Darth Vader"
  );
});

check("averbamento à Decisão 17 · guarda — prefixo de formato só sai com resolvedFormat", () => {
  // Com formato resolvido: o prefixo sai porque a informação passou a viver em
  // alterpop.format. Move-se de sítio, não se perde.
  assert.equal(
    cleanProductTitle({ title: "POP figure Darth Vader", resolvedFranchise: null, resolvedFormat: "Figure" }),
    "Darth Vader"
  );
  // Briefing 15/09/2026 · B0 — o travão do mínimo agora bloqueia a string inteira
  // igual a um alias, não só a palavra isolada genérica. "Batman" sozinho colapsava
  // para o nome da franquia (caso A do B0); fica intacto.
  assert.equal(
    cleanProductTitle({ title: "Pocket POP Keychain Batman", resolvedFranchise: "Batman", resolvedFormat: "Keychain" }),
    "Pocket POP Keychain Batman"
  );
  // Sem formato resolvido: fica intacto. Remover aqui destruía a única cópia da
  // informação, que é exatamente o que a guarda existe para impedir.
  assert.equal(
    cleanProductTitle({ title: "POP figure Darth Vader", resolvedFranchise: null, resolvedFormat: null }),
    "POP figure Darth Vader"
  );
  // ...e isso fica registado, para o relatório os poder contar à parte.
  const travado = cleanProductTitleWithTrace({ title: "POP figure Darth Vader", resolvedFormat: null });
  assert.ok(travado.firedRules.includes("prefixo-formato-travado"));
});

check("prefixos empilhados · itera até três passagens", () => {
  // Briefing 15/09/2026 · B0, revisão — o travão avalia o CLEANTITLE FINAL (travão 3),
  // não o candidato a meio do laço. As duas passagens ("Assorted", depois "Blister 4
  // figures Bitty POP") deixam "Demon Slayer" sozinho — igual ao nome da franquia — só
  // depois de o laço acabar; o travão 2 (por passagem) nunca vê isso, porque "Blister 4
  // figures Bitty POP Demon Slayer" já tem 2+ palavras. O travão 3 apanha no fim e
  // reverte o strip por inteiro (não só a última passagem).
  const r = cleanProductTitleWithTrace({
    title: "Assorted Blister 4 figures Bitty POP Demon Slayer",
    resolvedFranchise: "Demon Slayer",
    resolvedFormat: "Figure",
  });
  assert.equal(r.result, "Assorted Blister 4 figures Bitty POP Demon Slayer");
  assert.equal(r.prefixoPassagens, 0, "o travão 3 reverte o strip por inteiro, não só a última passagem");
  assert.ok(r.prefixoTravaoMinimo, "tinha de ser travado — o final colapsava para o nome da franquia");
  assert.ok(r.firedRules.includes("prefixo-formato-travado-final"));
});

check("prefixos empilhados · travão 1 — nunca mais de três passagens", () => {
  const r = cleanProductTitleWithTrace({
    title: "Assorted Deluxe Set Loungefly POP figure Batman",
    resolvedFranchise: "Batman",
    resolvedFormat: "Figure",
  });
  assert.equal(r.prefixoPassagens, 3, "pára às três, mesmo com mais prefixo pela frente");
  assert.ok(r.result.startsWith("Loungefly"), `sobrou: ${r.result}`);
});

check("prefixos empilhados · travão 2 — não colapsa para palavra genérica isolada", () => {
  // Sem franquia resolvida, "Microscope" isolado não é alias de nada: a passagem que o
  // deixaria sozinho não se faz, e o título fica como está.
  const r = cleanProductTitleWithTrace({
    title: "Deluxe Microscope",
    resolvedFranchise: null,
    resolvedFormat: "Figure",
  });
  assert.equal(r.result, "Deluxe Microscope");
  assert.equal(r.prefixoPassagens, 0);
  assert.ok(r.prefixoTravaoMinimo, "o travão do mínimo tem de ficar registado");
  // E nunca para vazio, nem quando o título é só o prefixo.
  assert.equal(
    cleanProductTitle({ title: "Assorted", resolvedFranchise: null, resolvedFormat: null }),
    "Assorted"
  );
});

check("averbamento à Decisão 17 · Assorted/Latino saem sem guarda (ruído, não formato)", () => {
  // A guarda protege informação. Estes dois nunca foram informação — a própria Decisão 17
  // os classificou como ruído — por isso saem mesmo sem resolvedFormat.
  assert.equal(
    cleanProductTitle({ title: "Assorted Darth Vader", resolvedFranchise: null, resolvedFormat: null }),
    "Darth Vader"
  );
  assert.equal(
    cleanProductTitle({ title: "Latino Pokemon Mega-Charizard X", resolvedFranchise: null, resolvedFormat: null }),
    "Pokemon Mega-Charizard X"
  );
});

check("B18 item 5 · caso real — 'Rides' sai mesmo com resolvedFormat preenchido (SKU 889698744041)", () => {
  // Bug encontrado na auditoria live de 17/09/2026: quando resolvedFormat estava
  // preenchido, o laço só tentava FORMAT_PREFIXES — "POP figure" saía na 1.ª passagem,
  // mas "Rides" (só em NOISE_PREFIXES) já não saía na 2.ª, e o título ficava com o
  // resíduo. NOISE_PREFIXES tem de se tentar em toda passagem, independente da guarda.
  assert.equal(
    cleanProductTitle({
      title: "POP figure Rides Star Wars Luke Skywalker in T-47 Airspeeder Exclusive",
      resolvedFranchise: "Star Wars",
      resolvedFormat: "Figure",
    }),
    "Star Wars Luke Skywalker in T-47 Airspeeder Exclusive"
  );
});

check("remove preço/moeda embutido", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Darth Vader figure 12,99€", resolvedFranchise: "Star Wars" }),
    "Star Wars Darth Vader figure"
  );
  assert.equal(
    cleanProductTitle({ title: "Batman mug $19.99 clearance", resolvedFranchise: "Batman" }),
    "Batman mug clearance"
  );
});

check("colapsa franquia repetida, mantém a 1.ª ocorrência", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Grogu Star Wars figure", resolvedFranchise: "Star Wars" }),
    "Star Wars Grogu figure"
  );
});

check("sem franquia resolvida: não mexe em repetições", () => {
  assert.equal(
    cleanProductTitle({ title: "Funko Funko Pop assorted", resolvedFranchise: null }),
    "Funko Funko Pop assorted"
  );
});

check("normaliza espaços e pontuação órfã nas pontas", () => {
  assert.equal(
    cleanProductTitle({ title: "  - Frozen   Elsa doll -  ", resolvedFranchise: "Frozen" }),
    "Frozen Elsa doll"
  );
});

check("título sem alterações fica igual (idempotente)", () => {
  const t = "Harry Potter Hedwig plush 25cm";
  assert.equal(cleanProductTitle({ title: t, resolvedFranchise: "Harry Potter" }), t);
});

check("título vazio não rebenta", () => {
  assert.equal(cleanProductTitle({ title: "", resolvedFranchise: null }), "");
  assert.equal(cleanProductTitle({}), "");
});

// ── Decisão 8 — portão dirigido: 5 casos obrigatórios (títulos reais da loja) ──────

check("Decisão 8 · caso 1 — prefixo de fornecedor (Latino)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Latino Pokemon Mega-Charizard X Ultra Premium collectible cards case",
      resolvedFranchise: "Pokémon",
    }),
    "Pokemon Mega-Charizard X Ultra Premium collectible cards case"
  );
});

check("Decisão 8 · caso 2 — marca contraditória com a ref", () => {
  assert.equal(
    cleanProductTitle({
      title: "Transformers Star Wars The Mandalorian N-1 Starfighter figure 19cm",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "Star Wars The Mandalorian N-1 Starfighter figure 19cm"
  );
});

check("Decisão 8 · caso 3 — franquia repetida (segmento ' - X' redundante)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Star Wars The Mandalorian & Grogu - The Mandalorian & Grogu Deluxe figure 9,5cm",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "Star Wars The Mandalorian & Grogu Deluxe figure 9,5cm"
  );
});

check("Decisão 8 · caso 4 — preço e unidade", () => {
  assert.equal(
    cleanProductTitle({ title: "Batman offer pack 3.50€ x unit", resolvedFranchise: "Batman" }),
    "Batman offer pack"
  );
});

check("Decisão 8 · caso 5 — repetição interna (alias bare 'Mandalorian')", () => {
  // Tarefa 32/Decisão 17: "POP figure" saiu de FORMAT_PREFIXES, fica no título — o
  // caso continua a "mudar" (é isso que o portão exige), só que agora só via
  // alias-repetido, não mais via prefixo-formato.
  assert.equal(
    cleanProductTitle({
      title: "POP figure Rides Deluxe Star Wars Mandalorian 9 the Mandalorian in N-1 Starfighter",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "POP figure Rides Deluxe Star Wars Mandalorian 9 in N-1 Starfighter"
  );
});

// ── Tarefa 20 — aperto do dash-repetido (achado real da amostra de 2000, Tarefa 10b) ──

check("Tarefa 20 · dash-repetido: overlap de 1 palavra colapsa quando É a franquia (Gundam)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Mobile Suit Gundam - Gundam Ashtaron HG 1/144 model kit",
      resolvedFranchise: "Gundam",
    }),
    "Mobile Suit Gundam Ashtaron HG 1/144 model kit"
  );
});

check("Tarefa 20 · dash-repetido: overlap de 1 palavra genérica NÃO colapsa (falso positivo real: 'Racing')", () => {
  const t = "Carrera GO!!! Ferrari Power Racing - Racing circuit";
  assert.equal(cleanProductTitle({ title: t, resolvedFranchise: null }), t);
});

check("B0 · travão 3 — colapso vindo do dash-repetido, não do laço do prefixo", () => {
  // O caso exato do PR #68: o laço do prefixo passa (candidato "Wednesday - Wednesday"
  // tem 2+ "palavras", travão 2 não trava); só o dash-repetido, a correr DEPOIS, colapsa
  // para "Wednesday". Sem este averbamento o dash-repetido colapsaria para "Pocket POP
  // Keychain Wednesday" (aceitável); com o strip, colapsa para "Wednesday" (não). O
  // travão 3 reverte o strip e deixa o dash-repetido colapsar sobre o título completo.
  const r = cleanProductTitleWithTrace({
    title: "Pocket POP Keychain Wednesday - Wednesday",
    resolvedFranchise: "Wednesday",
    resolvedFormat: "Keychain",
  });
  assert.equal(r.result, "Pocket POP Keychain Wednesday");
  assert.equal(r.prefixoPassagens, 0);
  assert.ok(r.prefixoTravaoMinimo);
  assert.ok(r.firedRules.includes("prefixo-formato-travado-final"));
  assert.ok(r.firedRules.includes("dash-repetido"), "o dash-repetido tem de correr na mesma, sobre o título revertido");
});

check("B0 · resolveTitleCollisions reverte AMBOS os membros quando dois formatos colidem", () => {
  const rows = [
    { key: "a", title: "POP figure DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Figure" },
    { key: "b", title: "Blister 4 figures Bitty POP DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Figure" },
    { key: "c", title: "Pocket POP Keychain DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Keychain" },
  ];
  const out = resolveTitleCollisions(rows);
  const byKey = Object.fromEntries(out.map((o) => [o.key, o]));
  assert.equal(byKey.a.result, "POP figure DC Comics Batman");
  assert.equal(byKey.b.result, "Blister 4 figures Bitty POP DC Comics Batman");
  assert.equal(byKey.c.result, "Pocket POP Keychain DC Comics Batman");
  assert.ok(byKey.a.colisaoRevertida && byKey.b.colisaoRevertida && byKey.c.colisaoRevertida);
  assert.equal(byKey.a.prefixoPassagens, 0);
});

check("B0 · resolveTitleCollisions não mexe quando não há colisão", () => {
  const rows = [
    { key: "a", title: "POP figure DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Figure" },
    { key: "b", title: "POP figure Marvel Spider-Man", resolvedFranchise: "Spider-Man", resolvedFormat: "Figure" },
  ];
  const out = resolveTitleCollisions(rows);
  const byKey = Object.fromEntries(out.map((o) => [o.key, o]));
  assert.equal(byKey.a.result, "DC Comics Batman");
  assert.equal(byKey.b.result, "Marvel Spider-Man");
  assert.equal(byKey.a.colisaoRevertida, false);
  assert.equal(byKey.a.prefixoPassagens, 1);
});

check("B0 · resolveTitleCollisions é independente da ordem de entrada (simétrico)", () => {
  const rows = [
    { key: "a", title: "POP figure DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Figure" },
    { key: "b", title: "Blister 4 figures Bitty POP DC Comics Batman", resolvedFranchise: "Batman", resolvedFormat: "Figure" },
  ];
  const forward = resolveTitleCollisions(rows);
  const backward = resolveTitleCollisions([...rows].reverse());
  const normalize = (list) => Object.fromEntries(list.map((o) => [o.key, o.result]));
  assert.deepEqual(normalize(forward), normalize(backward));
});

check("B0 · duplicados pré-existentes (sem prefixo mexido) não são revertidos, ficam fora do invariante", () => {
  const rows = [
    { key: "a", title: "One Piece Monkey D. Luffy adult t-shirt", resolvedFranchise: "One Piece", resolvedFormat: null },
    { key: "b", title: "One Piece Monkey D. Luffy adult t-shirt", resolvedFranchise: "One Piece", resolvedFormat: null },
  ];
  const out = resolveTitleCollisions(rows);
  // Colidem (mesmo cleanTitle) mas nenhum tinha prefixo para reverter — o invariante
  // do B0 é sobre o strip desta averbamento, não sobre duplicados alheios a ele.
  assert.equal(out[0].result, "One Piece Monkey D. Luffy adult t-shirt");
  assert.equal(out[1].result, "One Piece Monkey D. Luffy adult t-shirt");
  assert.ok(out[0].colisaoRevertida && out[1].colisaoRevertida, "o grupo colide na mesma, mas reverter não muda nada aqui");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ntitle-cleaner: todos os casos passaram");
