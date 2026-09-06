# Plano de implementação — normalização de franquias

**Repo:** `carlosrebelo14-ai/alterpop-importer2`
**Spec de origem:** `docs/normalizacao-franquias.md` + `docs/contexto-tema-novo.md` (no repo do tema)
**Estado:** branch `feat/franchise-normalization` — Fases 1–3 implementadas, à espera do PORTÃO A.

### Progresso

- [x] **Fase 1** — `parseFamilySignals()` separa `franchiseRefs` de `categoryTokens`;
      `csvFieldMap` expõe `record.franchiseRefs`; `parseFranchiseRefs` mantido como wrapper;
      guarda em `translate.js`. Teste: `scripts/tests/parse-family-signals.test.js`.
- [x] **Fase 2** — `lib/importer/catalog/franchiseUniverses.js`: tabela dos 40 (30 ativos /
      10 dormentes), `FRANCHISE_PRECEDENCE`, constantes de limiar/template.
- [x] **Fase 3** — `lib/importer/catalog/franchiseResolver.server.js` (3 camadas, puro) +
      `scripts/catalog/franchise-resolve-report.js` (REPORT MODE, zero escrita) +
      `scripts/tests/franchise-resolver.test.js`. `npm run franchise:report`.
- [x] **PORTÃO A** — passagem real `--from-csv` a 2026-09-06 (feed de pé, 29 430 produtos)
      + revisão do Carlos (6 passos). Ver **§A**. Resultado: tabela boa; ajustes feitos
      (Ghibli, refs mortas, +#41 Lord of the Rings). Falta re-baselinar `estRange` (1º
      passo da Fase 4) e o Carlos confirmar o handle da LOTR. Nada bloqueia as Fases 4–6.
- [x] **Fase 4** — `spidey` no Spider-Man; re-baseline `estRange` → `baseline` (semântica
      nova: resolvidos na última passagem completa / 29 430; 36 ativos / 5 dormentes);
      migração `20260906180000_franchise_resolution` (+`franchiseRefs`, `+resolvedFranchise`,
      `+resolvedFranchiseLayer`, índice); `toLiteProduct()` chama `resolveFranchise()` e os
      2 escritores de `CatalogProduct` gravam os 3 campos. E2E ok. **Zero writes Shopify.**
- [x] **Fase 5** — definição `alterpop.franchise` criada em jyr17t-wr
      (`gid://shopify/MetafieldDefinition/1520603857226`), tipo `list.single_line_text_field`,
      pinned, `smartCollectionCondition` **eligible: true, enabled: true**. Contraria a doc
      (que só lista o escalar) — verificado por probe transitório + na definição real.
      Forma documentada em `lib/importer/shopify/franchiseMetafieldDefinition.js`.
      **FECHADO (Carlos, 2026-09-06):** regra `EQUALS "Harry Potter"` contra
      `list.single_line_text_field` casou e puxou produtos numa coleção de teste (criada,
      verificada, apagada). Smart collections com condição de metafield de lista funcionam
      nesta loja no Basic. O desenho das coleções Universe mantém-se — **não** se cai para
      `collectionAddProducts`.
- [~] **Fase 6** — escrever `alterpop.franchise` nos produtos.
      - **Lote 1 (2026-09-06): 40 produtos via MCP** — 34 Harry Potter, 2 The Lord of the
        Rings, 2 Naruto, 2 Dragon Ball. Valor `["<Nome>"]`. `metafieldsCount` = 40, zero
        userErrors. **Confirmado pelo Carlos:** forma certa, nomes canónicos, sem espanhol,
        produtos que não resolvem sem campo.
      - Discrepância pequena, a confirmar na próxima passagem (não bloqueia): coleção de
        teste `EQUALS "Harry Potter"` deu 33, foram escritos 34. Provável `productsCount`
        a atualizar devagar após escrita em massa (os 34 estavam ACTIVE quando escritos).
      - `scripts/catalog/franchise-metafield-write.js` — bulk: stream do feed → mapa
        SKU→universo → páginas de produtos → `metafieldsSet` 25/lote, idempotente,
        `--dry-run` / `--limit` / `--universe`. Merge (`ad22635` em `main`) + `fly deploy`
        feitos 2026-09-06.
      - **Dry-run na Fly:** 5575 vistos · 3044 sem resolução · 40 já corretos (lote 1) ·
        **2491 a escrever** em 38 universos.
      - **`--universe "Harry Potter"` na Fly:** 33 já corretos, **117 escritos, 0 falhados**.
        `metafieldDefinition.metafieldsCount` = **157** (= 40 + 117, sem sobreposição — a
        idempotência funciona). O 34.º HP do lote 1 não bate no lookup por SKU do script
        (provável multi-variante) → é saltado mas mantém a tag do lote 1; a matemática
        fecha (157 = 151 HP + 2 LOTR + 2 Naruto + 2 DBZ).
      - Nota: `productsCount(query: "metafields.alterpop.franchise:…")` devolve o total
        (5575) — o filtro de metafield não se aplica a `productsCount`. Verificação por
        universo faz-se no conector / com `products(first:… query:…)`. A regra de smart
        collection (mecanismo diferente) já foi confirmada a funcionar.
      - **Bulk completo na Fly (2026-09-06):** 2374 escritos, 0 falhados. `metafieldsCount`
        final = **2531** (= 157 + 2374, exato — nada perdido). Verificado: amostra dos 250
        produtos mais recentes cobre ~25 universos, **todos os valores `["<Nome canónico EN>"]`**,
        um elemento, zero espanhol (nada de "Los Vengadores", "Tortugas Ninja", "Miercoles",
        "El Señor…"). `Pokémon` (é) e `Hello Kitty / Sanrio` (/) são os nomes canónicos da tabela.
      - **Limitação conhecida do script:** lookup lê só `variants(first: 1)`; produtos
        multi-variante cujo SKU do feed seja de outra variante ficam de fora (1 caso no HP).
        Documentado no cabeçalho do script.
      - **Fase 6 concluída.**
      - Alcance real: ~2500–3000 dos ~5575 publicados, não os 14 163 do feed. Os restantes
        ficam com `resolvedFranchise` na BD local e recebem o metafield quando forem publicados.
- [ ] **Fase 6b (não perder entre 6 e 9)** — a escrita de `alterpop.franchise` tem de
      entrar no **fluxo de publicação** (`shopifyProductPublisher.server.js` /
      `runApprovedShopifySync`), ao lado do `setLicenceMetafield` que já lá está. Senão
      cada produto novo que o Carlos publique nasce sem franquia.
- [ ] Fases 7–9.

---

## §A. Achados do Portão A — passagem real (2026-09-06)

`npm run franchise:report` sobre o feed OcioStock (`OCIOSTOCK_CSV_PATH`), 29 430 produtos.
JSON: `results/franchise-report-2026-09-06T14-11-*.json`.

**Totais:** 13 854 resolvidos (47,1 %) · camada 1: 13 550 (97,8 %) · camada 2: 304 (2,2 %) ·
vazio: 15 576 (52,9 %).

### O que correu bem

1. **A previsão do casing não se confirmou — `normRef()` já resolve.** Os `ref="…"` do
   feed são códigos tipo `POKEMON`, `HELLOKITTY`, `DRAGON BALL`, `KimetsunoYaiba`,
   `MastersoftheUniverse`. A tabela tem `Pokemon`, `Hello Kitty`, `Dragon Ball`,
   `Kimetsuno Yaiba`, `Mastersofthe Universe`. O `normRef` (lowercase + tira pontuação/
   espaços) faz os dois bater. **37 dos 40 universos originais** casam com ≥ 1 ref do feed
   (os 3 sem ref — Ghibli, Final Fantasy, Resident Evil — dependem da camada 2). Com a
   entrada #41 (Lord of the Rings, ref `EL SEÑOR DE LOS ANILLOS`) são 38/41.
2. **`xml_info_familias` é `<categories><category gesioid=".." ref="CÓDIGO">CDATA</category>`.**
   O `ref` é o código do nó de categoria do fornecedor (492 distintos), não um vocabulário
   de franquia à parte — inclui franquias (`MICKEY`, `STITCH`, `ONEPIECE`) e ruído
   (`MANGA`, `FUNKO`, `XON`, `pop`, `ofertas`). O `franchiseRefs` da Fase 1 apanha-os todos;
   o resolver ignora os que não estão na tabela. Correto.
3. **Precedência na camada 1 (bug do 1º pass) — corrigida** (`8906668`). 0 produtos
   Mandalorian/Grogu em Star Wars (eram 231). The Mandalorian: 293 via camada 1.
4. **Passagem real ≈ passagem degradada** (L1 13 550 vs 13 548). A separação da Fase 1 é
   mais limpa mas não muda a atribuição — os identificadores de franquia estão tanto nos
   `ref=` como no CDATA. O valor da Fase 1 é não gravar `MANGA`/`FUNKO` como franquia.

### Ajustes à tabela — feitos (commits `1eb5aed`, `4dec5dd`)

- [x] **Entradas de ref mortas removidas**: `Demon Slayer` → só `KimetsunoYaiba`;
      `Mickey & Friends` → sem `Pato Donald`. Cosmético, sem regressão (1154 / 209).
- [x] **Studio Ghibli** — padrões alargados aos títulos dos filmes (Porco Rosso, Castle
      in the Sky, Princess Mononoke, Kikis Delivery Service, Ponyo, Nausicaa, Arrietty,
      The Wind Rises, Grave of the Fireflies, My Neighbor Totoro). Guardas: `Mononoke`
      só "Princess Mononoke"; `Howl` só "Howls Moving Castle". **12 → 28**, passa a ativo.
- [x] **#41 The Lord of the Rings** (Carlos) — ref `EL SEÑOR DE LOS ANILLOS` (157) estava
      a resolver p/ vazio; era o exemplo original do briefing. O feed não separa O Hobbit
      (mesmo ref). Resolve **162** (157 L1 + 5 L2). Tabela: 41 universos, 31 ativos.
      ⚠️ handle `lord-of-the-rings` **a confirmar pelo Carlos** antes de publicar (SEO).
- [ ] **Re-baselinar `estRange`** — dentro da Fase 4 (ver §6 abaixo). Medido em 5575
      publicados; catálogo real 29 430; ativos resolvem 3–15× acima da banda. Ao
      re-baselinar, a semântica da coluna muda: *"estimativa por título / 5575 publicados"*
      → *"resolvidos na última passagem completa / 29 430"* (comentário do campo a dizê-lo).

### Amostra do vazio (200 títulos) — vazio validado como correto

Nenhuma das 41 é perdida por padrão fraco. O ~53 % vazio é: Disney sub-marcas não
promovidas (Winnie 161, NBX 251, Princesas 283, Moana, Bela e o Monstro…), futebol,
Marvel/DC órfãos, dezenas de franquias reais fora da lista (Snoopy 209, Minions,
Jurassic 160, FNAF, GoT/HotD, Godzilla, Gremlins, Saint Seiya, Haikyu, JoJo, Hunter×Hunter…)
e a ala de brinquedos/papelaria (Clementoni 722, Erik 534, safta 632, Hot Wheels, Barbie 244).

### Decisões de negócio (fechadas pelo Carlos, 2026-09-06)

- **Nenhum entra**: `KPopDemonHunters` (646), `blueyfriends` (336), `PAWPATROL` (330),
  `PRINCESAS` (300). ~1600 produtos resolvem p/ vazio e nunca entram na lista de
  candidatos (Fase 9) — **consequência aceite, não é problema a corrigir**.
- **`MINECRAFT` (307) NÃO está nos 41** (#17 = Wonder Woman; Minecraft só na lista antiga
  de 96). Não é bug — a ref não mapeada é comportamento correto.
- **Lista fechada nas 41.** `MARVEL`/`DC`/futebol → vazio por design.
- Pendente (não bloqueia): Gudetama/Sumikko Gurashi vêm com `ref="MANGA"` e são
  tecnicamente Sanrio — os padrões de Hello Kitty/Sanrio não os apanham. Alargar? (Carlos)
- `ichibansho` (385), `BittyPop` (322), `LOUNGEFLY` (611) → são **Lines**, corretamente fora.

### Fecho do Portão A
- [x] Passos 1–5 da revisão do Carlos concluídos. Report v3 (`--from-csv`) validado.
- [ ] Carlos: confirmar handle `lord-of-the-rings`. Alargar Sanrio (Gudetama/Sumikko)?
- [ ] Re-baselinar `estRange` — **primeiro passo da Fase 4**.
- [x] **Fases 4–6 podem arrancar.**

---

## §B. Delta ao briefing (`docs/normalizacao-franquias.md` continua válido no essencial)

Decisões novas desde a versão que o briefing tem:

- **Tier** — `premium` se `vendor ∈ {Tamashii Nations, Megahouse, Noble Collection}` **ou**
  o título tiver `Statue` / `Bust` / `Diorama` / `Replica` / uma escala (ex. `1/7`, `1:6`).
  `impulse` no resto. **Nunca por preço.** A escala de 4 níveis fica adiada até haver
  `collectible_type`.
- **Publicação é sempre manual.** Zero regras de elegibilidade no publisher. **Peça nova,
  fora do faseamento atual:** desenhar a *lista de candidatos* — produtos resolvidos para
  um dos 40 e ainda não publicados, agrupados por universo, com o tier visível.
- **Ala de brinquedos fora dos universos, por design.** O ~53 % vazio deixa de ser aviso e
  passa a linha informativa no report.
- **Nomes de personagem** — forma curta; longa só para desempate e nomes genéricos.
- **Selo de autenticidade incondicional** — todos os produtos são licenciados; texto fixo
  no tema, sem campo da app.
- **Órfãos Marvel/DC adiados** — resolvem para vazio, nunca aparecem na lista de candidatos.
- **Futebol fora** — sem objeto (`REALMADRID`/`FCBARCELONA` ficam vazios).

### Como correr o report (PORTÃO A)

```bash
# na máquina/host com .env (OCIOSTOCK_CSV_URL ou OCIOSTOCK_CSV_PATH):
npm run franchise:report                 # catálogo todo, via stream do CSV
npm run franchise:report -- --limit 3000 # amostra rápida
npm run franchise:report -- --supplier-only --json   # camada 2 só p/ títulos do fornecedor + dump JSON
```

Não toca na BD nem na Shopify. `--from-db` só depois da migração da Fase 4.
Sai com código 1 se detetar categoria-como-franquia ou Mandalorian em Star Wars.

---

## 0. O que a leitura do código confirmou

| Facto | Consequência para o plano |
|---|---|
| `parseFranchiseRefs()` (em `parseFamilies.js`) é o "Set de 4 fontes" da spec. **Só tem 1 caller:** `csvFieldMap.js:198`. | A Alteração 1 no parser é cirúrgica. O risco está a jusante, no campo `franchises`, não no parser. |
| O campo `record.franchises` → coluna `CatalogProduct.franchises` (JSON string) é lido por: facetas (`buildFacets`, `facetRegistry`, `translateFacets`), filtros de catálogo (`applyFilters`, `passesRecordFilters`, `structuredCatalogFilter`), taxonomia (`taxonomy.server.js`), `skuLifecycle`, `curatorChatTools`, `shopifyMapper`, e `shopifyProductPublisher` (→ `setLicenceMetafield(franchises[0])`). | `franchises` **não se toca**. Mantém-se com o comportamento atual. Adiciona-se um campo novo ao lado. |
| `translate.js:140` **traduz** cada token de `record.franchises` via `translateCategory` (dicionário de categorias). | Os refs controlados (`BLACKCLOVER`) não podem passar por aqui. O campo novo tem de ser preenchido e persistido **sem** passar pela tradução. |
| `CatalogProduct` não tem coluna para refs isolados nem para franquia resolvida. | 1 migração Prisma: `+franchiseRefs`, `+resolvedFranchise`, `+resolvedFranchiseLayer`. |
| `autoCollections.server.js` conta `franchises[0]` normalizado (`normalizeLicenceLabel`), cria smart collection com regra sobre `ociostock.licence`, limiar 10, dedup por `AutoCollectionLicence` + match fuzzy de títulos. Nunca publica. Corre em `api.trigger-sync.jsx:186`. | A mecânica fica. Trocam-se **fonte** (`resolvedFranchise`), **título/handle** (tabela dos 40), **template** (`universe-room`), e ganha **dry-run**. |
| Já existe `FRANCHISE_CATALOG_NAMES` (96 nomes) em `franchiseCatalogList.js`, consumido por `syncFranchiseCatalog` (grelha `/pages/franquias`). | É outra lista, outro fim. Não se mexe. A tabela nova dos 40 universos é um módulo à parte. Documentar a sobreposição. |
| Scripts standalone: padrão `node scripts/<área>/<nome>.js`, sessão via `loadOfflineSessionForShop(shop)`, cliente via `createShopifyClientFromSession(session)`. Loja default `jyr17t-wr.myshopify.com`. | Os dois comandos novos seguem o mesmo molde. |
| Não há `AGENTS.md`/`CLAUDE.md` neste repo (o handover fala deles mas referem-se a outro). | A regra "coleção nunca publicada" está no cabeçalho de `autoCollections.server.js` — preservar textualmente. |

---

## 1. Ordem de trabalho e portões de segurança

```
Fase 1  Alteração 1  — separar refs de tokens              [sem efeito em produção]
Fase 2  Tabela dos 40 universos (módulo de dados)          [sem efeito]
Fase 3  Alteração 2  — franchiseResolver + REPORT MODE      [só lê, imprime]
        ── PORTÃO A: rever contagens do relatório com o Carlos ──
Fase 4  Persistência: migração + preencher resolvedFranchise na indexação   [escreve BD local, não Shopify]
Fase 5  Definição de metafield alterpop.franchise (useAsCollectionCondition) [cria 1 definição na loja]
Fase 6  Escrever alterpop.franchise nos produtos a partir de resolvedFranchise [escreve metafields em massa]
Fase 7  Alteração 3  — universeCollections + DRY-RUN         [só lista o que criaria]
        ── PORTÃO B: rever plano de coleções ──
Fase 8  Executar coleções + wiring no trigger-sync           [cria collections em rascunho, já com produtos]
Fase 9  Lista de candidatos (peça nova, §B) — produtos resolvidos p/ um dos 40 e não
        publicados, agrupados por universo, com tier. UI de curadoria, não toca no publisher.
```

Fases 1–3 são um PR. Fases 4–6 são outro. Fases 7–8 são um terceiro.

### Correção (Carlos, 2026-09-06): as coleções não podem nascer vazias

A versão anterior dizia "nenhuma fase escreve `alterpop.franchise`". Não se sustenta:
a Fase 8 cria as smart collections mas `resolvedFranchise` só vive na BD local — a
Shopify não sabe dele, e as 30 coleções nasceriam vazias.

**Decisão: escrever o metafield `alterpop.franchise` nos produtos** (Fase 6), a partir
de `resolvedFranchise`. A alternativa — `universeCollections` popular por
`collectionAddProducts` — foi rejeitada por criar uma segunda fonte de verdade a manter
sincronizada. O metafield é o contrato com o tema e é preciso de qualquer forma.

### Ordem obrigatória à volta da definição de metafield

1. **Fase 5** — criar a definição `alterpop.franchise` com **`useAsCollectionCondition: true`**.
   A coluna de regra `PRODUCT_METAFIELD_DEFINITION` (enum `CollectionRuleColumn`) só é
   oferecida para definições com essa flag. Se a definição nascer sem ela, a regra da
   Fase 7 nem sequer é aceite — e descobre-se tarde.
   - ⚠️ `alterpop.franchise` é `list.single_line_text_field`. **Verificar na Fase 5 que a
     Shopify aceita `useAsCollectionCondition` num tipo de lista.** Se não aceitar:
     abandonar a smart collection, cair para `collectionAddProducts` a partir de
     `resolvedFranchise`, e avisar o Carlos.
2. **Fase 6** — escrever os metafields.
3. **Fases 7–8** — planear e criar as coleções (regra `alterpop.franchise EQUALS <nome>`,
   `appliedDisjunctively: false`), abordagem **(b)**: regra posta, coleção em rascunho.
   `productsCount` é sabidamente lento a atualizar depois de mutations em massa — usar
   `products(first: 3)` como verificação secundária de que a regra apanha produtos.

---

## 2. Alteração 1 — separar `ref=""` dos tokens de categoria

### Ficheiro: `lib/importer/connectors/ociostock/parseFamilies.js`

**Novo export** `parseFamilySignals(xmlFamilies, context)` que devolve:

```js
{
  franchiseRefs: string[],   // SÓ valores de atributos ref="..." em xml_info_familias, ordem de ocorrência
  categoryTokens: string[],  // CDATA + <category> texto + categoria_principal + product_type_path (o resto)
}
```

- `franchiseRefs`: extrai `ref="([^"]+)"` do `xmlFamilies` apenas. Sem dedup destrutivo
  da ordem (`[...new Set()]` preserva 1.ª ocorrência — ok).
- `categoryTokens`: exatamente o que hoje entra no bucket a partir das outras 3 fontes.

**`parseFranchiseRefs()` mantém-se** como wrapper fino, para não tocar noutros sítios:

```js
export function parseFranchiseRefs(xmlFamilies, context = {}) {
  const { franchiseRefs, categoryTokens } = parseFamilySignals(xmlFamilies, context);
  return [...new Set([...franchiseRefs, ...categoryTokens])]; // comportamento atual, byte a byte
}
```

### Ficheiro: `lib/importer/connectors/ociostock/csvFieldMap.js`

Trocar a chamada única (linha ~198) por `parseFamilySignals(...)`. No objeto `record`:

- `franchises` — **inalterado**: `[...new Set([...franchiseRefs, ...categoryTokens])]`.
  Continua a alimentar facetas, filtros, tradução, tudo.
- `franchiseRefs` — **novo**: `[...new Set(franchiseRefs)]`. Cru, maiúsculas do fornecedor.

### Ficheiro: `lib/importer/transform/translate.js`

Guarda explícita: **não** traduzir `record.franchiseRefs` (não lhe tocar). Já não passa
por lá porque o loop de tradução só olha para `record.franchises`; adicionar comentário
a dizer porquê, para ninguém "corrigir" mais tarde.

### Validação da Alteração 1 (spec §"Validação")

Script de spot-check ou teste: um produto Black Clover →
`franchiseRefs` contém `BLACKCLOVER` e `FUNKO`, e **não** contém `ANIME_MANGA` nem
`POP_CULTURE_COLLECTIBLES`. Esses ficam em `categoryTokens`.

### Blast radius

Um caller de parser alterado (`csvFieldMap`). Zero alterações nos ~20 consumidores de
`franchises`. `franchiseRefs` fica órfão até à Fase 3 — aceitável.

---

## 3. Fase 2 — tabela dos 40 universos

### Ficheiro novo: `lib/importer/catalog/franchiseUniverses.js`

Traduz a tabela da spec para dados. Sem lógica.

```js
/** Lista fechada pelo negócio a 2026-09-05. Contagens = estimativa por título; número
 *  real sai do report mode do franchiseResolver. NÃO confundir com FRANCHISE_CATALOG_NAMES
 *  (franchiseCatalogList.js) — essa alimenta a grelha /pages/franquias e fica como está. */
export const FRANCHISE_UNIVERSES = [
  {
    name: "Pokémon", handle: "pokemon",
    refs: ["Pokemon"],
    titlePatterns: ["Pokemon", "Pokémon"],
    estProducts: 112, dormant: false,
  },
  {
    name: "Star Wars", handle: "star-wars",
    refs: ["Star Wars", "Bobafett"],
    titlePatterns: ["Star Wars", "Sar Wars"],   // "Sar Wars" existe mesmo no feed
    estProducts: 246, dormant: false,
  },
  // … 38 restantes, verbatim da tabela …
  {
    name: "The Mandalorian", handle: "the-mandalorian",
    refs: ["Mandalorian"],
    titlePatterns: ["Mandalorian", "Grogu", "Ahsoka"],
    estRange: [54, 82], dormant: false,   // NÃO 54+28=82: padrões sobrepõem-se; real sai do report mode
  },
  // …
];
```

**`estRange`, não `estProducts` somado** (Carlos, 2026-09-06). Onde a tabela da spec diz
`a+b` (Mandalorian 54+28, Demon Slayer 75+63, Mickey+Minnie 71+67), os dois números são
contagens de padrões que se sobrepõem — o mesmo produto conta nos dois. A união está
entre `max(a,b)` e `a+b`, mais perto do maior. Guardar como intervalo `[low, high]` e
deixar o report mode dar o número real. Universos com um só número: `estRange: [n, n]`.

```js

/** Pares [específico, genérico] que TÊM de ser testados nesta ordem (spec "Precedência"). */
export const FRANCHISE_PRECEDENCE = [
  { before: ["Grogu", "The Mandalorian", "Ahsoka", "Mandalorian"], after: ["Star Wars", "Sar Wars"] },
  { before: ["Boruto"], after: ["Naruto"] },
  { before: ["Spider-Man", "Spiderman", "Spider Man", "X-Men", "Xmen"], after: ["Avengers", "Vengadores"] },
  { before: ["Kimetsu no Yaiba"], after: ["Demon Slayer"] },
  { before: ["Super Mario", "Mario Bros"], after: ["Mario"] },
];

export const UNIVERSE_COLLECTION_THRESHOLD = 10;   // cria a 10
export const UNIVERSE_COLLECTION_FLOOR = 1;        // só remove a 0 ou 1 (histerese)
export const UNIVERSE_TEMPLATE_SUFFIX = "universe-room";
```

Nota de manutenção: a tabela dos 40 tem `refs` que hoje saem em bruto do feed
(`"Star Wars"`, `"Bobafett"`), mas o `parseFranchiseRefs` já os viu como `ref="..."`?
**A verificar na Fase 3 com o report mode** — se um ref esperado nunca aparecer em
`franchiseRefs[]` de nenhum produto, cai para a camada 2 (título), tal como a LOTR.

---

## 4. Alteração 2 — `franchiseResolver.server.js`

### Ficheiro novo: `lib/importer/catalog/franchiseResolver.server.js`

Função pura, sem I/O:

```js
/**
 * @param {{ franchiseRefs?: string[], title?: string }} product
 * @returns {{ franchise: string|null, layer: 1|2|3, matchedOn: string|null }}
 */
export function resolveFranchise(product) { … }
```

**Camada 1 — mapa de refs.** Índice `refUpper → universe` construído 1× a partir de
`FRANCHISE_UNIVERSES[].refs` (normalizado: upper, sem espaços/pontuação). Compara contra
`product.franchiseRefs`. 1.º match por ordem de `franchiseRefs` ganha. → `layer: 1`.

**Camada 2 — padrões de título.** Só corre se a camada 1 devolveu `null`.
1. Remover prefixo de formato do título (vocabulário fechado da spec:
   `POP figure`, `Pocket POP Keychain`, `Blister N figures Bitty POP`, `Display Bitty POP`,
   `Figure POP`, `Loungefly`, `Deluxe`, `Assorted`, `Blind box`, `Set`, …).
2. Construir lista de candidatos `{ universe, pattern }` de todos os `titlePatterns`,
   **ordenada por comprimento de pattern decrescente**, com os pares de
   `FRANCHISE_PRECEDENCE` forçados à frente.
3. Match **ancorado** — não `contains` cru. Regra: `\b<pattern>\b` com fronteiras
   Unicode, e para patterns ≤ 4 chars (`Up`, `300`, `Kong`, `Mario`) exigir também que
   não seja substring de palavra maior. Testar contra o catálogo todo no report mode
   antes de confiar. → `layer: 2`.

**Camada 3 — vazio.** `{ franchise: null, layer: 3 }`. Nunca usar `licence`/`franchises`
como recurso.

**Saída de lista:** o metafield é `list.single_line_text_field` mas **um produto = um
universo** (spec). O resolver devolve string única; quem escrever o metafield embrulha em
`[franchise]`. Crossover genuíno fica para decisão manual, não sai daqui.

### Report mode

Ficheiro novo: `scripts/catalog/franchise-resolve-report.js`
`package.json`: `"franchise:report": "node scripts/catalog/franchise-resolve-report.js"`

- Lê `CatalogProduct` do shop em páginas (`prisma.catalogProduct.findMany`,
  `select: { sku, title, franchiseRefs, franchises, vendor }`).
  - Pré-Fase 4 (coluna `franchiseRefs` ainda não existe / ainda não preenchida):
    flag `--from-csv` re-processa o feed com `runImport({ dryRun:true })` estilo
    `stream-import-dry-run.js` e resolve em memória. Default depois da Fase 4: lê da BD.
- Corre `resolveFranchise` por produto. **Não escreve nada.**
- Imprime:
  1. Tabela por universo: `nome | estRange [low,high] | resolvidos | dentro/fora do range | camada 1 | camada 2`.
  2. Totais: `% catálogo resolvido`, `# camada 1 (%)`, `# camada 2 (%)`, `# vazio`, com
     nota de leitura: **o rácio L1/L2 é o número mais informativo**. L2 quase nulo ⇒
     padrões fracos, franquias escondidas (o caso LOTR). L2 alto ⇒ a separação de refs
     da Fase 1 não está a funcionar.
  3. **Alertas de sanidade** (spec §"Critérios de validação" + revisão do Carlos):
     - produto com franquia `Funko` / `Pop` / `Exclusive` / `Anime & Manga` → ERRO
       (tokens de categoria a entrar nos refs). Sai com código 1.
     - `POP figure Star Wars The Mandalorian Grogu` em Star Wars → ERRO de precedência. Código 1.
     - **ref que ESTÁ na tabela mas o produto foi resolvido por camada 2/3** → ERRO:
       contradição no resolver (bug silencioso — o resultado final até fica certo). Código 1.
     - **produtos resolvidos por camada 2 que tinham refs** → aviso se > 5 % da camada 2;
       normalmente ref do feed com grafia que a tabela não prevê. Acompanha a lista das
       refs não mapeadas mais frequentes (candidatas a acrescentar a `refs[]`).
     - `One Piece` ~379, `Stitch` ~105 — desvio > 25 % → aviso.
     - universo da tabela com 0 resolvidos → aviso.
     - **universo de banda larga (estRange low≠high) a resolver no topo/acima** → aviso:
       nos casos de sobreposição o real deve ficar perto do LOW (ex.: Mandalorian ~54,
       não ~82); perto do topo ⇒ confirmar que não há dupla contagem / precedência mal afinada.
  4. Amostra de 12 títulos por universo (com camada + padrão que bateu) e 30 "vazios".
- `--json` escreve `results/franchise-report-<timestamp>.json` para diff entre corridas.

**PORTÃO A** — o Carlos revê estas contagens contra a tabela antes de qualquer escrita.

---

## 5. Fase 4 — persistência (migração + indexação)

### Migração Prisma `20260906xxxxxx_franchise_resolution`

`model CatalogProduct` ganha:
```
franchiseRefs          String  @default("[]")   // JSON string[] — refs crus do feed
resolvedFranchise      String?                  // nome canónico do universo, ou NULL
resolvedFranchiseLayer Int?                     // 1 | 2 | 3 — proveniência, para auditoria
```

### Escrita

Onde o record é persistido em `CatalogProduct` (`catalogProductsDb.server.js` /
`catalogInsertBatch.server.js` — os dois sítios que já serializam `franchises`):
- guardar `franchiseRefs` (de `record.franchiseRefs`);
- chamar `resolveFranchise({ franchiseRefs: record.franchiseRefs, title: record.title })`
  e guardar `resolvedFranchise` + `resolvedFranchiseLayer`.

Título: usar `record.title` (já em inglês — `titleSource: "supplier"` em 99,8 %; nos
`pipeline` é o glossário, aceitável). Confirmar no report mode que os `pipeline` não
degradam a camada 2.

Continua **sem** tocar em Shopify. `alterpop.franchise` como metafield: fora deste plano.

---

## 6. Alteração 3 — `autoCollections.server.js` + dry-run

### Reorientação (mantendo a mecânica: limiar, dedup, fuzzy-title, "nunca publica")

Novo módulo ou secção `universeCollections.server.js` (deixar `autoCollections.server.js`
legacy intacto para não perturbar `app.reports.jsx`, ou refatorar com cuidado — decidir
na implementação; preferência: **ficheiro novo**, o antigo deixa de ser chamado):

| | Antes (`autoCollections`) | Depois (`universeCollections`) |
|---|---|---|
| Fonte da contagem | `franchises[0]` → `normalizeLicenceLabel` | `CatalogProduct.resolvedFranchise` |
| Universo alvo | o que emergir do feed | só os de `FRANCHISE_UNIVERSES` não-dormentes |
| Contagem | SKUs **PUBLISHED** | **catálogo completo** do universo (spec: "não stock") |
| Limiar | 10, sem histerese | cria a ≥ 10, remove só a ≤ 1 (`UNIVERSE_COLLECTION_FLOOR`) |
| Título | label do feed | `universe.name` |
| Handle | derivado | `universe.handle` |
| Regra da collection | metafield `ociostock.licence` EQUALS | metafield `alterpop.franchise` (quando existir) — **ver nota** |
| Template | nenhum | `templateSuffix: "universe-room"` via `CollectionInput` |
| Dedup | `AutoCollectionLicence` + fuzzy | tabela nova `UniverseCollection` (handle-keyed) + o mesmo fuzzy contra collections manuais |

**Nota sobre a regra da smart collection (resolvido — Carlos, 2026-09-06):** abordagem
**(b)**. A regra `PRODUCT_METAFIELD_DEFINITION EQUALS <universe.name>` fica posta; a
coleção nasce em rascunho e enche-se sozinha assim que a Fase 6 tiver escrito
`alterpop.franchise` nos produtos. Pré-condições, por ordem: **Fase 5** cria a definição
com `useAsCollectionCondition: true` (sem a flag, a coluna de regra nem é oferecida) →
**Fase 6** escreve os metafields → esta fase cria as coleções. Se a Shopify recusar
`useAsCollectionCondition` em `list.single_line_text_field`, cair para
`collectionAddProducts` a partir de `resolvedFranchise` e avisar o Carlos.
`productsCount` demora a refletir mutations em massa — usar `products(first: 3)` como
verificação secundária.

### Dry-run

`planUniverseCollections(shop, { dryRun = true })`:
- Lê `resolvedFranchise` da BD, agrega por universo, aplica limiar + histerese + dormentes.
- Lê collections existentes (GraphQL **read-only**) para o fuzzy-match.
- **Não** chama `collectionCreate`, **não** escreve `UniverseCollection`.
- Devolve/imprime:
  - `toCreate`: `[{ name, handle, count, templateSuffix }]`
  - `toMatch`: `[{ name, handle, existingCollectionId, existingTitle }]` (já existe manual)
  - `belowThreshold`: universos ativos com 2–9 produtos (quase lá)
  - `dormant`: os 10 dormentes, com contagem atual
- Script: `scripts/catalog/universe-collections-plan.js` →
  `"universe:plan": "node scripts/catalog/universe-collections-plan.js"`
- Critério de aceitação (spec): **30 `toCreate`**, cada um com `templateSuffix:
  "universe-room"`, **0** para os dormentes, as 24 `auto-licenca-*` **intactas**.

**PORTÃO B** — rever `toCreate`/`toMatch` antes de executar.

### Fase 8 — executar

- `planUniverseCollections(shop, { dryRun: false })` cria as collections (rascunho) e
  grava `UniverseCollection`. Como a Fase 6 já correu, nascem já com produtos.
- `api.trigger-sync.jsx`: substituir a chamada `checkAndCreateLicenceCollections`
  (linha ~183-186) por `planUniverseCollections(shop, { dryRun: false })`. Manter o
  `try/catch` "nunca falha o ciclo". Idealmente encadear também a escrita de metafields
  da Fase 6 aqui (a partir de `resolvedFranchise`), para o ciclo automático manter tudo
  em dia — decidir no PORTÃO B.
- `app.reports.jsx`: trocar `listAutoCollections` por `listUniverseCollections` no painel.
- **Não** mexer nas 24 `auto-licenca-*` (spec). Apagá-las é tarefa cosmética à parte.

---

## 7. Ficheiros — resumo

**Novos**
- `lib/importer/catalog/franchiseUniverses.js` — tabela dos 40 + precedência + constantes (Fase 2)
- `lib/importer/catalog/franchiseResolver.server.js` — `resolveFranchise()` (puro) (Fase 3)
- `scripts/catalog/franchise-resolve-report.js` — report mode (Fase 3)
- `scripts/tests/franchise-resolver.test.js` — casos de precedência da spec (Fase 3)
- `prisma/migrations/20260906xxxxxx_franchise_resolution/migration.sql` (Fase 4)
- `lib/importer/shopify/franchiseMetafieldDefinition.js` — def. `alterpop.franchise` c/ `useAsCollectionCondition` (Fase 5)
- `scripts/catalog/franchise-metafield-write.js` — escreve `alterpop.franchise` em massa de `resolvedFranchise` (Fase 6)
- `lib/importer/shopify/universeCollections.server.js` — plan/create + dry-run (Fase 7)
- `scripts/catalog/universe-collections-plan.js` — dry-run de coleções (Fase 7)

**Alterados**
- `lib/importer/connectors/ociostock/parseFamilies.js` — `parseFamilySignals()` + wrapper (Fase 1)
- `lib/importer/connectors/ociostock/csvFieldMap.js` — usa `parseFamilySignals`, adiciona `record.franchiseRefs` (Fase 1)
- `lib/importer/transform/translate.js` — comentário-guarda (não traduzir `franchiseRefs`) (Fase 1)
- `lib/importer/catalog/catalogProductsDb.server.js` + `catalogInsertBatch.server.js` — persistir 3 campos novos (Fase 4)
- `prisma/schema.prisma` — 3 colunas em `CatalogProduct` + `model UniverseCollection` (Fase 4/7)
- `lib/importer/shopify/metafieldSetup.js` — registar a nova definição no array de `ensureOciostockMetafieldDefinitions` (Fase 5)
- `package.json` — scripts `franchise:report`, `franchise:write-metafields`, `universe:plan` (+ execução)
- `app/routes/api.trigger-sync.jsx` — troca de chamada (Fase 8)
- `app/routes/app.reports.jsx` — painel (Fase 8)

**Intactos** (confirmado): `franchiseCatalogList.js`, `franchiseCatalogSync.server.js`,
`autoCollections.server.js` (deixa de ser chamado, não é apagado), todos os consumidores
de `franchises`.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Falsos positivos da camada 2 (`Up`, `300`, `Kong`) mandam produtos ao universo errado, sem erro | Matching ancorado + report mode obrigatório antes de escrever + testes de precedência |
| `record.title` de produtos `pipeline` (~0,2 %) demasiado ruidoso para a camada 2 | Report mode segrega por `titleSource`; se degradar, camada 2 só corre para `titleSource: "supplier"` |
| Refs da tabela (`"Star Wars"`, `"Bobafett"`) podem não bater com o que o feed põe em `ref="..."` | Report mode lista refs vistos vs. esperados; ajustar tabela ou empurrar para camada 2 |
| Traduzir `franchises` (translate.js) colide se alguém reutilizar o campo | `franchiseRefs` é campo separado e não entra no loop de tradução |
| Regra `alterpop.franchise EQUALS` numa smart collection sem o metafield populado | Collection nasce vazia em rascunho; decisão registada no PORTÃO B |
| `app.reports.jsx` importa `listAutoCollections` — refactor parte o Relatórios | Ficheiro novo em paralelo; troca só na Fase 6, com a página testada |

---

## 9. Decisões do Carlos (2026-09-06) — fechadas

1. **`a+b` na tabela = intervalo, não soma.** `estRange: [max(a,b), a+b]`. Report mode dá
   o real. (Mandalorian, Demon Slayer, Mickey+Minnie.)
2. **Mickey & Friends = entrada única** (Mickey + Minnie + Donald).
3. **Smart collection: abordagem (b)** — regra `alterpop.franchise EQUALS` posta, coleção
   em rascunho até o metafield estar populado. Exige: definição criada com
   `useAsCollectionCondition: true` **antes** de escrever metafields; escrever metafields
   **antes** de criar coleções. Verificar que a flag é aceite em `list.single_line_text_field`;
   se não for, cair para `collectionAddProducts` e avisar.
4. **`universeCollections.server.js` = ficheiro novo em paralelo.** `autoCollections.server.js`
   deixa de ser chamado, não é apagado (`app.reports.jsx` importa-o).
5. **As coleções não nascem vazias** — Fase 6 escreve `alterpop.franchise` nos produtos a
   partir de `resolvedFranchise`. Não se usa `collectionAddProducts` como fonte paralela.

### Invariante a proteger contra refactors futuros

`record.franchiseRefs` é preenchido em `csvFieldMap.js` (antes da tradução) e **nunca**
passa por `translate.js`. Os refs são vocabulário controlado do fornecedor
(`BLACKCLOVER`, `STAR_WARS_EP`); traduzi-los destrói a chave de mapeamento da camada 1.
`translate.js:140` só toca em `record.franchises` — manter o comentário-guarda lá.
