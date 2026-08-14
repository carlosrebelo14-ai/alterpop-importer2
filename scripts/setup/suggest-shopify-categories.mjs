#!/usr/bin/env node
/**
 * Fase A — sugestão de categorias oficiais da Shopify (Standard Product Taxonomy)
 * para os tipos de produto que já usamos no glossário (categories.json / titles.json).
 *
 * Só leitura: consulta `taxonomy { categories(search: ...) }` via GraphQL Admin API.
 * Não escreve nada na Shopify nem no taxonomy-map.json — gera um markdown com
 * até 3 candidatos por termo, para revisão humana (Fase B decide o mapeamento final).
 *
 * IMPORTANTE: a pesquisa da taxonomia corresponde ao texto LOCALIZADO das
 * categorias (no idioma da loja), não ao inglês — por isso os termos abaixo
 * estão em português (loja jyr17t-wr.myshopify.com usa PT).
 *
 * Uso: node scripts/setup/suggest-shopify-categories.mjs [shop]
 * Requer sessão OAuth já criada (abre a app no Admin pelo menos uma vez).
 */
import fs from "fs";
import path from "path";
import prisma from "../../app/db.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

/**
 * Termos a pesquisar na taxonomia, com o nosso conceito de origem (categories.json /
 * titles.json) para referência no output. Lista curada a partir dos ~50 tipos de
 * produto/categoria mais usados no catálogo real.
 */
const TERMS = [
  { ours: "Action Figures", search: "Figuras de ação" },
  { ours: "Figures & Statues", search: "Estatuetas" },
  { ours: "Mini Figures", search: "Miniaturas" },
  { ours: "Plush Toys", search: "Animais de peluche" },
  { ours: "Board Games", search: "Jogos de tabuleiro" },
  { ours: "Trading Cards", search: "Cartas colecionáveis" },
  { ours: "Trading Card Games", search: "Jogos de cartas" },
  { ours: "Video Games", search: "Videojogos" },
  { ours: "Books", search: "Livros" },
  { ours: "Comics", search: "Banda desenhada" },
  { ours: "Mugs", search: "Canecas" },
  { ours: "Apparel", search: "Vestuário" },
  { ours: "Footwear", search: "Calçado" },
  { ours: "School Supplies", search: "Material escolar" },
  { ours: "Home & Living", search: "Decoração" },
  { ours: "Toys", search: "Brinquedos" },
  { ours: "Games", search: "Jogos" },
  { ours: "Accessories", search: "Acessórios" },
  { ours: "Gifts", search: "Presentes" },
  { ours: "Replica", search: "Réplica" },
  { ours: "Money Box (Hucha)", search: "Mealheiro" },
  { ours: "Keychain (Llavero)", search: "Porta-chaves" },
  { ours: "Poster (Póster)", search: "Cartaz" },
  { ours: "Bag (Bolsa)", search: "Sacos" },
  { ours: "T-Shirt (Camiseta)", search: "T-shirts" },
  { ours: "Hoodie (Sudadera)", search: "Sweatshirts com capuz" },
  { ours: "Cap (Gorra)", search: "Bonés" },
  { ours: "Backpack (Mochila)", search: "Mochilas" },
  { ours: "Notebook (Cuaderno)", search: "Cadernos" },
  { ours: "Cushion (Cojín)", search: "Almofadas" },
  { ours: "Lamp (Lámpara)", search: "Candeeiros" },
  { ours: "Pencil Case (Estuche)", search: "Estojos" },
  { ours: "Watch (Reloj)", search: "Relógios" },
  { ours: "Wallet (Cartera)", search: "Carteiras" },
  { ours: "Water Bottle (Botella)", search: "Garrafas de água" },
  { ours: "Blanket (Manta)", search: "Cobertores" },
  { ours: "Towel (Toalla)", search: "Toalhas" },
  { ours: "Puzzle (Puzle)", search: "Puzzles" },
  { ours: "Pin", search: "Pins" },
  { ours: "Sticker (Pegatina)", search: "Autocolantes" },
  { ours: "Mouse Pad (Alfombrilla)", search: "Tapetes de rato" },
  { ours: "Costume (Disfraz)", search: "Disfarces" },
  { ours: "Mask (Máscara)", search: "Máscaras" },
  { ours: "Statue (Estatua)", search: "Estátuas" },
  { ours: "Model Kit (Maqueta)", search: "Modelismo" },
  { ours: "Suitcase (Maleta)", search: "Malas de viagem" },
  { ours: "Headphones (Auriculares)", search: "Auscultadores" },
  { ours: "Earrings (Pendientes)", search: "Brincos" },
  { ours: "Thermos (Termo)", search: "Garrafa térmica" },
  { ours: "Sports", search: "Desporto" },
];

const TAXONOMY_SEARCH_QUERY = `
  query TaxonomySearch($search: String!) {
    taxonomy {
      categories(search: $search, first: 3) {
        nodes { id name fullName isLeaf }
      }
    }
  }
`;

async function loadSession(shopArg) {
  const shop = shopArg || process.env.SPOT_CHECK_SHOP || process.env.SHOPIFY_SHOP_URL;
  const session = await prisma.session.findFirst({
    where: shop ? { shop } : undefined,
    orderBy: { id: "desc" },
  });
  if (!session?.accessToken) {
    throw new Error(
      `Sem sessão OAuth${shop ? ` para ${shop}` : ""}. Abre a app no Admin da Shopify pelo menos uma vez.`
    );
  }
  return { shop: session.shop, accessToken: session.accessToken };
}

async function main() {
  const shopArg = process.argv[2];
  const session = await loadSession(shopArg);
  const client = createShopifyClientFromSession(session);

  console.log(`=== Sugestão de categorias Shopify — ${session.shop} ===`);
  console.log(`${TERMS.length} termos a pesquisar (só leitura, sem escrita)...\n`);

  const rows = [];
  for (const term of TERMS) {
    const data = await client.graphql(TAXONOMY_SEARCH_QUERY, { search: term.search });
    const nodes = data?.taxonomy?.categories?.nodes || [];
    rows.push({ ...term, candidates: nodes });
    console.log(`  ${term.ours} (\"${term.search}\") -> ${nodes.length} candidato(s)`);
  }

  const lines = [];
  lines.push(`# Sugestões de categoria Shopify — ${session.shop}`);
  lines.push("");
  lines.push(`Gerado em ${new Date().toISOString()} — só leitura, nada escrito na Shopify.`);
  lines.push("");
  lines.push("| Nosso termo | Pesquisa (PT) | Candidato 1 | Candidato 2 | Candidato 3 |");
  lines.push("|---|---|---|---|---|");
  for (const row of rows) {
    const cols = [0, 1, 2].map((i) => {
      const c = row.candidates[i];
      if (!c) return "—";
      return `${c.name} (\`${c.id.replace("gid://shopify/TaxonomyCategory/", "")}\`)<br>${c.fullName}`;
    });
    lines.push(`| ${row.ours} | ${row.search} | ${cols[0]} | ${cols[1]} | ${cols[2]} |`);
  }

  const outPath = path.join(process.cwd(), "results", "shopify-category-suggestions.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\nOutput escrito em ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FALHOU:", err?.stack || err);
    process.exit(1);
  });
