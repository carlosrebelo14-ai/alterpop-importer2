import { prisma, safePrisma } from "../prisma/prismaSafe.server.js";
import { assertDbNotDegraded } from "../health/dbDegraded.js";
import { listCurationQueueItems } from "./curationQueue.server.js";
import { classificarPublicadosAusentes, escolherSubstitutos, valorDeMetafield } from "./descontinuados.js";

const LOTE = 500;

const PRODUTO_DESCONTINUADO = `
  query ProdutoDescontinuado($id: ID!) {
    product(id: $id) {
      id
      title
      status
      featuredImage { url }
      franquia: metafield(namespace: "alterpop", key: "franchise") { value }
      formato: metafield(namespace: "alterpop", key: "format") { value }
    }
  }
`;

async function emLotes(valores, fn) {
  const resultado = [];
  for (let i = 0; i < valores.length; i += LOTE) {
    resultado.push(...(await fn(valores.slice(i, i + LOTE))));
  }
  return resultado;
}

function lerFranquias(texto) {
  try {
    const lista = JSON.parse(texto || "[]");
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

async function presentesNoCatalogo(shop, skus) {
  const linhas = await emLotes(skus, (bloco) =>
    safePrisma(
      "descontinuados.presentes",
      () => prisma.catalogProduct.findMany({ where: { shop, sku: { in: bloco } }, select: { sku: true } }),
      { rethrow: true }
    )
  );
  return new Set(linhas.map((l) => l.sku));
}

async function rastreioDos(shop, skus) {
  const linhas = await emLotes(skus, (bloco) =>
    safePrisma(
      "descontinuados.rastreio",
      () =>
        prisma.catalogSkuTracking.findMany({
          where: { shop, sku: { in: bloco } },
          select: { sku: true, missingCycles: true, lastSeenAt: true, franchises: true },
        }),
      { rethrow: true }
    )
  );
  return new Map(
    linhas.map((l) => [l.sku, { missingCycles: l.missingCycles, lastSeenAt: l.lastSeenAt, franchises: lerFranquias(l.franchises) }])
  );
}

async function candidatosDaFranquia(shop, franquia) {
  return safePrisma(
    "descontinuados.candidatos",
    () =>
      prisma.catalogProduct.findMany({
        where: { shop, resolvedFranchise: franquia, stock: { gt: 0 } },
        select: {
          sku: true,
          title: true,
          vendor: true,
          categoryMain: true,
          imageUrl: true,
          resolvedFranchise: true,
          resolvedFormat: true,
          netPrice: true,
          grossPrice: true,
          stock: true,
        },
      }),
    { rethrow: true }
  );
}

/**
 * Lê na Shopify o título, a imagem, a franquia e o formato de um produto que já saiu do feed. Falha de leitura não
 * para a lista: devolve null, e o item fica sem estes campos.
 */
async function lerProdutoShopify(client, productId) {
  try {
    const data = await client.graphql(PRODUTO_DESCONTINUADO, { id: productId });
    const produto = data?.product;
    if (!produto) return null;
    return {
      titulo: produto.title,
      imagem: produto.featuredImage?.url ?? null,
      franquia: valorDeMetafield(produto.franquia?.value),
      formato: valorDeMetafield(produto.formato?.value),
    };
  } catch (err) {
    console.error(`[descontinuados] leitura Shopify falhou para ${productId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Lista de descontinuados para o painel. Só leitura: a Shopify só é lida, e a fila não é escrita.
 * @param {{ shop: string, client: any }} p
 */
export async function listarDescontinuados({ shop, client }) {
  assertDbNotDegraded("lista de descontinuados");
  const publicados = await listCurationQueueItems("PUBLISHED");
  const skus = publicados.map((i) => i.sku);
  const presentes = await presentesNoCatalogo(shop, skus);
  const rastreio = await rastreioDos(shop, skus);
  const classificacao = classificarPublicadosAusentes({ items: publicados, rastreio, presentes });
  if (classificacao.abortado) return { ok: true, abortado: true, motivo: classificacao.motivo, itens: [] };

  const ocupados = new Set((await listCurationQueueItems()).map((i) => i.sku));
  const itens = [];
  for (const descontinuado of classificacao.itens) {
    const item = publicados.find((i) => i.sku === descontinuado.sku);
    const productId = item?.metadata?.shopifyProductId ?? null;
    const shopify = productId ? await lerProdutoShopify(client, productId) : null;
    const franquia = shopify?.franquia ?? null;
    const formato = shopify?.formato ?? null;
    const precoReferencia = item?.metadata?.netPrice ?? null;

    const candidatos = franquia ? await candidatosDaFranquia(shop, franquia) : [];
    const { substitutos, motivo } = escolherSubstitutos({
      referencia: { sku: descontinuado.sku, franchise: franquia, format: formato, netPrice: precoReferencia },
      candidatos,
      ocupados,
    });

    itens.push({
      sku: descontinuado.sku,
      titulo: shopify?.titulo ?? item?.metadata?.title_es ?? descontinuado.sku,
      imagem: shopify?.imagem ?? null,
      franquia,
      formato,
      saiuEm: descontinuado.saiuEm,
      missingCycles: descontinuado.missingCycles,
      productId,
      precoReferencia,
      substitutos: substitutos.map((c) => ({
        sku: c.sku,
        titulo: c.title,
        imagem: c.imageUrl ?? null,
        netPrice: c.netPrice,
        stock: c.stock,
      })),
      motivoSemSubstitutos: substitutos.length ? null : motivo || "nenhum substituto disponível",
    });
  }

  return { ok: true, abortado: false, motivo: null, ausentesAgora: classificacao.ausentesAgora, itens };
}

/**
 * Revalida, no servidor, que um SKU pode entrar como substituto de um descontinuado. O painel mostra a lista, mas o
 * registo só é escrito se a regra ainda se cumprir.
 * @param {{ shop: string, client: any, sku: string, substitutoSku: string }} p
 * @returns {Promise<{ ok: boolean, motivo?: string, registo?: Record<string, any> }>}
 */
export async function validarSubstituto({ shop, client, sku, substitutoSku }) {
  assertDbNotDegraded("substituto de descontinuado");
  const publicados = await listCurationQueueItems("PUBLISHED");
  const item = publicados.find((i) => i.sku === sku);
  if (!item) return { ok: false, motivo: "o descontinuado já não está publicado na fila" };
  if (item.metadata?.despublicadoEm || item.metadata?.descontinuadoIgnoradoEm) {
    return { ok: false, motivo: "o descontinuado já foi despublicado ou ignorado" };
  }

  const shopify = item.metadata?.shopifyProductId ? await lerProdutoShopify(client, item.metadata.shopifyProductId) : null;
  const candidatos = shopify?.franquia ? await candidatosDaFranquia(shop, shopify.franquia) : [];
  const ocupados = new Set((await listCurationQueueItems()).map((i) => i.sku));
  const { substitutos, motivo } = escolherSubstitutos({
    referencia: { sku, franchise: shopify?.franquia ?? null, format: shopify?.formato ?? null, netPrice: item.metadata?.netPrice ?? null },
    candidatos,
    ocupados,
  });
  const escolhido = substitutos.find((c) => c.sku === substitutoSku);
  if (!escolhido) return { ok: false, motivo: motivo || "o SKU já não cumpre as regras de substituto" };
  return {
    ok: true,
    registo: {
      sku: escolhido.sku,
      title: escolhido.title,
      vendor: escolhido.vendor,
      categoryMain: escolhido.categoryMain,
      netPrice: escolhido.netPrice,
      grossPrice: escolhido.grossPrice,
      availableQuantity: escolhido.stock,
    },
  };
}
