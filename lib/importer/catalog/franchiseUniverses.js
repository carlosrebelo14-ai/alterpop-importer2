/**
 * Tabela dos 40 universos — lista fechada pelo negócio a 2026-09-05, por ranking de
 * procura. Fonte: docs/normalizacao-franquias.md (repo do tema) + docs/PLANO-normalizacao-franquias.md.
 *
 * Só dados, sem lógica. Consumido por:
 * - franchiseResolver.server.js (camadas 1 e 2)
 * - universeCollections.server.js (que universos ganham coleção Universe)
 *
 * NÃO confundir com FRANCHISE_CATALOG_NAMES (shopify/franchiseCatalogList.js) — essa é a
 * lista de 96 nomes que alimenta a grelha de /pages/franquias no tema e fica como está.
 * A sobreposição entre as duas é grande mas os fins são diferentes; não unificar sem
 * decisão de negócio.
 *
 * Campos de cada entrada:
 * - name           nome canónico (título da coleção Universe, valor de alterpop.franchise)
 * - handle         handle da coleção Shopify (imutável depois de indexado — cuidado)
 * - refs           valores esperados nos atributos ref="..." do feed (camada 1). Pode
 *                  estar vazio: universos sem ref dependem 100% da camada 2 (título).
 * - titlePatterns  padrões a procurar no título depois de remover o prefixo de formato
 *                  (camada 2). Ancorados por palavra no resolver, não `contains` cru.
 * - baseline       nº de produtos que o resolver atribuiu a este universo na ÚLTIMA
 *                  passagem completa do report (`npm run franchise:report` sobre o feed
 *                  OcioStock, 29 430 produtos, 2026-09-06). É referência, não alvo — serve
 *                  para o report assinalar desvios significativos numa passagem futura.
 *                  Substituiu a antiga estimativa "por título sobre 5575 publicados", que
 *                  estava 3–15× abaixo do real.
 * - active         true = baseline ≥ 10 (UNIVERSE_COLLECTION_THRESHOLD), cria coleção já.
 *                  false = dormente: definido, sem coleção até cruzar o limiar numa
 *                  passagem futura (aparece sozinho, sem alteração de código).
 * - priority       desempate na camada 2 quando um padrão curto deste universo tem de
 *                  vencer um padrão mais longo de outro (ver FRANCHISE_PRECEDENCE). 0 default.
 */

/** @typedef {{ name: string, handle: string, refs: string[], titlePatterns: string[], baseline: number, active: boolean, priority?: number }} FranchiseUniverse */

/** @type {FranchiseUniverse[]} */
export const FRANCHISE_UNIVERSES = [
  { name: "Pokémon", handle: "pokemon", refs: ["Pokemon"], titlePatterns: ["Pokemon", "Pokémon"], baseline: 622, active: true },
  { name: "Star Wars", handle: "star-wars", refs: ["Star Wars", "Bobafett"], titlePatterns: ["Star Wars", "Sar Wars"], baseline: 587, active: true },
  // `spidey` = linha pré-escolar (Spidey and His Amazing Friends), ref próprio no feed,
  // sem "Spider-Man" no título. ~150 produtos. Dobrado no universo Spider-Man por defeito
  // (Carlos, 2026-09-06) — dizer se a linha infantil deve ficar à parte.
  { name: "Spider-Man", handle: "spider-man", refs: ["Spider-man", "spidey"], titlePatterns: ["Spider-Man", "Spiderman", "Spider Man", "Spidey"], baseline: 858, active: true, priority: 10 },
  { name: "One Piece", handle: "one-piece", refs: ["One Piece", "Onepiece"], titlePatterns: ["One Piece"], baseline: 935, active: true },
  { name: "Gundam", handle: "gundam", refs: ["Gundam"], titlePatterns: ["Gundam", "Mobile Suit"], baseline: 156, active: true },
  { name: "Dragon Ball", handle: "dragon-ball", refs: ["Dragon Ball"], titlePatterns: ["Dragon Ball", "Dragonball"], baseline: 880, active: true },
  { name: "Batman", handle: "batman", refs: ["Batman"], titlePatterns: ["Batman"], baseline: 238, active: true },
  { name: "Demon Slayer", handle: "demon-slayer", refs: ["Kimetsuno Yaiba"], titlePatterns: ["Demon Slayer", "Kimetsu no Yaiba"], baseline: 209, active: true },
  { name: "Harry Potter", handle: "harry-potter", refs: ["Harry Potter", "Animales Fantásticos"], titlePatterns: ["Harry Potter", "Fantastic Beasts", "Hogwarts"], baseline: 1221, active: true },
  { name: "Mickey & Friends", handle: "mickey-and-friends", refs: ["Mickey", "Minnie", "Donald"], titlePatterns: ["Mickey", "Minnie", "Donald Duck"], baseline: 1154, active: true },
  { name: "Naruto", handle: "naruto", refs: ["Naruto", "Boruto"], titlePatterns: ["Boruto", "Naruto"], baseline: 542, active: true },
  { name: "Jujutsu Kaisen", handle: "jujutsu-kaisen", refs: ["Jujutsu Kaisen"], titlePatterns: ["Jujutsu"], baseline: 128, active: true },
  { name: "Transformers", handle: "transformers", refs: ["Transformers"], titlePatterns: ["Transformers"], baseline: 126, active: true },
  { name: "Superman", handle: "superman", refs: ["Superman"], titlePatterns: ["Superman"], baseline: 111, active: true },
  { name: "My Hero Academia", handle: "my-hero-academia", refs: ["My Hero Academia", "Myheroacademia"], titlePatterns: ["My Hero Academia"], baseline: 241, active: true },
  { name: "The Mandalorian", handle: "the-mandalorian", refs: ["Mandalorian"], titlePatterns: ["Mandalorian", "Grogu", "Ahsoka"], baseline: 293, active: true, priority: 10 },
  { name: "Wonder Woman", handle: "wonder-woman", refs: ["Wonderwoman"], titlePatterns: ["Wonder Woman"], baseline: 5, active: false },
  { name: "Attack on Titan", handle: "attack-on-titan", refs: ["Attackontittan"], titlePatterns: ["Attack on Titan", "Shingeki"], baseline: 57, active: true },
  { name: "TMNT", handle: "tmnt", refs: ["Tortugas Ninja"], titlePatterns: ["Ninja Turtles", "Tortugas Ninja", "TMNT"], baseline: 99, active: true },
  { name: "Frozen", handle: "frozen", refs: ["Frozen"], titlePatterns: ["Frozen"], baseline: 415, active: true },
  { name: "Sonic the Hedgehog", handle: "sonic", refs: ["Sonic"], titlePatterns: ["Sonic"], baseline: 415, active: true },
  { name: "Super Mario", handle: "super-mario", refs: ["Mario Bros."], titlePatterns: ["Super Mario", "Mario Bros"], baseline: 339, active: true },
  { name: "Stranger Things", handle: "stranger-things", refs: ["Strangerthings"], titlePatterns: ["Stranger Things"], baseline: 222, active: true },
  { name: "The Legend of Zelda", handle: "zelda", refs: ["Zelda"], titlePatterns: ["Zelda", "Hyrule"], baseline: 23, active: true },
  { name: "Avengers", handle: "avengers", refs: ["Los Vengadores"], titlePatterns: ["Avengers", "Vengadores"], baseline: 274, active: true },
  { name: "X-Men", handle: "x-men", refs: ["Xmen"], titlePatterns: ["X-Men", "Xmen"], baseline: 93, active: true, priority: 10 },
  // A maioria dos personagens Sanrio já casa pelo ref HELLOKITTY (Kuromi 393, Cinnamoroll
  // 66, My Melody 65…). Estes vinham com ref="MANGA" e ficavam vazios. Gudetama/
  // Aggretsuko/Little Twin Stars são Sanrio; Sumikko Gurashi e Rilakkuma são San-X, mas
  // o Carlos (2026-09-06) decidiu dobrá-los neste universo pela proximidade "kawaii mascot".
  { name: "Hello Kitty / Sanrio", handle: "hello-kitty", refs: ["Hello Kitty"],
    titlePatterns: ["Hello Kitty", "Sanrio", "Kuromi", "My Melody", "Gudetama",
      "Aggretsuko", "Little Twin Stars", "Sumikko Gurashi", "Rilakkuma"],
    baseline: 1345, active: true },
  { name: "Toy Story", handle: "toy-story", refs: ["Toystory"], titlePatterns: ["Toy Story"], baseline: 214, active: true },
  { name: "Wednesday", handle: "wednesday", refs: ["Miercoles"], titlePatterns: ["Wednesday", "Addams"], baseline: 146, active: true },
  { name: "Masters of the Universe", handle: "masters-of-the-universe", refs: ["Mastersofthe Universe"], titlePatterns: ["Masters of the Universe", "He-Man"], baseline: 104, active: true },
  { name: "G.I. Joe", handle: "gi-joe", refs: ["Gijoe"], titlePatterns: ["G.I. Joe", "GI Joe"], baseline: 20, active: true },
  { name: "Sailor Moon", handle: "sailor-moon", refs: ["Sailormoon"], titlePatterns: ["Sailor Moon"], baseline: 7, active: false },
  { name: "Evangelion", handle: "evangelion", refs: ["Evangelion"], titlePatterns: ["Evangelion", "Neon Genesis"], baseline: 38, active: true },
  // Ghibli não tem ref no feed — os filmes vêm com ref="MANGA" e o título é o nome do
  // filme, não "Ghibli". Padrões alargados aos títulos dos filmes (Carlos, 2026-09-06).
  // Cuidados: `Mononoke` sozinho colide com a série *Mononoke* (Kusuriuri) → só
  // "Princess Mononoke"; `Howl` é palavra comum → só "Howls Moving Castle". Apóstrofos
  // são normalizados para espaço, por isso os padrões vêm sem apóstrofo ("Kikis", "Howls").
  { name: "Studio Ghibli", handle: "studio-ghibli", refs: [], titlePatterns: [
      "Ghibli", "Totoro", "My Neighbor Totoro", "Spirited Away", "Princess Mononoke",
      "Porco Rosso", "Castle in the Sky", "Kikis Delivery Service", "Howls Moving Castle",
      "Ponyo", "Nausicaa", "Arrietty", "The Wind Rises", "Grave of the Fireflies",
    ], baseline: 28, active: true },
  { name: "Chainsaw Man", handle: "chainsaw-man", refs: ["Chainsaw Man", "Chainsawman"], titlePatterns: ["Chainsaw Man"], baseline: 88, active: true },
  { name: "Spy × Family", handle: "spy-family", refs: ["Spy Xfamily"], titlePatterns: ["Spy x Family", "Spy Family"], baseline: 29, active: true },
  { name: "Final Fantasy", handle: "final-fantasy", refs: [], titlePatterns: ["Final Fantasy"], baseline: 6, active: false },
  { name: "Resident Evil", handle: "resident-evil", refs: [], titlePatterns: ["Resident Evil", "Biohazard"], baseline: 4, active: false },
  { name: "The Last of Us", handle: "the-last-of-us", refs: ["Lastofus"], titlePatterns: ["The Last of Us"], baseline: 8, active: false },
  { name: "Stitch", handle: "stitch", refs: ["Stitch"], titlePatterns: ["Stitch", "Lilo"], baseline: 1721, active: true },
  // #41 — acrescentado a 2026-09-06 (Carlos). O feed dá o ref `EL SEÑOR DE LOS ANILLOS`
  // e NÃO separa O Hobbit: muitos títulos são "Hobbit El Señor de los Anillos …" sob o
  // mesmo ref/licença. Uma entrada só cobre as duas. Títulos chegam pós-tradução e
  // inconsistentes (uns "Lord of the Rings", outros ficam "El Señor de los Anillos"),
  // por isso os padrões cobrem ambas as grafias. ⚠️ handle a confirmar pelo Carlos
  // antes de publicar (SEO permanente — §3.4 do briefing).
  { name: "The Lord of the Rings", handle: "lord-of-the-rings",
    refs: ["El Señor de los Anillos"],
    titlePatterns: ["Lord of the Rings", "El Señor de los Anillos", "Senor de los Anillos"],
    baseline: 162, active: true },
];

/**
 * Precedência cross-universo para a camada 2 (spec §"Precedência — crítico").
 * Um erro aqui é silencioso: manda produtos para o universo errado sem falhar.
 *
 * O resolver ordena os candidatos por [priority desc, comprimento do padrão desc]. A
 * maioria dos casos resolve-se só pelo comprimento ("Mandalorian" 11 > "Star Wars" 9),
 * mas onde o padrão certo é MAIS CURTO que o errado é preciso `priority` explícita:
 *
 * - X-Men (5) tem de vencer Avengers (8)          → x-men.priority = 10
 * - Spider-Man / The Mandalorian: priority 10 na mesma, por segurança e para tornar a
 *   intenção explícita mesmo que o comprimento já os favoreça.
 *
 * Notas da spec que NÃO precisam de entrada aqui:
 * - Boruto antes de Naruto: mesma entrada (naruto), resolve-se pelo sort por comprimento.
 * - Kimetsu no Yaiba antes de Demon Slayer: aliases da mesma entrada (demon-slayer).
 * - Super Mario antes de "Mario": não há universo "Mario"; os padrões já são
 *   "Super Mario"/"Mario Bros", nunca "Mario" isolado.
 */
export const FRANCHISE_PRECEDENCE = [
  { winner: "x-men", over: "avengers", reason: "padrão 'X-Men' (5) é mais curto que 'Avengers' (8)" },
  { winner: "spider-man", over: "avengers", reason: "produto de personagem não deve cair no universo de equipa" },
  { winner: "the-mandalorian", over: "star-wars", reason: "peças do Mandalorian/Grogu não são Star Wars genérico" },
];

/** Cria a ≥ este nº de produtos (catálogo completo, não stock). */
export const UNIVERSE_COLLECTION_THRESHOLD = 10;
/** Histerese: só remove a coleção quando cai a ≤ este nº. Uma franquia que caia para 2–9
 *  mantém a página (evita piscar com a rotação de stock em dropshipping). */
export const UNIVERSE_COLLECTION_FLOOR = 1;
/** templateSuffix aplicado à coleção Universe via CollectionInput. */
export const UNIVERSE_TEMPLATE_SUFFIX = "universe-room";

/** @param {string} handle */
export function getUniverseByHandle(handle) {
  return FRANCHISE_UNIVERSES.find((u) => u.handle === handle) || null;
}

/** @param {string} name */
export function getUniverseByName(name) {
  const n = String(name || "").trim().toLowerCase();
  return FRANCHISE_UNIVERSES.find((u) => u.name.toLowerCase() === n) || null;
}
