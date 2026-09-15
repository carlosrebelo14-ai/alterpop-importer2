/**
 * Vocabulário de personagens — anexo ao briefing backend, entregue pelo Carlos a
 * 15/09/2026. Lista fechada por universo, escolhida por procura de figuras, não por
 * fama geral. Entrada para a medição do B4 (scripts/catalog/character-vocabulary-census.js)
 * e, mais tarde, para B7 (vocabulário fechado que alimenta a 4.ª camada do resolver).
 *
 * Universos verificados um a um contra o `name` de FRANCHISE_UNIVERSES — os 31 batem
 * exatamente (incluindo "Pokémon" acentuado e "Spy × Family" com o sinal de
 * multiplicação, não a letra x). Sem isso "Dentro do universo" comparava contra um nome
 * que nunca aparece em `resolvedFranchise` e dava tudo "fora" por engano de grafia, não
 * por colisão real.
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
];

/** Nome próprio -> aliases medidos JUNTOS com ele (regra do nome de embalagem: o feed
 *  às vezes usa o nome civil em vez do nome de caixa). */
export const CHARACTER_ALIASES = {
  "Spider-Man": ["Peter Parker"],
};

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
