/**
 * Texto de coleção Universe voltado para o cliente — B14 (briefing 16/09/2026).
 *
 * universeCollections.server.js gravava um placeholder interno em descriptionHtml
 * ("Coleção Universe — produtos com alterpop.franchise = ... Rascunho: confirmar e
 * publicar no Admin.") que ficou publicado em 21 coleções live; mais duas (Batman,
 * Toy Story) tinham o placeholder mais antigo de autoCollections.server.js
 * ("Coleção criada automaticamente..."). Nenhum dos dois foi escrito a pensar no
 * cliente. Este ficheiro é a fonte de texto real; o backfill de produção está em
 * scripts/maintenance/fix-universe-collection-descriptions.mjs.
 *
 * Chave = FRANCHISE_UNIVERSES[i].name (valor exato de alterpop.franchise). Cobre as
 * 39 entradas da tabela (ativas e dormentes) para que uma coleção futura nunca volte
 * a nascer com texto interno — ver fallback em buildUniverseDescriptionHtml abaixo.
 *
 * "The Mandalorian" não está aqui: deixou de ser universo (ENTREGA 2, 2026-09-10,
 * franchiseLines.js) e passou a Line dentro de Star Wars. A coleção fica de fora do
 * loop de universeCollections.server.js; o texto dela é escrito à parte pelo mesmo
 * script de backfill, só porque a coleção já existe na loja com o placeholder antigo.
 */

export const UNIVERSE_COLLECTION_COPY = {
  "Pokémon": "<p>Welcome to the Pokémon universe — where nostalgia meets gaming and collecting. Discover figures, TCG cards, plushies, lamps, decor and gaming accessories from every generation. For Trainers of all ages.</p>",
  "Star Wars": "<p>May the Force be with you! Explore the Star Wars universe with figures, t-shirts, accessories and collections of Darth Vader, Yoda, The Mandalorian and more. For Jedi and fans across every galaxy.</p>",
  "Spider-Man": "<p>With great power comes great responsibility! Explore the Spider-Man universe with figures, t-shirts, accessories and decor of Peter Parker, Miles Morales and the Spider-Verse. For web-slinging fans of every generation.</p>",
  "One Piece": "<p>I'm gonna be King of the Pirates! Explore the One Piece universe with figures, t-shirts, accessories and more from Luffy, Zoro, Nami and the whole Thousand Sunny crew. For fans of the most legendary anime of all time.</p>",
  "Gundam": "<p>Amuro, go! Explore the Gundam universe with model kits, figures and collectibles of the RX-78-2, Zaku and every mobile suit in between. For mecha fans and builders of every generation.</p>",
  "Dragon Ball": "<p>It's over 9000! Explore the Dragon Ball universe with figures, t-shirts, accessories and more from Goku, Vegeta, Gohan and Frieza. For fans of the anime that defined generations.</p>",
  "Batman": "<p>I'm Batman. Explore the Batman universe with figures, t-shirts, accessories and decor of the Dark Knight, Gotham City and his rogues' gallery. For fans of the Caped Crusader, from every generation.</p>",
  "Demon Slayer": "<p>Destroy demons in style! Explore the Demon Slayer universe with figures, t-shirts, accessories and more from Tanjiro, Nezuko, Zenitsu and the Hashira. For fans of the most visually stunning anime of the generation.</p>",
  "Harry Potter": "<p>Welcome to Hogwarts! Explore the magical world of Harry Potter with figures, t-shirts, accessories and decor inspired by the houses, characters and iconic moments of the saga. For fans of every generation.</p>",
  "Mickey & Friends": "<p>Oh boy! Explore the Mickey & Friends universe with figures, plushies, accessories and decor of Mickey, Minnie, Donald and the whole gang. For Disney fans of every generation.</p>",
  "Naruto": "<p>Dattebayo! Explore the Naruto universe with figures, t-shirts, accessories and more from Naruto, Sasuke, Kakashi and the members of the Akatsuki. For fans of the Hidden Leaf Village, from every generation.</p>",
  "Jujutsu Kaisen": "<p>Throughout Heaven and Earth, I alone am the honoured one! Explore the Jujutsu Kaisen universe with figures, t-shirts, accessories and more from Gojo, Itadori, Sukuna and Megumi. For fans of today's most intense sorcery-and-combat anime.</p>",
  "Transformers": "<p>Autobots, roll out! Explore the Transformers universe with figures, accessories and collectibles of Optimus Prime, Bumblebee and the battle between Autobots and Decepticons. For fans of every generation.</p>",
  "Superman": "<p>Up, up and away! Explore the Superman universe with figures, t-shirts, accessories and decor of the Man of Steel, Lois Lane and the Fortress of Solitude. For fans of the original superhero, from every generation.</p>",
  "My Hero Academia": "<p>Plus Ultra! Explore the My Hero Academia universe with figures, t-shirts, accessories and more from Deku, Bakugo, All Might and the students of U.A. High. For fans of the modern hero-anime classic.</p>",
  "Wonder Woman": "<p>For Themyscira! Explore the Wonder Woman universe with figures, t-shirts, accessories and decor of Diana Prince, the Amazons and the Lasso of Truth. For fans of DC's iconic hero.</p>",
  "Attack on Titan": "<p>Dedicate your heart! Explore the Attack on Titan universe with figures, t-shirts, accessories and more from Eren, Mikasa, Levi and the Scout Regiment. For fans of the anime that redefined the genre.</p>",
  "TMNT": "<p>Cowabunga! Explore the Teenage Mutant Ninja Turtles universe with figures, t-shirts, accessories and decor of Leonardo, Michelangelo, Donatello and Raphael. For fans of the heroes in a half shell.</p>",
  "Frozen": "<p>Let it go! Explore the Frozen universe with figures, plushies, accessories and decor of Elsa, Anna, Olaf and the kingdom of Arendelle. For Disney fans of every generation.</p>",
  "Sonic the Hedgehog": "<p>Gotta go fast! Explore the Sonic the Hedgehog universe with figures, plushies, accessories and decor of Sonic, Tails, Knuckles and friends. For fans of the fastest hedgehog alive.</p>",
  "Super Mario": "<p>Let's-a go! Explore the Super Mario universe with figures, plushies, accessories and decor of Mario, Luigi, Peach and Bowser. For fans of the Mushroom Kingdom, from every generation.</p>",
  "Stranger Things": "<p>Welcome to the Upside Down! Dive into the world of Stranger Things with t-shirts, figures, accessories and decor inspired by Eleven, the Demogorgon and Hawkins. For fans of the Netflix cult series.</p>",
  "The Legend of Zelda": "<p>It's dangerous to go alone! Explore The Legend of Zelda universe with figures, accessories and collectibles of Link, Zelda, Ganondorf and the realm of Hyrule. For fans of the legendary adventure saga.</p>",
  "Avengers": "<p>Avengers, assemble! Explore the Avengers universe with figures, t-shirts, accessories and decor of Iron Man, Captain America, Thor and Earth's Mightiest Heroes. For Marvel fans of every generation.</p>",
  "X-Men": "<p>Mutant and proud! Explore the X-Men universe with figures, t-shirts, accessories and decor of Wolverine, Storm, Cyclops and the students of Xavier's school. For fans of Marvel's mutant heroes.</p>",
  "Toy Story": "<p>To infinity and beyond! Explore the Toy Story universe with figures, plushies, accessories and decor of Woody, Buzz Lightyear and the whole gang. For Pixar fans of every generation.</p>",
  "Wednesday": "<p>Wednesday knows best. Explore the Wednesday universe with t-shirts, figures, accessories and decor inspired by the Addams family and the halls of Nevermore Academy. For fans of the hit Netflix series.</p>",
  "Masters of the Universe": "<p>I have the power! Explore the Masters of the Universe with figures, accessories and collectibles of He-Man, Skeletor and the warriors of Eternia. For fans of the classic 80s saga, from every generation.</p>",
  "G.I. Joe": "<p>A real American hero! Explore the G.I. Joe universe with figures, accessories and collectibles of Duke, Snake Eyes and the battle against Cobra. For fans of the classic action saga.</p>",
  "Sailor Moon": "<p>In the name of the Moon! Explore the Sailor Moon universe with figures, accessories and collectibles of Usagi, the Sailor Guardians and the fight against evil. For fans of the classic magical-girl anime.</p>",
  "Evangelion": "<p>Get in the robot! Explore the Evangelion universe with figures, accessories and collectibles of Shinji, Asuka, Rei and the NERV pilots. For fans of the genre-defining mecha anime.</p>",
  "Studio Ghibli": "<p>Welcome to a world of wonder. Explore the Studio Ghibli universe with figures, plushies, accessories and decor inspired by Totoro, Spirited Away and the studio's magical worlds. For fans of every generation.</p>",
  "Chainsaw Man": "<p>Make a contract with me! Explore the Chainsaw Man universe with figures, t-shirts, accessories and more from Denji, Pochita and Power. For fans of the new generation's most brutal, stylish anime.</p>",
  "Spy × Family": "<p>Operation Strix is a go! Explore the Spy × Family universe with figures, t-shirts, accessories and more from Loid, Yor, Anya and Bond. For fans of the hit spy-comedy anime.</p>",
  "Final Fantasy": "<p>The story never ends. Explore the Final Fantasy universe with figures, accessories and collectibles from Cloud, Sephiroth and every legendary entry in the saga. For fans of the genre-defining RPG series.</p>",
  "Resident Evil": "<p>Welcome to Raccoon City. Explore the Resident Evil universe with figures, accessories and collectibles of Leon, Jill and the survivors of the outbreak. For fans of the classic survival-horror saga.</p>",
  "The Last of Us": "<p>Endure and survive. Explore The Last of Us universe with figures, accessories and collectibles of Joel, Ellie and the world they fight to survive. For fans of the acclaimed post-apocalyptic saga.</p>",
  "Stitch": "<p>Ohana means family! Explore the Stitch universe with plushies, figures, accessories and decor of Lilo, Stitch and the whole ohana. For Disney fans of every generation.</p>",
  "The Lord of the Rings": "<p>One does not simply walk into Mordor! Explore The Lord of the Rings universe with figures, accessories and collectibles of Frodo, Gandalf, Aragorn and the Fellowship. For fans of Middle-earth, from every generation.</p>",
};

/** "The Mandalorian" deixou de ser universo — não entra no map acima. Só o backfill usa isto. */
export const MANDALORIAN_LINE_COPY =
  "<p>This is the Way. Explore The Mandalorian with figures, accessories and collectibles of Din Djarin, Grogu and the bounty hunters of the Outer Rim. For Star Wars fans of every generation.</p>";

/**
 * Fallback seguro para um universo sem cópia curada ainda — nunca menciona Admin,
 * rascunho, ou qualquer detalhe do fluxo interno.
 * @param {string} universeName
 */
export function buildUniverseDescriptionHtml(universeName) {
  return UNIVERSE_COLLECTION_COPY[universeName]
    || `<p>Discover the ${universeName} collection — figures, apparel, accessories and gifts curated for fans of every generation.</p>`;
}
