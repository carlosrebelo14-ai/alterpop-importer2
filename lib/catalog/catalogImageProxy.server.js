/**
 * Serve a miniatura de um produto do catálogo a partir da app, e não do fornecedor.
 *
 * O fornecedor bloqueia pedidos que chegam com Referer de outra origem (hotlink). Por isso a app vai buscar
 * a imagem sem Referer e devolve-a ao browser. O browser nunca recebe o URL do fornecedor.
 *
 * Quem chama passa só o SKU e o índice. O URL sai sempre do catálogo (imageUrl), nunca do cliente, por isso
 * não é um proxy aberto. Qualquer falha dá 404 sem corpo, e o cliente não fica a saber a causa.
 *
 * Não há cache em disco nesta versão. Só o Cache-Control da resposta.
 */
import { resolveAllProductImages } from "./productImages.js";

/** Hosts de fornecedor que a app aceita. Lista fechada: acrescentar um host é uma decisão, não um detalhe. */
export const FORNECEDORES_PERMITIDOS = new Set(["www.ociostock.com"]);

/**
 * Media types que a app serve. O SVG fica de fora de propósito: um SVG servido na origem da app
 * pode correr scripts (XSS).
 */
export const TIPOS_PERMITIDOS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

/** Tamanho máximo da imagem. Acima disto a miniatura não compensa e o pedido pode encher a memória. */
export const LIMITE_BYTES = 5 * 1024 * 1024;

/** Tempo máximo para o fornecedor responder, cabeçalhos e corpo incluídos. */
export const TEMPO_LIMITE_MS = 10000;

/** Uma semana. A imagem de um produto muda pouco. */
export const CACHE_CONTROL = "public, max-age=604800";

/** User-Agent de um navegador de desktop. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SKU_MAX_CARACTERES = 100;

/** Caracteres de controlo Unicode (C0, DEL e C1). Não entram num SKU. */
const CONTROLO = /\p{Cc}/u;

/** 404 sem corpo. É a única resposta de erro, para o cliente não ver a causa. */
function naoEncontrada() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Liberta a ligação ao fornecedor sem ler o corpo. Um erro aqui não muda a resposta. */
async function cancelar(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* já cancelado: não interessa */
  }
}

/** Texto de 1 a 100 caracteres, sem controlo. Valida antes de tocar na BD. */
function skuValido(sku) {
  if (typeof sku !== "string") return false;
  const tamanho = Array.from(sku).length;
  return tamanho >= 1 && tamanho <= SKU_MAX_CARACTERES && !CONTROLO.test(sku);
}

/**
 * Inteiro a partir de 0. Não há teto fixo: a imagem existe se a lista do catálogo a tiver. Um teto aqui
 * deixava sem foto as imagens a partir da 21.ª, que o painel continua a mostrar.
 */
function indiceValido(indice) {
  return Number.isInteger(indice) && indice >= 0;
}

/**
 * SKU do caminho /api/catalog-image/<sku>/<indice>, descodificado uma vez. Devolve null se a forma não bater
 * ou se a codificação estiver partida.
 *
 * Não se usa o parâmetro do React Router: ele descodifica outra vez. Um SKU com "%2F" escrito à letra
 * passava a ser o SKU com "/", e a miniatura mostrava a imagem de outro produto.
 * @param {string} caminho
 * @returns {string | null}
 */
export function skuDoCaminho(caminho) {
  const partes = String(caminho).split("/").filter(Boolean);
  if (partes.length !== 4 || partes[0] !== "api" || partes[1] !== "catalog-image") return null;
  try {
    return decodeURIComponent(partes[2]);
  } catch {
    return null;
  }
}

/**
 * Devolve o URL se for https, sem credenciais, na porta padrão e com host da lista. Senão devolve null.
 * @param {string} texto
 * @param {Set<string>} fornecedoresPermitidos
 * @returns {URL | null}
 */
function urlDoFornecedor(texto, fornecedoresPermitidos) {
  let url;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!fornecedoresPermitidos.has(url.hostname)) return null;
  return url;
}

/**
 * Lê o corpo em blocos e para assim que passa do limite. Sem corpo, ou com corpo vazio, devolve null.
 * Não se lê tudo primeiro: uma imagem grande não deve encher a memória antes de ser recusada.
 * @param {Response} res
 * @param {number} limiteBytes
 * @returns {Promise<Uint8Array | null>}
 */
async function lerCorpo(res, limiteBytes) {
  if (!res.body) return null;
  const leitor = res.body.getReader();
  const blocos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limiteBytes) {
      await leitor.cancel().catch(() => {});
      return null;
    }
    blocos.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let posicao = 0;
  for (const bloco of blocos) {
    bytes.set(bloco, posicao);
    posicao += bloco.byteLength;
  }
  return bytes;
}

/**
 * Serve a imagem `indice` do produto `sku` na loja `shop`. Devolve sempre uma Response.
 * @param {{
 *   prisma: { catalogProduct: { findUnique: (args: object) => Promise<{ imageUrl: string | null } | null> } },
 *   shop: string,
 *   sku: string,
 *   indice: number,
 *   fornecedoresPermitidos?: Set<string>,
 *   fetchImpl?: typeof fetch,
 *   tempoLimiteMs?: number,
 *   limiteBytes?: number,
 * }} opcoes
 * @returns {Promise<Response>}
 */
export async function servirImagemDoCatalogo({
  prisma,
  shop,
  sku,
  indice,
  fornecedoresPermitidos = FORNECEDORES_PERMITIDOS,
  fetchImpl = fetch,
  tempoLimiteMs = TEMPO_LIMITE_MS,
  limiteBytes = LIMITE_BYTES,
}) {
  if (!skuValido(sku) || !indiceValido(indice) || typeof shop !== "string" || !shop) {
    return naoEncontrada();
  }

  try {
    // Só leitura: a chave composta é shop_sku, e só se pede o campo da imagem.
    const linha = await prisma.catalogProduct.findUnique({
      where: { shop_sku: { shop, sku } },
      select: { imageUrl: true },
    });
    if (!linha) return naoEncontrada();

    const lista = resolveAllProductImages(linha.imageUrl);
    const url = lista[indice];
    if (!url) return naoEncontrada();

    const alvo = urlDoFornecedor(url, fornecedoresPermitidos);
    if (!alvo) return naoEncontrada();

    // Sem Referer, de propósito: é o que o fornecedor aceita. O redirect manual deixa o 3xx
    // chegar até aqui, para ser tratado como erro e não seguido para outro sítio.
    const res = await fetchImpl(alvo.href, {
      redirect: "manual",
      headers: { Accept: "image/*", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(tempoLimiteMs),
    });

    if (res.status !== 200) {
      await cancelar(res);
      return naoEncontrada();
    }

    const tipo = (res.headers.get("content-type") || "").split(";")[0].replace(/\s+/g, "").toLowerCase();
    if (!TIPOS_PERMITIDOS.has(tipo)) {
      await cancelar(res);
      return naoEncontrada();
    }

    // Se o fornecedor anuncia o tamanho, recusa-se sem ler nada. Sem anúncio, o limite é contado no corpo.
    const anunciado = res.headers.get("content-length");
    if (anunciado !== null) {
      const tamanho = Number(anunciado);
      if (Number.isFinite(tamanho) && tamanho > limiteBytes) {
        await cancelar(res);
        return naoEncontrada();
      }
    }

    const bytes = await lerCorpo(res, limiteBytes);
    if (!bytes) return naoEncontrada();

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": tipo,
        "Cache-Control": CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    // Só o nome da classe. A mensagem pode trazer o URL do fornecedor ou o SKU, e o log não os leva.
    console.warn("[catalog-image] FALHA " + (err?.name || "erro"));
    return naoEncontrada();
  }
}
