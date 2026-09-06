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
 * - estRange       [low, high] — ESTIMATIVA por título sobre 5575 produtos a 2026-09-05.
 *                  Onde a spec dava "a+b", os dois números são contagens de padrões que
 *                  se sobrepõem (o mesmo produto conta nos dois) — a união real está
 *                  entre max(a,b) e a+b. O número real sai do report mode.
 * - active         true = 10+ produtos, cria coleção já. false = dormente: definido mas
 *                  sem coleção até cruzar o limiar (aparece sozinho, sem alteração de código).
 * - priority       desempate na camada 2 quando um padrão curto deste universo tem de
 *                  vencer um padrão mais longo de outro (ver FRANCHISE_PRECEDENCE). 0 default.
 */

/** @typedef {{ name: string, handle: string, refs: string[], titlePatterns: string[], estRange: [number, number], active: boolean, priority?: number }} FranchiseUniverse */

/** @type {FranchiseUniverse[]} */
export const FRANCHISE_UNIVERSES = [
  { name: "Pokémon", handle: "pokemon", refs: ["Pokemon"], titlePatterns: ["Pokemon", "Pokémon"], estRange: [112, 112], active: true },
  { name: "Star Wars", handle: "star-wars", refs: ["Star Wars", "Bobafett"], titlePatterns: ["Star Wars", "Sar Wars"], estRange: [246, 246], active: true },
  { name: "Spider-Man", handle: "spider-man", refs: ["Spider-man"], titlePatterns: ["Spider-Man", "Spiderman", "Spider Man"], estRange: [116, 116], active: true, priority: 10 },
  { name: "One Piece", handle: "one-piece", refs: ["One Piece", "Onepiece"], titlePatterns: ["One Piece"], estRange: [379, 379], active: true },
  { name: "Gundam", handle: "gundam", refs: ["Gundam"], titlePatterns: ["Gundam", "Mobile Suit"], estRange: [23, 23], active: true },
  { name: "Dragon Ball", handle: "dragon-ball", refs: ["Dragon Ball"], titlePatterns: ["Dragon Ball", "Dragonball"], estRange: [263, 263], active: true },
  { name: "Batman", handle: "batman", refs: ["Batman"], titlePatterns: ["Batman"], estRange: [62, 62], active: true },
  { name: "Demon Slayer", handle: "demon-slayer", refs: ["Kimetsuno Yaiba"], titlePatterns: ["Demon Slayer", "Kimetsu no Yaiba"], estRange: [75, 138], active: true },
  { name: "Harry Potter", handle: "harry-potter", refs: ["Harry Potter", "Animales Fantásticos"], titlePatterns: ["Harry Potter", "Fantastic Beasts", "Hogwarts"], estRange: [144, 144], active: true },
  { name: "Mickey & Friends", handle: "mickey-and-friends", refs: ["Mickey", "Minnie", "Donald"], titlePatterns: ["Mickey", "Minnie", "Donald Duck"], estRange: [71, 138], active: true },
  { name: "Naruto", handle: "naruto", refs: ["Naruto", "Boruto"], titlePatterns: ["Boruto", "Naruto"], estRange: [222, 239], active: true },
  { name: "Jujutsu Kaisen", handle: "jujutsu-kaisen", refs: ["Jujutsu Kaisen"], titlePatterns: ["Jujutsu"], estRange: [17, 17], active: true },
  { name: "Transformers", handle: "transformers", refs: ["Transformers"], titlePatterns: ["Transformers"], estRange: [7, 7], active: false },
  { name: "Superman", handle: "superman", refs: ["Superman"], titlePatterns: ["Superman"], estRange: [45, 45], active: true },
  { name: "My Hero Academia", handle: "my-hero-academia", refs: ["My Hero Academia", "Myheroacademia"], titlePatterns: ["My Hero Academia"], estRange: [81, 81], active: true },
  { name: "The Mandalorian", handle: "the-mandalorian", refs: ["Mandalorian"], titlePatterns: ["Mandalorian", "Grogu", "Ahsoka"], estRange: [54, 82], active: true, priority: 10 },
  { name: "Wonder Woman", handle: "wonder-woman", refs: ["Wonderwoman"], titlePatterns: ["Wonder Woman"], estRange: [1, 1], active: false },
  { name: "Attack on Titan", handle: "attack-on-titan", refs: ["Attackontittan"], titlePatterns: ["Attack on Titan", "Shingeki"], estRange: [13, 13], active: true },
  { name: "TMNT", handle: "tmnt", refs: ["Tortugas Ninja"], titlePatterns: ["Ninja Turtles", "Tortugas Ninja", "TMNT"], estRange: [37, 37], active: true },
  { name: "Frozen", handle: "frozen", refs: ["Frozen"], titlePatterns: ["Frozen"], estRange: [14, 14], active: true },
  { name: "Sonic the Hedgehog", handle: "sonic", refs: ["Sonic"], titlePatterns: ["Sonic"], estRange: [42, 42], active: true },
  { name: "Super Mario", handle: "super-mario", refs: ["Mario Bros."], titlePatterns: ["Super Mario", "Mario Bros"], estRange: [14, 14], active: true },
  { name: "Stranger Things", handle: "stranger-things", refs: ["Strangerthings"], titlePatterns: ["Stranger Things"], estRange: [26, 26], active: true },
  { name: "The Legend of Zelda", handle: "zelda", refs: ["Zelda"], titlePatterns: ["Zelda", "Hyrule"], estRange: [1, 1], active: false },
  { name: "Avengers", handle: "avengers", refs: ["Los Vengadores"], titlePatterns: ["Avengers", "Vengadores"], estRange: [24, 24], active: true },
  { name: "X-Men", handle: "x-men", refs: ["Xmen"], titlePatterns: ["X-Men", "Xmen"], estRange: [24, 24], active: true, priority: 10 },
  // A maioria dos personagens Sanrio já casa pelo ref HELLOKITTY (Kuromi 393, Cinnamoroll
  // 66, My Melody 65…). Estes vinham com ref="MANGA" e ficavam vazios. Gudetama/
  // Aggretsuko/Little Twin Stars são Sanrio; Sumikko Gurashi e Rilakkuma são San-X, mas
  // o Carlos (2026-09-06) decidiu dobrá-los neste universo pela proximidade "kawaii mascot".
  { name: "Hello Kitty / Sanrio", handle: "hello-kitty", refs: ["Hello Kitty"],
    titlePatterns: ["Hello Kitty", "Sanrio", "Kuromi", "My Melody", "Gudetama",
      "Aggretsuko", "Little Twin Stars", "Sumikko Gurashi", "Rilakkuma"],
    estRange: [72, 72], active: true },
  { name: "Toy Story", handle: "toy-story", refs: ["Toystory"], titlePatterns: ["Toy Story"], estRange: [32, 32], active: true },
  { name: "Wednesday", handle: "wednesday", refs: ["Miercoles"], titlePatterns: ["Wednesday", "Addams"], estRange: [20, 20], active: true },
  { name: "Masters of the Universe", handle: "masters-of-the-universe", refs: ["Mastersofthe Universe"], titlePatterns: ["Masters of the Universe", "He-Man"], estRange: [15, 15], active: true },
  { name: "G.I. Joe", handle: "gi-joe", refs: ["Gijoe"], titlePatterns: ["G.I. Joe", "GI Joe"], estRange: [1, 1], active: false },
  { name: "Sailor Moon", handle: "sailor-moon", refs: ["Sailormoon"], titlePatterns: ["Sailor Moon"], estRange: [4, 4], active: false },
  { name: "Evangelion", handle: "evangelion", refs: ["Evangelion"], titlePatterns: ["Evangelion", "Neon Genesis"], estRange: [2, 2], active: false },
  // Ghibli não tem ref no feed — os filmes vêm com ref="MANGA" e o título é o nome do
  // filme, não "Ghibli". Padrões alargados aos títulos dos filmes (Carlos, 2026-09-06).
  // Cuidados: `Mononoke` sozinho colide com a série *Mononoke* (Kusuriuri) → só
  // "Princess Mononoke"; `Howl` é palavra comum → só "Howls Moving Castle". Apóstrofos
  // são normalizados para espaço, por isso os padrões vêm sem apóstrofo ("Kikis", "Howls").
  { name: "Studio Ghibli", handle: "studio-ghibli", refs: [], titlePatterns: [
      "Ghibli", "Totoro", "My Neighbor Totoro", "Spirited Away", "Princess Mononoke",
      "Porco Rosso", "Castle in the Sky", "Kikis Delivery Service", "Howls Moving Castle",
      "Ponyo", "Nausicaa", "Arrietty", "The Wind Rises", "Grave of the Fireflies",
    ], estRange: [0, 0], active: false },
  { name: "Chainsaw Man", handle: "chainsaw-man", refs: ["Chainsaw Man", "Chainsawman"], titlePatterns: ["Chainsaw Man"], estRange: [38, 38], active: true },
  { name: "Spy × Family", handle: "spy-family", refs: ["Spy Xfamily"], titlePatterns: ["Spy x Family", "Spy Family"], estRange: [17, 17], active: true },
  { name: "Final Fantasy", handle: "final-fantasy", refs: [], titlePatterns: ["Final Fantasy"], estRange: [0, 0], active: false },
  { name: "Resident Evil", handle: "resident-evil", refs: [], titlePatterns: ["Resident Evil", "Biohazard"], estRange: [0, 0], active: false },
  { name: "The Last of Us", handle: "the-last-of-us", refs: ["Lastofus"], titlePatterns: ["The Last of Us"], estRange: [4, 4], active: false },
  { name: "Stitch", handle: "stitch", refs: ["Stitch"], titlePatterns: ["Stitch", "Lilo"], estRange: [105, 105], active: true },
  // #41 — acrescentado a 2026-09-06 (Carlos). O feed dá o ref `EL SEÑOR DE LOS ANILLOS`
  // e NÃO separa O Hobbit: muitos títulos são "Hobbit El Señor de los Anillos …" sob o
  // mesmo ref/licença. Uma entrada só cobre as duas. Títulos chegam pós-tradução e
  // inconsistentes (uns "Lord of the Rings", outros ficam "El Señor de los Anillos"),
  // por isso os padrões cobrem ambas as grafias. ⚠️ handle a confirmar pelo Carlos
  // antes de publicar (SEO permanente — §3.4 do briefing).
  { name: "The Lord of the Rings", handle: "lord-of-the-rings",
    refs: ["El Señor de los Anillos"],
    titlePatterns: ["Lord of the Rings", "El Señor de los Anillos", "Senor de los Anillos"],
    estRange: [157, 157], active: true },
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
