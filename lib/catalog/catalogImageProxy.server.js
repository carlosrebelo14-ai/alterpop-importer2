/**
 * Serve a miniatura de um produto do catálogo a partir da app, e não do fornecedor.
 *
 * O fornecedor bloqueia pedidos que chegam com Referer de outra origem (hotlink). Por isso a app vai buscar
 * a imagem sem Referer e devolve-a ao browser. O browser nunca recebe o URL do fornecedor.
 *
 * Quem chama passa só o SKU e o índice. O URL sai sempre do catálogo (imageUrl), nunca do cliente, por isso
 * não é um proxy aberto. Qualquer falha dá 404 sem corpo, e o cliente não fica a saber a causa.
 *
 * A rota é pública, por isso o servidor limita o que faz ao fornecedor, por processo:
 * - No máximo SIMULTANEOS_MAX pedidos em curso. Os seguintes esperam numa fila curta. Fila cheia, ou espera
 *   longa de mais, dá 503 com Retry-After e não sai pedido nenhum para o fornecedor. Sem este teto, um cliente
 *   podia fazer da app um amplificador de pedidos.
 * - Cache em memória por URL do fornecedor, em LRU com teto de bytes e tempo de vida. Uma imagem já buscada
 *   não volta a ser pedida.
 *
 * Não há cache em disco. O Cache-Control da resposta diz ao browser o resto.
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

/** Pedidos ao fornecedor em curso ao mesmo tempo, neste processo. */
export const SIMULTANEOS_MAX = 4;

/** Pedidos à espera de um lugar. Acima disto responde-se 503 sem ir ao fornecedor. */
export const FILA_MAXIMA = 100;

/** Tempo máximo à espera de um lugar. Passado isto, o pedido desiste com 503. */
export const ESPERA_MAX_MS = 30000;

/** Teto do total de bytes da cache. Quando se passa, sai a imagem usada há mais tempo. */
export const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Tempo de vida de uma imagem na cache. Passado isto, a imagem volta a ser buscada ao fornecedor. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/** User-Agent de um navegador de desktop. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SKU_MAX_CARACTERES = 100;

/** Caracteres de controlo Unicode (C0, DEL e C1). Não entram num SKU. */
const CONTROLO = /\p{Cc}/u;

/** 404 sem corpo. É a única resposta de erro, para o cliente não ver a causa. */
function naoEncontrada() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * 503 para quem não tem lugar. O Retry-After diz ao cliente para voltar daqui a 5 s. Não diz nada sobre o
 * produto, por isso não se guarda e não vai ao fornecedor.
 */
function servicoOcupado() {
  return new Response(null, {
    status: 503,
    headers: { "Retry-After": "5", "Cache-Control": "no-store" },
  });
}

/**
 * Resposta de imagem. Os cabeçalhos são os mesmos, venha a imagem do fornecedor ou da cache.
 *
 * O corpo entra como stream que entrega os mesmos bytes. Com new Response(bytes), o undici copia o buffer,
 * e cada resposta ainda não lida levava a sua cópia. Assim a memória ficava fora do teto da cache. Com a
 * stream, todas as respostas partilham os bytes que a cache guarda.
 */
function respostaDeImagem(bytes, tipo) {
  const corpo = new ReadableStream({
    start(controlador) {
      controlador.enqueue(bytes);
      controlador.close();
    },
  });
  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": tipo,
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
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

/** Erro do limitador. O código deixa quem chama distinguir a causa sem ler a mensagem. */
function erroDoLimite(codigo) {
  return Object.assign(new Error(codigo), { code: codigo });
}

/**
 * Limitador de pedidos ao fornecedor. Dá até `simultaneos` lugares. Os pedidos seguintes esperam numa fila,
 * por ordem de chegada. Um lugar libertado passa logo ao primeiro da fila.
 * @param {{ simultaneos: number, filaMaxima: number, esperaMaxMs: number }} opcoes
 */
function criarLimitador({ simultaneos, filaMaxima, esperaMaxMs }) {
  let emCurso = 0;
  /** Pedidos à espera de lugar, do mais antigo para o mais recente. */
  const fila = [];

  /**
   * Função de libertar de um lugar. Chamada duas vezes, só liberta uma. Sem esta guarda, um erro duplo
   * deixava entrar um pedido a mais.
   */
  function criarLibertar() {
    let libertado = false;
    return () => {
      if (libertado) return;
      libertado = true;
      passarLugar();
    };
  }

  /** Passa o lugar ao primeiro da fila. Se a fila estiver vazia, o lugar fica vago. */
  function passarLugar() {
    const seguinte = fila.shift();
    if (!seguinte) {
      emCurso -= 1;
      return;
    }
    clearTimeout(seguinte.temporizador);
    seguinte.entregar(criarLibertar());
  }

  return {
    /**
     * Pede um lugar. Resolve já se houver, ou quando um lugar se libertar. Rejeita com FILA_CHEIA se a fila
     * estiver cheia, sem esperar. Rejeita com ESPERA_ESGOTADA se a espera passar de `esperaMs`.
     * @param {number} [esperaMs]
     * @returns {Promise<() => void>}
     */
    adquirir(esperaMs = esperaMaxMs) {
      if (emCurso < simultaneos) {
        emCurso += 1;
        return Promise.resolve(criarLibertar());
      }
      if (fila.length >= filaMaxima) {
        return Promise.reject(erroDoLimite("FILA_CHEIA"));
      }
      return new Promise((entregar, recusar) => {
        const entrada = { entregar, temporizador: null };
        entrada.temporizador = setTimeout(() => {
          const posicao = fila.indexOf(entrada);
          if (posicao >= 0) fila.splice(posicao, 1);
          recusar(erroDoLimite("ESPERA_ESGOTADA"));
        }, esperaMs);
        fila.push(entrada);
      });
    },
  };
}

/**
 * Cache em memória, em LRU, com teto de bytes e tempo de vida. A chave é o URL do fornecedor, já validado.
 * Uma foto que muda tem outro URL, e por isso entra com chave nova.
 * @param {{ cacheMaxBytes: number, cacheTtlMs: number, agora: () => number }} opcoes
 */
function criarCache({ cacheMaxBytes, cacheTtlMs, agora }) {
  /** Por ordem de uso: a primeira entrada é a menos usada. */
  const entradas = new Map();
  let bytesOcupados = 0;

  function apagar(chave) {
    const entrada = entradas.get(chave);
    if (!entrada) return;
    bytesOcupados -= entrada.bytes.byteLength;
    entradas.delete(chave);
  }

  return {
    /**
     * Devolve { bytes, tipo } ou null. Usar uma entrada põe-na no fim, para a expulsão tirar primeiro as
     * que ninguém usa. Passado o tempo de vida, a entrada sai e não se devolve.
     */
    get(chave) {
      const entrada = entradas.get(chave);
      if (!entrada) return null;
      if (agora() - entrada.criadaEm > cacheTtlMs) {
        apagar(chave);
        return null;
      }
      // Usar uma entrada põe-na no fim: a expulsão tira sempre a menos usada.
      entradas.delete(chave);
      entradas.set(chave, entrada);
      return { bytes: entrada.bytes, tipo: entrada.tipo };
    },
    /**
     * Guarda a entrada e expulsa as menos usadas até caber. Uma entrada maior que o teto não se guarda.
     */
    set(chave, { bytes, tipo }) {
      apagar(chave);
      if (bytes.byteLength > cacheMaxBytes) return;
      while (bytesOcupados + bytes.byteLength > cacheMaxBytes && entradas.size > 0) {
        const [menosUsada] = entradas.keys();
        apagar(menosUsada);
      }
      entradas.set(chave, { bytes, tipo, criadaEm: agora() });
      bytesOcupados += bytes.byteLength;
    },
  };
}

/**
 * Corre `trabalho` com um lugar do limitador, e liberta o lugar no fim, aconteça o que acontecer.
 * Sem lugar (fila cheia ou espera esgotada) responde 503, e `trabalho` não corre.
 * @param {ReturnType<typeof criarLimitador>} limitador
 * @param {() => Promise<Response>} trabalho
 * @returns {Promise<Response>}
 */
async function comLugar(limitador, trabalho) {
  let libertar;
  try {
    libertar = await limitador.adquirir();
  } catch (erroDaFila) {
    if (erroDaFila.code === "FILA_CHEIA" || erroDaFila.code === "ESPERA_ESGOTADA") return servicoOcupado();
    throw erroDaFila;
  }
  try {
    return await trabalho();
  } finally {
    libertar();
  }
}

/**
 * Estado do proxy: o limitador e a cache. Em produção há um por processo (ESTADO_PADRAO). Os testes criam
 * um por caso, para um caso não herdar a cache do anterior.
 * @param {{
 *   simultaneos?: number,
 *   filaMaxima?: number,
 *   esperaMaxMs?: number,
 *   cacheMaxBytes?: number,
 *   cacheTtlMs?: number,
 *   agora?: () => number,
 * }} [opcoes]
 */
export function criarEstadoDoProxy({
  simultaneos = SIMULTANEOS_MAX,
  filaMaxima = FILA_MAXIMA,
  esperaMaxMs = ESPERA_MAX_MS,
  cacheMaxBytes = CACHE_MAX_BYTES,
  cacheTtlMs = CACHE_TTL_MS,
  agora = () => Date.now(),
} = {}) {
  return {
    limitador: criarLimitador({ simultaneos, filaMaxima, esperaMaxMs }),
    cache: criarCache({ cacheMaxBytes, cacheTtlMs, agora }),
  };
}

/** Estado do processo. A rota usa este, porque não passa `estado`. */
export const ESTADO_PADRAO = criarEstadoDoProxy();

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
 *   estado?: ReturnType<typeof criarEstadoDoProxy>,
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
  estado = ESTADO_PADRAO,
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

    // Uma imagem já guardada responde sem lugar e sem fetch. Não espera por ninguém.
    const daCache = estado.cache.get(alvo.href);
    if (daCache) return respostaDeImagem(daCache.bytes, daCache.tipo);

    return await comLugar(estado.limitador, async () => {
      // Enquanto este pedido esperava na fila, outro pode ter guardado a mesma imagem.
      const depoisDeLugar = estado.cache.get(alvo.href);
      if (depoisDeLugar) return respostaDeImagem(depoisDeLugar.bytes, depoisDeLugar.tipo);

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

      // Só a imagem inteira e válida entra na cache. Um erro ou uma imagem parcial nunca chega aqui.
      estado.cache.set(alvo.href, { bytes, tipo });
      return respostaDeImagem(bytes, tipo);
    });
  } catch (err) {
    // Só o nome da classe. A mensagem pode trazer o URL do fornecedor ou o SKU, e o log não os leva.
    console.warn("[catalog-image] FALHA " + (err?.name || "erro"));
    return naoEncontrada();
  }
}
