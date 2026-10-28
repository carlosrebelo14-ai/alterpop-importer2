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
/**
 * Handles de metaobject `character` já existentes na loja (snapshot da Admin API, 28/10/2026).
 * Regra (decisão do arquiteto, 28/10/2026): se o nome principal ou um alias gerar um destes
 * handles, o handle existente ganha. Caso contrário, handle = slug do nome principal.
 * Inclui qa-dead-ref (DRAFT, excluído dos invariantes).
 */
export const HANDLES_EXISTENTES = Object.freeze([
  "luffy", "luke-skywalker", "qa-dead-ref", "frodo", "gandalf", "goku", "vegeta", "darth-vader",
  "grogu", "aragorn", "gollum", "ahsoka-tano", "legolas", "arwen", "balrog", "boromir", "elrond",
  "eowyn", "faramir", "gimli", "lurtz", "merry", "mouth-of-sauron", "pippin", "sam", "saruman",
  "sauron", "witch-king",
]);

export const CHARACTER_VOCABULARY = [
  { universo: "Attack on Titan", nomes: ["Eren Jaeger", "Mikasa Ackerman", "Armin Arlert", "Levi", "Sasha Braus", "Reiner Braun", "Zeke Jaeger", "Annie Leonhart", "Porco Galliard"] },
  { universo: "Jujutsu Kaisen", nomes: ["Yuji Itadori", "Megumi Fushiguro", "Nobara Kugisaki", "Satoru Gojo", "Suguru Geto", "Yuta Okkotsu", "Sukuna", "Choso", "Naoya Zen'in", "Fumihiko Takaba"] },
  { universo: "TMNT", nomes: ["Leonardo", "Donatello", "Michelangelo", "Raphael", "Splinter"] },
  { universo: "Demon Slayer", nomes: ["Tanjiro Kamado", "Nezuko Kamado", "Inosuke Hashibira", "Zenitsu Agatsuma", "Kyojuro Rengoku", "Mitsuri Kanroji", "Muichiro Tokito", "Gyomei Himejima", "Tengen Uzui", "Giyu Tomioka", "Shinobu Kocho", "Akaza", "Doma", "Daki", "Tamayo", "Muzan Kibutsuji", "Kaigaku"] },
  { universo: "Dragon Ball", nomes: ["Goku", "Vegeta", "Gohan", "Frieza", "Piccolo", "Cell", "Majin Buu", "Trunks", "Android 17", "Android 18", "Broly", "Krillin", "Bulma", "Gogeta", "Vegito", "Master Roshi", "Goku Black", "Beerus", "Ginyu", "Panzy", "Bardock"] },
  { universo: "Sonic the Hedgehog", nomes: ["Sonic", "Tails", "Knuckles", "Amy Rose", "Shadow", "Dr. Eggman"] },
  { universo: "Spy × Family", nomes: ["Anya Forger", "Loid Forger", "Yor Forger", "Bond Forger"] },
  { universo: "Stranger Things", nomes: ["Eleven", "Max Mayfield", "Will Byers", "Dustin Henderson", "Eddie Munson", "Lucas Sinclair", "Mike Wheeler", "Vecna", "Steve Harrington", "Jim Hopper", "Robin Buckley", "Nancy Wheeler", "Holly Wheeler", "Murray", "Alexei", "Billy Hargrove", "Demogorgon", "Erica Sinclair"] },
  { universo: "Star Wars", nomes: ["Darth Vader", "Luke Skywalker", "Ahsoka Tano", "Grogu", "Din Djarin", "Obi-Wan Kenobi", "Darth Maul", "Boba Fett", "Anakin Skywalker", "Chewbacca", "Emperor Palpatine", "Yoda", "Han Solo", "Leia Organa", "R2-D2", "C-3PO", "Kylo Ren", "Rey", "Bo-Katan Kryze", "Count Dooku", "Jango Fett", "Greedo", "Saw Gerrera", "Cassian Andor", "Moff Gideon", "IG-12", "Arc Trooper Jesse", "Osha Aniseya", "Jedi Master Indara", "Jedi Master Sol", "Qimir", "Marrok", "Merrin"] },
  { universo: "The Lord of the Rings", nomes: ["Frodo", "Gandalf", "Aragorn", "Gollum", "Legolas", "Gimli", "Boromir", "Merry", "Pippin", "Sam", "Sauron", "Saruman", "Éowyn", "Éomer", "Arwen", "Elrond", "Faramir", "Witch-King", "Balrog", "Lurtz", "Mouth of Sauron", "Thranduil", "Bilbo Baggins"] },
  { universo: "G.I. Joe", nomes: ["Snake Eyes", "Storm Shadow", "Duke", "Cobra Commander", "Destro", "Scarlett", "Baroness", "Roadblock"] },
  { universo: "My Hero Academia", nomes: ["Izuku Midoriya", "Katsuki Bakugo", "Shoto Todoroki", "Ochaco Uraraka", "All Might", "Himiko Toga", "Tomura Shigaraki", "Dabi", "All For One", "Nejire Hado", "Toru Hagakure", "Eijiro Kirishima", "Hawks", "Kurogiri", "Kyoka Jiro", "Fumikage Tokoyami", "Momo Yaoyorozu", "Mr. Compress"] },
  { universo: "Mickey & Friends", nomes: ["Mickey Mouse", "Minnie Mouse", "Donald Duck", "Daisy Duck", "Goofy", "Pluto"] },
  { universo: "X-Men", nomes: ["Wolverine", "Cyclops", "Nightcrawler", "Gambit", "Storm", "Jean Grey", "Rogue", "Magneto", "Beast", "Professor X", "Deadpool", "Husk", "Fabian Cortez", "Archangel", "Jubilee", "X-23", "Apocalypse", "Bastion", "Nimrod"] },
  { universo: "Super Mario", nomes: ["Mario", "Luigi", "Princess Peach", "Bowser", "Bowser Jr", "Yoshi", "Toad", "Rosalina", "Donkey Kong", "Wario"] },
  { universo: "Superman", nomes: ["Superman", "Lex Luthor", "Lois Lane", "Krypto", "Supergirl", "Mr. Terrific", "Metamorpho"] },
  { universo: "Gundam", nomes: ["RX-78-2", "Unicorn Gundam", "Strike Freedom", "Freedom Gundam", "GQuuuuuuX", "Nu Gundam", "Crossbone Gundam", "Char Aznable", "Lacus Clyne", "Cagalli Yula Athha", "Athrun Zala", "Miorine Rembran", "Shuji Ito"] },
  { universo: "Spider-Man", nomes: ["Spider-Man", "Miles Morales", "Venom", "Kingpin", "Green Goblin", "Doctor Octopus", "Gwen Stacy", "Carnage", "Scarlet Spider", "Mysterio"] },
  { universo: "Frozen", nomes: ["Elsa", "Anna", "Olaf", "Kristoff", "Sven"] },
  { universo: "Harry Potter", nomes: ["Harry Potter", "Hermione Granger", "Ron Weasley", "Albus Dumbledore", "Severus Snape", "Lord Voldemort", "Bellatrix Lestrange", "Sirius Black", "Luna Lovegood", "Remus Lupin", "Dobby", "Hedwig", "Lucius Malfoy", "Draco Malfoy", "Rubeus Hagrid"] },
  { universo: "Pokémon", nomes: ["Pikachu", "Pichu", "Charmander", "Charizard", "Squirtle", "Bulbasaur", "Mewtwo", "Mew", "Eevee", "Glaceon", "Vaporeon", "Flareon", "Espeon", "Greninja", "Lucario", "Mimikyu", "Morpeko", "Scorbunny", "Grookey", "Oshawott", "Cubone", "Arcanine", "Snorlax", "Gengar", "Jigglypuff"] },
  { universo: "Avengers", nomes: ["Iron Man", "Captain America", "Thor", "Hulk", "Black Widow", "Yelena Belova", "Hawkeye", "Black Panther", "Doctor Strange", "Scarlet Witch", "Vision", "Ant-Man", "Loki", "Thanos", "Doctor Doom", "Magneto", "Cyclops"] },
  { universo: "Transformers", nomes: ["Optimus Prime", "Optimus Primal", "Megatron", "Bumblebee", "Starscream", "Soundwave", "Grimlock", "Wheeljack", "Mirage", "Prowl", "Thundercracker", "Thrust", "Blackarachnia"] },
  { universo: "Toy Story", nomes: ["Woody", "Buzz Lightyear", "Jessie", "Bullseye", "Rex", "Slinky Dog", "Aliens", "Hamm", "Mr. Potato Head", "Lotso", "Andy", "Al", "Sid"] },
  { universo: "Stitch", nomes: ["Stitch", "Angel", "Lilo", "Scrump", "Leroy", "Splodyhead"] },
  { universo: "Wednesday", nomes: ["Wednesday Addams", "Enid Sinclair", "Bianca Barclay", "Morticia Addams", "Pugsley", "Thing", "Marilyn Thornhill", "Agnes DeMille", "Tyler Galpin"] },
  { universo: "Naruto", nomes: ["Naruto Uzumaki", "Sasuke Uchiha", "Itachi Uchiha", "Kakashi Hatake", "Madara Uchiha", "Orochimaru", "Hidan", "Kakuzu", "Gaara", "Kurama", "Sakura Haruno", "Jiraiya", "Minato Namikaze", "Pain", "Deidara", "Kisame Hoshigaki", "Obito Uchiha", "Iruka Umino", "Temari", "Rock Lee", "Zetsu", "Hashirama Senju", "Might Guy", "Hinata Hyuga"] },
  { universo: "Evangelion", nomes: ["Shinji Ikari", "Rei Ayanami", "Asuka Langley", "Misato Katsuragi", "Pen Pen", "EVA-01", "Kaworu Nagisa"] },
  { universo: "Batman", nomes: ["Batman", "Joker", "Harley Quinn", "Catwoman", "Robin", "Batman Beyond", "Azrael", "Batgirl", "Nightwing", "Penguin", "Riddler", "Two-Face", "Bane", "Poison Ivy", "Alfred", "Batmobile", "Hush"] },
  { universo: "Masters of the Universe", nomes: ["He-Man", "Skeletor", "Battle Cat", "Man-At-Arms", "Teela", "Orko", "Sy-Klone", "Evil-Lyn", "Trap Jaw", "She-Ra", "Sorceress"] },
  { universo: "One Piece", nomes: ["Monkey D. Luffy", "Roronoa Zoro", "Nami", "Usopp", "Sanji", "Tony Tony Chopper", "Nico Robin", "Franky", "Brook", "Jinbe", "Trafalgar Law", "Sabo", "Portgas D. Ace", "Shanks", "Boa Hancock", "Yamato", "Kaido", "Jewelry Bonney", "Bepo", "Big Mom", "Rob Lucci", "Edward Newgate", "Monkey D. Garp"] },
  { universo: "Chainsaw Man", nomes: ["Denji", "Pochita", "Power", "Makima", "Aki Hayakawa", "Reze", "Angel Devil", "Kobeni"] },
];

/** Nome próprio -> aliases medidos JUNTOS com ele (regra do nome de embalagem: o feed
 *  às vezes usa o nome civil em vez do nome de caixa). */
export const CHARACTER_ALIASES = {
  "Agnes DeMille": ["Agnes Demille"],
  "Ahsoka Tano": ["Ahsoka"],
  "Bo-Katan Kryze": ["Bo-Katan"],
  "Albus Dumbledore": ["Dumbledore"],
  "Aliens": ["Alien"],
  "Amy Rose": ["Amy"],
  "Annie Leonhart": ["Annie Titan"],
  "Aragorn": ["Aragon"],
  "Armin Arlert": ["Armin Arlelt"],
  "Asuka Langley": ["Asuka Shikinami Langley", "Asuka Langlay Soryu"],
  "Batman Beyond": ["Terry McGinnis"],
  "Billy Hargrove": ["Flayed Billy"],
  "Bond Forger": ["Bond"],
  "Buzz Lightyear": ["Lightyear Buzz"],
  "Cell": ["Perfect Cell"],
  "Crossbone Gundam": ["Crossbone"],
  "Din Djarin": ["Mando"],
  "Doctor Octopus": ["Doc Ock"],
  "Donald Duck": ["Pato Donald"],
  "Dr. Eggman": ["Eggman"],
  "Dustin Henderson": ["Dustin"],
  "EVA-01": ["Test Type-01"],
  "Eddie Munson": ["Eddie"],
  "Elrond": ["Lord Elrond"],
  "Emperor Palpatine": ["Palpatine"],
  "Eren Jaeger": ["Eren", "Eren Jeager", "Eren Titan"],
  "Frieza": ["Freezer"],
  "Goku": ["Son Goku"],
  "Grogu": ["Baby Yoda", "The Child", "Yoda the Child"],
  "Gwen Stacy": ["Spider-Gwen", "Ghost-Spider", "Ghost Spider"],
  "Harry Potter": ["Harry"],
  "He-Man": ["Prince Adam"],
  "Hermione Granger": ["Hermione"],
  "Holly Wheeler": ["Holly"],
  "Itachi Uchiha": ["Itachi"],
  "Izuku Midoriya": ["Deku"],
  "Jim Hopper": ["Hopper"],
  "Kakashi Hatake": ["Kakashi", "Hatake Kakashi"],
  "Legolas": ["Grennleaf"],
  "Leia Organa": ["Princess Leia", "Leia"],
  "Lord Voldemort": ["Voldemort"],
  "Lucas Sinclair": ["Lucas"],
  "Majin Buu": ["Buu", "Kid Buu"],
  "Max Mayfield": ["Max"],
  "Megumi Fushiguro": ["Fushiguro Megumi"],
  "Merry": ["Merry Brandybuck"],
  "Mickey Mouse": ["Mickey"],
  "Mikasa Ackerman": ["Mikasa Ackermann"],
  "Mike Wheeler": ["Mike"],
  "Minato Namikaze": ["Minato"],
  "Minnie Mouse": ["Minnie"],
  "Miorine Rembran": ["Miorine"],
  "Monkey D. Luffy": ["Luffy", "Monkey D Luffy"],
  "Morticia Addams": ["Morticia"],
  "Mr. Terrific": ["Mr Terrific"],
  "Naoya Zen'in": ["Zen'in Naoya"],
  "Naruto Uzumaki": ["Naruto", "Uzumaki"],
  "Nezuko Kamado": ["Nezuko"],
  "Nobara Kugisaki": ["Nobara"],
  "Nu Gundam": ["RX-93"],
  "Ochaco Uraraka": ["Ochaco Urakana"],
  "Pen Pen": ["Penpen"],
  "Pippin": ["Peregrin Took"],
  "Porco Galliard": ["Jaw Titan"],
  "Portgas D. Ace": ["Ace"],
  "Princess Peach": ["Peach"],
  "Rei Ayanami": ["Rey Ayanami", "Ayanami"],
  "Reiner Braun": ["Armored Titan"],
  "Robin Buckley": ["Robin"],
  "Ron Weasley": ["Ron Weasly"],
  "Roronoa Zoro": ["Zoro"],
  "Rubeus Hagrid": ["Hagrid"],
  "Sam": ["Samwise Gamgee"],
  "Sasuke Uchiha": ["Sasuke"],
  "Satoru Gojo": ["Gojo"],
  "Severus Snape": ["Snape"],
  "Slinky Dog": ["Slinky"],
  "Sorceress": ["Hechicera"],
  "Spider-Man": ["Spiderman", "Peter Parker"],
  "Splinter": ["Splienter"],
  "Steve Harrington": ["Steve"],
  "Stitch": ["Experiment 626"],
  "Sukuna": ["Ryomen Sukuna"],
  "Tanjiro Kamado": ["Tanjiro"],
  "Tony Tony Chopper": ["Chopper"],
  "Unicorn Gundam": ["Unicorn"],
  "Wednesday Addams": ["Wednesday"],
  "Will Byers": ["Will"],
  "Witch-King": ["Witch King"],
  "Yelena Belova": ["Yelena"],
  "Yuta Okkotsu": ["Okkotsu Yuta"],
  "Zeke Jaeger": ["Beast Titan"],
  "Éomer": ["Eomer"],
  "Éowyn": ["Eowyn"],
  "Frodo": ["Frodo Baggins"],
  "Darth Maul": ["Maul"],
  "Luke Skywalker": ["Luke"],
  "Gohan": ["Gohan Beast"],
  "Piccolo": ["Orange Piccolo"],
  "Arc Trooper Jesse": ["Jesse"],
  "Fumikage Tokoyami": ["Tokoyami"],
  "Jedi Master Indara": ["Indara"],
  "Jedi Master Sol": ["Sol"],
  "Qimir": ["The Stranger"],
  "Jewelry Bonney": ["Bonney"],
  "Edward Newgate": ["Whitebeard"],
  "Monkey D. Garp": ["Garp"],
  "Mr. Compress": ["Mr Compress"],
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
export const EPONYM_CANDIDATES = [];

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
