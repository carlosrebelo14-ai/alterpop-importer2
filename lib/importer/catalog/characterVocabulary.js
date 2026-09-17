/**
 * Vocabulário de personagens — anexo ao briefing backend, entregue pelo Carlos a
 * 15/09/2026. Lista fechada por universo, escolhida por procura de figuras, não por
 * fama geral. Entrada para a medição do B4 (scripts/catalog/character-vocabulary-census.js)
 * e, mais tarde, para B7 (vocabulário fechado que alimenta a 4.ª camada do resolver).
 *
 * Universos verificados um a um contra o `name` de FRANCHISE_UNIVERSES — os 31 originais
 * batem exatamente (incluindo "Pokémon" acentuado e "Spy × Family" com o sinal de
 * multiplicação, não a letra x). Sem isso "Dentro do universo" comparava contra um nome
 * que nunca aparece em `resolvedFranchise` e dava tudo "fora" por engano de grafia, não
 * por colisão real. ADENDA 1 (17/09/2026) juntou Star Wars, Dragon Ball e Batman — os 15
 * nomes do piloto de 14/09 (PR #71), medidos mas nunca integrados pelo PR #73 — 34
 * universos ao todo.
 *
 * Correções já aplicadas à lista original (ver briefing):
 *  - Zelda: "Princess Zelda" removido (duplicado de "Zelda"); "Majora's Mask" removido
 *    (título de jogo/objeto, não personagem). Fica só Link, Zelda, Ganondorf.
 *  - Wednesday: "Thing" removido da lista principal — fica só na lista de risco
 *    (THING_UNIVERSO_ORIGEM regista de onde veio, só para a medição saber contra que
 *    universo comparar).
 *  - Spider-Man: "Peter Parker" deixa de ser nome próprio, passa a alias.
 *
 * Regra do nome de embalagem — o feed usa o nome impresso na caixa, não o nome civil.
 * Levi, Deku, Gojo são nomes de caixa e ficam como estão, sem alias.
 *
 * "Character" não é só humano — RX-78-2, EVA-01, Battle Cat, Pochita, Scrump entram
 * pelo mesmo caminho que Luffy ou Mickey. Sem tipo de entidade novo.
 */

/** @typedef {{ universo: string, nomes: string[] }} CharacterVocabularyEntry */

/** @type {CharacterVocabularyEntry[]} */
export const CHARACTER_VOCABULARY = [
  // --- Anime ---
  { universo: "Attack on Titan", nomes: ["Levi", "Eren", "Mikasa", "Armin", "Reiner"] },
  { universo: "Chainsaw Man", nomes: ["Denji", "Makima", "Power", "Aki", "Pochita"] },
  { universo: "Demon Slayer", nomes: ["Tanjiro", "Nezuko", "Rengoku", "Giyu", "Zenitsu"] },
  { universo: "Evangelion", nomes: ["Rei Ayanami", "Asuka", "Shinji", "EVA-01", "Misato"] },
  { universo: "Gundam", nomes: ["RX-78-2", "Char's Zaku II", "Gundam Barbatos", "Unicorn Gundam", "Nu Gundam"] },
  { universo: "Jujutsu Kaisen", nomes: ["Gojo", "Sukuna", "Yuji", "Megumi", "Nobara"] },
  { universo: "My Hero Academia", nomes: ["Deku", "Bakugo", "Todoroki", "All Might", "Uraraka"] },
  { universo: "Naruto", nomes: ["Naruto", "Sasuke", "Kakashi", "Itachi", "Gaara"] },
  { universo: "One Piece", nomes: ["Luffy", "Zoro", "Nami", "Sanji", "Ace"] },
  { universo: "Spy × Family", nomes: ["Anya", "Yor", "Loid", "Bond"] },
  { universo: "Studio Ghibli", nomes: ["Totoro", "Chihiro", "No-Face", "Howl", "Kiki"] },

  // --- Super-heróis ---
  { universo: "Avengers", nomes: ["Iron Man", "Captain America", "Thor", "Hulk", "Black Widow"] },
  { universo: "Spider-Man", nomes: ["Spider-Man", "Miles Morales", "Venom", "Gwen Stacy", "Spider-Man 2099"] },
  { universo: "Superman", nomes: ["Superman", "Supergirl", "Lex Luthor", "Lois Lane", "Bizarro"] },
  { universo: "X-Men", nomes: ["Wolverine", "Magneto", "Deadpool", "Cyclops", "Jean Grey"] },

  // --- Cinema e TV ---
  { universo: "Harry Potter", nomes: ["Harry", "Hermione", "Ron", "Voldemort", "Dumbledore"] },
  { universo: "Stranger Things", nomes: ["Eleven", "Vecna", "Demogorgon", "Hopper", "Steve"] },
  { universo: "The Lord of the Rings", nomes: ["Gandalf", "Aragorn", "Frodo", "Legolas", "Gollum"] },
  { universo: "Wednesday", nomes: ["Wednesday", "Enid", "Morticia", "Tyler"] },

  // --- Videojogos ---
  { universo: "Pokémon", nomes: ["Pikachu", "Charizard", "Mewtwo", "Eevee", "Gengar"] },
  { universo: "Sonic the Hedgehog", nomes: ["Sonic", "Shadow", "Tails", "Knuckles", "Amy"] },
  { universo: "Super Mario", nomes: ["Mario", "Luigi", "Peach", "Bowser", "Yoshi"] },
  { universo: "The Legend of Zelda", nomes: ["Link", "Zelda", "Ganondorf"] },

  // --- Disney e família ---
  { universo: "Frozen", nomes: ["Elsa", "Anna", "Olaf", "Kristoff", "Sven"] },
  { universo: "Mickey & Friends", nomes: ["Mickey", "Minnie", "Donald", "Goofy"] },
  { universo: "Stitch", nomes: ["Stitch", "Angel", "Lilo", "Scrump"] },
  { universo: "Toy Story", nomes: ["Woody", "Buzz Lightyear", "Jessie", "Bo Peep", "Rex"] },

  // --- Clássicos de brinquedo ---
  { universo: "G.I. Joe", nomes: ["Snake Eyes", "Storm Shadow", "Duke", "Cobra Commander", "Scarlett"] },
  { universo: "Masters of the Universe", nomes: ["He-Man", "Skeletor", "She-Ra", "Battle Cat", "Teela"] },
  { universo: "TMNT", nomes: ["Leonardo", "Raphael", "Donatello", "Michelangelo", "Shredder"] },
  { universo: "Transformers", nomes: ["Optimus Prime", "Bumblebee", "Megatron", "Starscream", "Soundwave"] },

  // --- ADENDA 1 (17/09/2026) — os 15 nomes do piloto de 14/09 (PR #71), nunca
  // integrados pelo PR #73. Nomes e aliases copiados tal como medidos no censo
  // (scripts/catalog/manufacturer-character-census.js), exceto Din Djarin: o alias
  // "The Mandalorian" sai daqui (colisão com a Line e a série — 153 produtos medidos
  // no PR #71 que não são o personagem). Fica só "Din Djarin" e "Mando".
  { universo: "Star Wars", nomes: ["Darth Vader", "Luke Skywalker", "Ahsoka Tano", "Grogu", "Din Djarin"] },
  { universo: "Dragon Ball", nomes: ["Goku", "Vegeta", "Gohan", "Frieza", "Piccolo"] },
  // Correção 17/09: Batman entra como Character (decisão do Carlos, contra a régua dos
  // epónimos — ver EPONYM_OVERRIDES). Joker/Harley Quinn/Catwoman ficam registados aqui
  // com passagem B (ver secção 4 do arranque); a passagem B em si é trabalho à parte.
  { universo: "Batman", nomes: ["Batman", "Joker", "Harley Quinn", "Catwoman", "Robin"] },
];

/** Nome próprio -> aliases medidos JUNTOS com ele (regra do nome de embalagem: o feed
 *  às vezes usa o nome civil em vez do nome de caixa). */
export const CHARACTER_ALIASES = {
  "Spider-Man": ["Peter Parker"],
  // ADENDA 1 — copiados do censo do PR #71. "The Mandalorian" fica de fora do Din
  // Djarin (colisão com a Line, ver nota acima do universo Star Wars).
  "Ahsoka Tano": ["Ahsoka"],
  "Grogu": ["Baby Yoda", "The Child"],
  "Din Djarin": ["Mando"],
  "Frieza": ["Freezer"],
};

/** Passagem A e B (secção 4 do arranque, 17/09/2026) — os 10 nomes onde a Passagem B
 *  (fora deste trabalho) também está aprovada. Todos os outros nomes do vocabulário só
 *  têm Passagem A aprovada. */
export const PASSAGEM_B_NAMES = [
  "Joker", "Harley Quinn", "Catwoman", "Captain America", "Hulk",
  "Venom", "Thor", "Wolverine", "Supergirl", "Goofy",
];

/**
 * Nomes de risco alto (mesma classe do Robin — briefing 15/09, B4 original): palavra
 * comum, ou colisão previsível com o nome do próprio universo. Medir com atenção
 * redobrada. Regra do Carlos: se o padrão repetir o de Robin — mais "fora do universo"
 * do que "dentro" — o nome sai do vocabulário e não entra na passagem B de B7.
 *
 * 14 dos 15 já estão em CHARACTER_VOCABULARY num universo concreto (a medição normal já
 * os cobre; aqui só marca a bandeira de risco sobre o mesmo resultado). "Thing" é a
 * exceção — foi removido da lista principal, mede-se à parte.
 */
export const HIGH_RISK_NAMES = [
  "Thing", "Angel", "Bond", "Power", "Rex", "Duke", "Scarlett",
  "Shadow", "Amy", "Link", "Peach", "Zelda", "Steve", "Ace", "Howl",
];

/** "Thing" não está em nenhum universo de CHARACTER_VOCABULARY (removido de Wednesday).
 *  Guardado só para a medição saber contra que universo comparar Dentro/Fora. */
export const THING_UNIVERSO_ORIGEM = "Wednesday";

/**
 * Epónimos — nomes onde o personagem dá nome à própria franquia (briefing 15/09,
 * revisão do Harry). Régua própria, medível: se "Dentro do universo" para o nome for
 * >= EPONYM_LIMIAR_PCT do total do universo, a página do personagem duplicaria a sala
 * do universo — sai do vocabulário. Não é automático (o Batman pode não bater o
 * limiar, por ter Joker/Harley Quinn/Catwoman a partilhar a sala); mede-se caso a caso,
 * como o resto.
 */
export const EPONYM_LIMIAR_PCT = 80;

/** @type {Array<{ nome: string, universo: string, aliases?: string[] }>} */
export const EPONYM_CANDIDATES = [
  { nome: "Harry", universo: "Harry Potter" },
  { nome: "Batman", universo: "Batman" },
  { nome: "Superman", universo: "Superman" },
  { nome: "Sonic", universo: "Sonic the Hedgehog" },
  { nome: "Mario", universo: "Super Mario" },
  { nome: "Naruto", universo: "Naruto" },
  { nome: "Wednesday", universo: "Wednesday" },
  { nome: "Stitch", universo: "Stitch" },
  { nome: "Spider-Man", universo: "Spider-Man", aliases: ["Peter Parker"] },
  { nome: "Zelda", universo: "The Legend of Zelda" },
];

/**
 * Exceções à régua dos epónimos (EPONYM_LIMIAR_PCT) — nomes que a régua excluiria mas
 * que o Carlos decidiu manter, com a data da decisão. Correção 17/09/2026: Batman entra
 * como Character mesmo cobrindo 93,7% da sala Batman no catálogo. A régua continua a
 * valer sem exceção para os outros 8 candidatos (Harry, Superman, Sonic, Mario, Naruto,
 * Wednesday, Stitch, Zelda) e para Spider-Man (que já fica por não bater o limiar).
 * @type {Array<{ nome: string, decisao: string }>}
 */
export const EPONYM_OVERRIDES = [
  { nome: "Batman", decisao: "2026-09-17" },
];
