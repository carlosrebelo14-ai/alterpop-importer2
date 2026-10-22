#!/usr/bin/env node
/* eslint-env node */
/**
 * Proxy da miniatura do catálogo: lib/catalog/catalogImageProxy.server.js e a rota api.catalog-image.$sku.$i.jsx.
 *   (1) feliz: 200, corpo igual, Content-Type sem parâmetros, Cache-Control e nosniff.
 *   (2) host fora da lista: 404 e o fetch não é chamado.
 *   (3) esquema http: 404 e o fetch não é chamado.
 *   (4) porta não padrão e credenciais no URL: 404 e o fetch não é chamado.
 *   (5) 3xx é erro, e o fetch recebe redirect "manual".
 *   (6) Content-Length acima do limite: 404 sem ler o corpo.
 *   (7) corpo acima do limite sem Content-Length: 404.
 *   (8) tipo errado (HTML e SVG): 404.
 *   (9) SKU inexistente: 404. SKU inválido: 404 sem tocar na BD.
 *   (10) índice fora da lista: 404.
 *   (11) o fetch nunca recebe Referer.
 *   (12) erro de rede, aborto e timeout: 404, e o log só tem o nome da classe.
 *   (13) a rota: exporta loader, não exporta action, e não importa nada de autenticação.
 *   (14) lista com protocolo relativo: a rota serve a mesma lista que o painel mostra.
 *   (15) ordem das imagens: cada índice aponta para a imagem certa.
 *   (16) só 200 é imagem: 201 e 206 dão 404.
 *   (17) índice sem teto: a 21.ª imagem (índice 20) é servida.
 *   (18) a ligação ao fornecedor é libertada (3xx, erro, tipo errado, limite) e um corpo parado dá timeout sem imagem parcial.
 *   (19) o SKU vem do caminho cru, descodificado uma vez (um "%2F" escrito à letra não vira "/").
 *   (20) a rota lê a BD por safePrisma (com rethrow) e tira o SKU do caminho cru.
 *
 * Mutações: cada caso tem pelo menos uma. Copia-se a lib para catalogImageProxy.mutante-<nome>.server.js, troca-se
 * UMA âncora, e o caso tem de falhar. Para productImages.js copia-se esse ficheiro e a lib passa a importar a cópia.
 * A mutação da rota (13) e as da rota (20) são feitas no texto em memória, sem ficheiro.
 *
 * Dados sintéticos: o host de teste e o SKU são inventados. O único host real que aparece no código é o da lista.
 *
 * Uso: node scripts/tests/catalog-image-proxy.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as libReal from "../../lib/catalog/catalogImageProxy.server.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = "lib/catalog/catalogImageProxy.server.js";
const ROTA = "app/routes/api.catalog-image.$sku.$i.jsx";

const LOJA = "loja-sintetica.example";
const SKU = "SKU-SINTETICO-1";
const HOST = "imagens.fornecedor-sintetico.example";
const URL_IMAGEM = `https://${HOST}/sintetico-1.png`;
const OUTRO_URL = `https://${HOST}/sintetico-2.png`;
const PERMITIDOS = new Set([HOST]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

/** Mutação que tem de ser apanhada: se o caso passar com ela, falha. */
async function mutacaoTemDeFalhar(nome, fn) {
  let apanhou = false;
  try {
    await fn();
  } catch {
    apanhou = true;
  }
  if (!apanhou) throw new Error(`mutação ${nome}: o caso não a apanhou`);
}

/** Troca uma âncora que tem de existir exatamente uma vez no texto. Erro do teste, fora de mutacaoTemDeFalhar. */
function trocaUma(texto, nome, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  return texto.replace(antigo, () => novo);
}

/** Cópia mutada da lib, no mesmo diretório (o import de productImages.js é relativo). */
function copiaMutada(nome, antigo, novo) {
  const origem = path.join(REPO, LIB);
  const texto = trocaUma(fs.readFileSync(origem, "utf8"), nome, antigo, novo);
  const destino = path.join(path.dirname(origem), `catalogImageProxy.mutante-${nome}.server.js`);
  fs.writeFileSync(destino, texto);
  return destino;
}

/**
 * Corre o caso com a lib mutada, que tem de falhar. A cópia é apagada no fim, mesmo que o caso rebente.
 * @param {string} nome
 * @param {string} antigo
 * @param {string} novo
 * @param {(lib: object) => Promise<void> | void} verifica
 */
async function mutante(nome, antigo, novo, verifica) {
  await caso(`mutação ${nome}`, async () => {
    const copia = copiaMutada(nome, antigo, novo);
    try {
      const lib = await import(pathToFileURL(copia).href);
      await mutacaoTemDeFalhar(nome, () => verifica(lib));
    } finally {
      fs.rmSync(copia, { force: true });
    }
  });
}

/**
 * Como `mutante`, mas a âncora está em lib/catalog/productImages.js. A cópia da lib passa a importar a cópia mutada.
 * @param {string} nome
 * @param {string} antigo
 * @param {string} novo
 * @param {(lib: object) => Promise<void> | void} verifica
 */
async function mutanteProductImages(nome, antigo, novo, verifica) {
  await caso(`mutação ${nome}`, async () => {
    const pasta = path.join(REPO, path.dirname(LIB));
    const copiaListas = path.join(pasta, `productImages.mutante-${nome}.js`);
    const copiaLib = path.join(pasta, `catalogImageProxy.mutante-${nome}.server.js`);
    try {
      const listas = trocaUma(fs.readFileSync(path.join(pasta, "productImages.js"), "utf8"), nome, antigo, novo);
      fs.writeFileSync(copiaListas, listas);
      const lib = trocaUma(
        fs.readFileSync(path.join(pasta, "catalogImageProxy.server.js"), "utf8"),
        nome,
        'from "./productImages.js"',
        `from "./productImages.mutante-${nome}.js"`
      );
      fs.writeFileSync(copiaLib, lib);
      const libMutada = await import(pathToFileURL(copiaLib).href);
      await mutacaoTemDeFalhar(nome, () => verifica(libMutada));
    } finally {
      fs.rmSync(copiaListas, { force: true });
      fs.rmSync(copiaLib, { force: true });
    }
  });
}

/** BD falsa: só findUnique, e guarda as chamadas para o caso poder ver se a BD foi tocada. */
function prismaFalso(linhas = {}) {
  const chamadas = [];
  return {
    chamadas,
    catalogProduct: {
      async findUnique(args) {
        chamadas.push(args);
        const sku = args.where.shop_sku.sku;
        return Object.prototype.hasOwnProperty.call(linhas, sku) ? { imageUrl: linhas[sku] } : null;
      },
    },
  };
}

/** fetch falso: a fábrica recebe (url, init) e devolve a Response. Guarda cada chamada. */
function fetchFalso(fabrica) {
  const chamadas = [];
  const fetchImpl = async (url, init) => {
    chamadas.push({ url, init });
    return fabrica(url, init);
  };
  fetchImpl.chamadas = chamadas;
  return fetchImpl;
}

const respostaPng = (tipo = "image/png") => new Response(PNG, { status: 200, headers: { "Content-Type": tipo } });

/**
 * Corpo que se lê aos bocados, sem prefetch. Com highWaterMark 0, `leituras` conta só o que a lib pediu.
 */
function corpoContado(pedacos) {
  let leituras = 0;
  let i = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        leituras += 1;
        if (i < pedacos.length) controller.enqueue(pedacos[i++]);
        else controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, leituras: () => leituras };
}

/** Corpo que regista o cancelamento. Se a lib não liberta a ligação, `cancelado()` continua a false. */
function corpoComCancelamento(pedacos) {
  let cancelado = false;
  let i = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (i < pedacos.length) controller.enqueue(pedacos[i++]);
        else controller.close();
      },
      cancel() {
        cancelado = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, cancelado: () => cancelado };
}

/** Chama a lib com a loja, o SKU e o índice por omissão dos casos. */
function servir(lib, opcoes) {
  return lib.servirImagemDoCatalogo({ shop: LOJA, sku: SKU, indice: 0, fornecedoresPermitidos: PERMITIDOS, ...opcoes });
}

/** Apanha os avisos de console.warn durante uma chamada. */
async function comAvisos(fn) {
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args.join(" "));
  try {
    const resultado = await fn();
    return { resultado, avisos };
  } finally {
    console.warn = original;
  }
}

// ---------- casos (recebem a lib, real ou mutada) ----------

async function casoFeliz(lib) {
  const prisma = prismaFalso({ [SKU]: URL_IMAGEM });
  const fetchImpl = fetchFalso(() => respostaPng("image/png; qs=1"));
  const res = await servir(lib, { prisma, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png", "sem parâmetros");
  assert.equal(res.headers.get("cache-control"), "public, max-age=604800");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG, "o corpo chega igual");
  assert.deepEqual(prisma.chamadas, [{ where: { shop_sku: { shop: LOJA, sku: SKU } }, select: { imageUrl: true } }]);
  assert.equal(fetchImpl.chamadas.length, 1);
  assert.equal(fetchImpl.chamadas[0].url, URL_IMAGEM);
}

async function casoHostForaDaLista(lib) {
  // A lista é fechada: um host só entra se estiver lá. Aqui o host de teste não está.
  assert.equal(lib.FORNECEDORES_PERMITIDOS.size, 1, "a lista de fornecedores é fechada");
  assert.equal(lib.FORNECEDORES_PERMITIDOS.has(HOST), false);
  const prisma = prismaFalso({ [SKU]: URL_IMAGEM });
  const fetchImpl = fetchFalso(() => respostaPng());
  const res = await lib.servirImagemDoCatalogo({ prisma, shop: LOJA, sku: SKU, indice: 0, fetchImpl });
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.chamadas.length, 0, "o fetch não é chamado");
}

async function casoHttp(lib) {
  const prisma = prismaFalso({ [SKU]: URL_IMAGEM.replace("https://", "http://") });
  const fetchImpl = fetchFalso(() => respostaPng());
  const res = await servir(lib, { prisma, fetchImpl });
  assert.equal(res.status, 404);
  assert.equal(fetchImpl.chamadas.length, 0, "o fetch não é chamado");
}

async function casoPortaECredenciais(lib) {
  const casos = [
    ["porta", `https://${HOST}:8443/sintetico-1.png`],
    ["credenciais", `https://utilizador-sintetico:credencial-sintetica@${HOST}/sintetico-1.png`],
  ];
  for (const [motivo, url] of casos) {
    const prisma = prismaFalso({ [SKU]: url });
    const fetchImpl = fetchFalso(() => respostaPng());
    const res = await servir(lib, { prisma, fetchImpl });
    assert.equal(res.status, 404, `recusado por ${motivo}`);
    assert.equal(fetchImpl.chamadas.length, 0, `o fetch não é chamado (${motivo})`);
  }
}

async function casoRedirecionamento(lib) {
  const prisma = prismaFalso({ [SKU]: URL_IMAGEM });
  // Com redirect "manual" o fornecedor responde 302. Se a lib seguisse o redirect, a fábrica daria a imagem.
  const fetchImpl = fetchFalso((url, init) =>
    init.redirect === "manual"
      ? new Response(null, { status: 302, headers: { Location: OUTRO_URL } })
      : respostaPng()
  );
  const res = await servir(lib, { prisma, fetchImpl });
  assert.equal(res.status, 404, "um 3xx é erro");
  assert.equal(res.headers.get("location"), null);
  assert.equal(fetchImpl.chamadas.length, 1);
  assert.equal(fetchImpl.chamadas[0].init.redirect, "manual");
}

async function casoContentLengthAcimaDoLimite(lib) {
  const recusado = corpoContado([new Uint8Array(4)]);
  const res = await servir(lib, {
    prisma: prismaFalso({ [SKU]: URL_IMAGEM }),
    fetchImpl: fetchFalso(() => new Response(recusado.stream, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "1000" } })),
    limiteBytes: 10,
  });
  assert.equal(res.status, 404, "anunciado 1000 bytes, limite 10");
  assert.equal(recusado.leituras(), 0, "não lê o corpo");

  // Contraprova: o mesmo corpo com um anúncio abaixo do limite passa.
  const aceite = corpoContado([new Uint8Array(4)]);
  const ok = await servir(lib, {
    prisma: prismaFalso({ [SKU]: URL_IMAGEM }),
    fetchImpl: fetchFalso(() => new Response(aceite.stream, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "4" } })),
    limiteBytes: 10,
  });
  assert.equal(ok.status, 200, "anúncio abaixo do limite passa");
}

async function casoCorpoAcimaDoLimiteSemContentLength(lib) {
  const contado = corpoContado([new Uint8Array(6), new Uint8Array(6)]);
  const resposta = new Response(contado.stream, { status: 200, headers: { "Content-Type": "image/png" } });
  assert.equal(resposta.headers.get("content-length"), null, "sem Content-Length anunciado");
  const res = await servir(lib, {
    prisma: prismaFalso({ [SKU]: URL_IMAGEM }),
    fetchImpl: fetchFalso(() => resposta),
    limiteBytes: 10,
  });
  assert.equal(res.status, 404, "12 bytes lidos, limite 10");
  assert.ok(contado.leituras() > 0, "sem anúncio, o limite conta no corpo");
}

async function casoTipoErrado(lib) {
  for (const tipo of ["text/html; charset=utf-8", "image/svg+xml"]) {
    const prisma = prismaFalso({ [SKU]: URL_IMAGEM });
    const res = await servir(lib, { prisma, fetchImpl: fetchFalso(() => respostaPng(tipo)) });
    assert.equal(res.status, 404, `tipo ${tipo.split(";")[0]} recusado`);
  }
  assert.equal(lib.TIPOS_PERMITIDOS.has("image/svg+xml"), false, "SVG fica de fora");
  // Normalização: maiúsculas e espaços antes do ';' não recusam um tipo válido.
  const ok = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl: fetchFalso(() => respostaPng("Image/PNG ; charset=x")) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
}

async function casoSkuEIndiceInvalidosOuInexistentes(lib) {
  // SKU inexistente: a BD é consultada, e a resposta é 404.
  const inexistente = prismaFalso({});
  const fetchInexistente = fetchFalso(() => respostaPng());
  const resInexistente = await servir(lib, { prisma: inexistente, fetchImpl: fetchInexistente, sku: "SKU-SINTETICO-INEXISTENTE" });
  assert.equal(resInexistente.status, 404);
  assert.equal(inexistente.chamadas.length, 1, "a BD foi consultada");
  assert.equal(fetchInexistente.chamadas.length, 0);

  // SKU inválido: 404 sem tocar na BD.
  for (const sku of ["SKU-\u0007-SINTETICO", "A".repeat(101), ""]) {
    const prisma = prismaFalso({ [sku]: URL_IMAGEM });
    const res = await servir(lib, { prisma, fetchImpl: fetchFalso(() => respostaPng()), sku });
    assert.equal(res.status, 404);
    assert.equal(prisma.chamadas.length, 0, "SKU inválido não chega à BD");
  }

  // O limite de 100 caracteres é aceite.
  const noLimite = prismaFalso({});
  const resLimite = await servir(lib, { prisma: noLimite, fetchImpl: fetchFalso(() => respostaPng()), sku: "A".repeat(100) });
  assert.equal(resLimite.status, 404, "não há linha com esse SKU");
  assert.equal(noLimite.chamadas.length, 1, "100 caracteres chega à BD");
}

async function casoIndiceForaDaLista(lib) {
  // Só há uma imagem, por isso só o índice 0 existe.
  for (const indice of [1, 5, -1, 1.5, "0"]) {
    const fetchImpl = fetchFalso(() => respostaPng());
    const res = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl, indice });
    assert.equal(res.status, 404, `índice ${String(indice)} recusado`);
    assert.equal(fetchImpl.chamadas.length, 0);
  }
  const ok = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl: fetchFalso(() => respostaPng()), indice: 0 });
  assert.equal(ok.status, 200, "o índice 0 existe");
}

async function casoSemReferer(lib) {
  const fetchImpl = fetchFalso(() => respostaPng());
  const res = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl });
  assert.equal(res.status, 200);
  const cabecalhos = new Headers(fetchImpl.chamadas[0].init.headers);
  assert.equal(cabecalhos.has("referer"), false, "o pedido sai sem Referer");
  assert.equal(cabecalhos.get("accept"), "image/*");
}

async function casoErrosDeRede(lib) {
  const falhas = [
    ["TypeError", () => { throw new TypeError(`falhou ao ligar a ${URL_IMAGEM} para ${SKU}`); }],
    ["AbortError", () => { throw new DOMException(`abortado: ${URL_IMAGEM}`, "AbortError"); }],
  ];
  for (const [nome, falha] of falhas) {
    const { resultado: res, avisos } = await comAvisos(() =>
      servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl: fetchFalso(falha) })
    );
    assert.equal(res.status, 404, nome);
    assert.deepEqual(avisos, [`[catalog-image] FALHA ${nome}`], "o log tem só o nome da classe");
    assert.equal(avisos.join(" ").includes(URL_IMAGEM), false, "o log não tem o URL");
    assert.equal(avisos.join(" ").includes(SKU), false, "o log não tem o SKU");
  }

  // Timeout real: o fetch só termina quando o sinal aborta. O processo fica vivo até lá,
  // porque o temporizador de AbortSignal.timeout não segura o event loop.
  const vivo = setTimeout(() => {}, 2000);
  try {
    const fetchPendente = (url, init) =>
      new Promise((_, rejeita) => {
        init.signal.addEventListener("abort", () => rejeita(init.signal.reason));
      });
    const { resultado: res, avisos } = await comAvisos(() =>
      servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl: fetchPendente, tempoLimiteMs: 20 })
    );
    assert.equal(res.status, 404, "timeout");
    assert.deepEqual(avisos, ["[catalog-image] FALHA TimeoutError"]);
  } finally {
    clearTimeout(vivo);
  }
}

async function casoListaComProtocoloRelativo(lib) {
  // O valor do banco tem um "//" no primeiro sítio. O painel já o vê como https, por isso a rota tem de servir a mesma foto.
  const valor = `//${HOST}/sintetico-1.png,${OUTRO_URL}`;
  const primeira = fetchFalso(() => respostaPng());
  const res0 = await servir(lib, { prisma: prismaFalso({ [SKU]: valor }), fetchImpl: primeira, indice: 0 });
  assert.equal(res0.status, 200);
  assert.equal(primeira.chamadas[0].url, URL_IMAGEM, "o índice 0 é o primeiro valor, com https");
  const segunda = fetchFalso(() => respostaPng());
  const res1 = await servir(lib, { prisma: prismaFalso({ [SKU]: valor }), fetchImpl: segunda, indice: 1 });
  assert.equal(res1.status, 200, "o índice 1 existe");
  assert.equal(segunda.chamadas[0].url, OUTRO_URL);
}

async function casoOrdemDasImagens(lib) {
  const valor = `${URL_IMAGEM}, ${OUTRO_URL}`;
  for (const [indice, esperado] of [
    [0, URL_IMAGEM],
    [1, OUTRO_URL],
  ]) {
    const fetchImpl = fetchFalso(() => respostaPng());
    const res = await servir(lib, { prisma: prismaFalso({ [SKU]: valor }), fetchImpl, indice });
    assert.equal(res.status, 200, `índice ${indice}`);
    assert.equal(fetchImpl.chamadas[0].url, esperado, `o índice ${indice} aponta para a imagem certa`);
  }
}

async function casoSoRespostaDe200(lib) {
  // Um 2xx que não seja 200 (206 com corpo parcial, por exemplo) não é a imagem inteira. Tem de dar 404.
  for (const status of [201, 206]) {
    const fetchImpl = fetchFalso(() => new Response(PNG, { status, headers: { "Content-Type": "image/png" } }));
    const res = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl });
    assert.equal(res.status, 404, `status ${status} não é 200`);
  }
}

async function casoIndiceSemTeto(lib) {
  // Produto com 21 fotos: a 21.ª (índice 20) tem de ser servida, porque a tira do modal a mostra.
  const valor = Array.from({ length: 21 }, (_, i) => `https://${HOST}/sintetico-${i}.png`).join(",");
  const fetchImpl = fetchFalso(() => respostaPng());
  const res = await servir(lib, { prisma: prismaFalso({ [SKU]: valor }), fetchImpl, indice: 20 });
  assert.equal(res.status, 200, "índice 20 de 21 imagens");
  assert.equal(fetchImpl.chamadas[0].url, `https://${HOST}/sintetico-20.png`);
}

async function casoLiberaLigacao(lib) {
  // Respostas que não são a imagem: o corpo tem de ser cancelado, para a ligação ao fornecedor não ficar aberta.
  const casos = [
    ["3xx", 302, "image/png"],
    ["erro 500", 500, "image/png"],
    ["tipo errado", 200, "text/html"],
  ];
  for (const [motivo, status, tipo] of casos) {
    const corpo = corpoComCancelamento([new Uint8Array(4)]);
    const fetchImpl = fetchFalso(() => new Response(corpo.stream, { status, headers: { "Content-Type": tipo } }));
    const res = await servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl });
    assert.equal(res.status, 404, motivo);
    assert.equal(corpo.cancelado(), true, `a ligação é libertada (${motivo})`);
  }

  // Content-Length acima do limite: recusa-se sem ler, e também se liberta a ligação.
  const anunciado = corpoComCancelamento([new Uint8Array(4)]);
  const resAnunciado = await servir(lib, {
    prisma: prismaFalso({ [SKU]: URL_IMAGEM }),
    fetchImpl: fetchFalso(() => new Response(anunciado.stream, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "1000" } })),
    limiteBytes: 10,
  });
  assert.equal(resAnunciado.status, 404);
  assert.equal(anunciado.cancelado(), true, "a ligação é libertada (Content-Length)");

  // Sem Content-Length, a leitura pára ao passar do limite e liberta a ligação.
  const grande = corpoComCancelamento([new Uint8Array(6), new Uint8Array(6)]);
  const resGrande = await servir(lib, {
    prisma: prismaFalso({ [SKU]: URL_IMAGEM }),
    fetchImpl: fetchFalso(() => new Response(grande.stream, { status: 200, headers: { "Content-Type": "image/png" } })),
    limiteBytes: 10,
  });
  assert.equal(resGrande.status, 404);
  assert.equal(grande.cancelado(), true, "a ligação é libertada no limite");
}

async function casoCorpoParadoDaTimeout(lib) {
  // O corpo chega aos bocados e depois pára. Quando o tempo acaba, a leitura tem de falhar: nunca sai imagem parcial.
  const vivo = setTimeout(() => {}, 2000);
  try {
    const fetchImpl = fetchFalso((url, init) => {
      let controlador;
      const stream = new ReadableStream(
        {
          start(c) {
            controlador = c;
            c.enqueue(new Uint8Array(4));
          },
        },
        { highWaterMark: 0 }
      );
      init.signal.addEventListener("abort", () => controlador.error(init.signal.reason));
      return new Response(stream, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    const { resultado: res, avisos } = await comAvisos(() =>
      servir(lib, { prisma: prismaFalso({ [SKU]: URL_IMAGEM }), fetchImpl, tempoLimiteMs: 20 })
    );
    assert.equal(res.status, 404, "corpo parado: sem imagem parcial");
    assert.deepEqual(avisos, ["[catalog-image] FALHA TimeoutError"]);
  } finally {
    clearTimeout(vivo);
  }
}

function casoSkuDoCaminho(lib) {
  assert.equal(lib.skuDoCaminho("/api/catalog-image/A%252FB/0"), "A%2FB", "o SKU com %2F escrito à letra não vira A/B");
  assert.equal(lib.skuDoCaminho("/api/catalog-image/SKU-SINTETICO%2F1/2"), "SKU-SINTETICO/1");
  assert.equal(lib.skuDoCaminho("/api/catalog-image/A%2FB/0/"), "A/B", "barra final ignorada");
  assert.equal(lib.skuDoCaminho("/api/catalog-image/%E0%A4%A/0"), null, "codificação partida");
  assert.equal(lib.skuDoCaminho("/api/catalog-image/SKU-SINTETICO"), null, "forma errada");
}

/**
 * Verificação estática da rota: a BD passa por safePrisma com rethrow, e o SKU sai do caminho cru.
 * Devolve true no estado bom.
 */
function rotaSeguraDaBd(texto) {
  const usaSafePrisma = /safePrisma\(\s*"catalog-image"\s*,[\s\S]*?\{\s*rethrow:\s*true\s*\}\s*\)/.test(texto);
  const skuDoCaminho = /skuDoCaminho\(\s*new URL\(request\.url\)\.pathname\s*\)/.test(texto);
  return usaSafePrisma && skuDoCaminho;
}

/**
 * Verificação estática da rota: loader sim, action não, e nenhum import de autenticação ou sessão.
 * Devolve a lista de problemas. Lista vazia é o estado bom.
 */
function errosDaRota(texto) {
  const erros = [];
  if (!/export\s+(async\s+function|function|const)\s+loader\b/.test(texto)) erros.push("sem loader");
  if (/export\s+(async\s+function|function|const|let)\s+action\b/.test(texto) || /export\s*\{[^}]*\baction\b/.test(texto)) {
    erros.push("exporta action");
  }
  const importacoes = texto.match(/^\s*import\b[^;]*;/gm) || [];
  for (const importacao of importacoes) {
    if (/auth|session|shopify/i.test(importacao)) erros.push(`importa autenticação: ${importacao.trim()}`);
  }
  return erros;
}

// ---------- execução ----------

await caso("(1) feliz: 200, corpo igual, Content-Type sem parâmetros, Cache-Control e nosniff", () => casoFeliz(libReal));
await mutante("M01-nosniff", `"X-Content-Type-Options": "nosniff"`, `"X-Teste": "1"`, casoFeliz);

await caso("(2) host fora da lista: 404 e o fetch não é chamado", () => casoHostForaDaLista(libReal));
await mutante("M02-host", "if (!fornecedoresPermitidos.has(url.hostname)) return null;", "if (false) return null;", casoHostForaDaLista);

await caso("(3) esquema http: 404 e o fetch não é chamado", () => casoHttp(libReal));
await mutante("M03-protocolo", `if (url.protocol !== "https:") return null;`, "if (false) return null;", casoHttp);

await caso("(4) porta não padrão e credenciais no URL: 404 e o fetch não é chamado", () => casoPortaECredenciais(libReal));
await mutante("M04-porta", `if (url.port !== "") return null;`, "if (false) return null;", casoPortaECredenciais);
await mutante("M05-credenciais", `if (url.username !== "" || url.password !== "") return null;`, "if (false) return null;", casoPortaECredenciais);

await caso("(5) 3xx é erro, e o fetch recebe redirect manual", () => casoRedirecionamento(libReal));
await mutante("M06-seguir-redirect", `redirect: "manual",`, `redirect: "follow",`, casoRedirecionamento);

await caso("(6) Content-Length acima do limite: 404 sem ler o corpo", () => casoContentLengthAcimaDoLimite(libReal));
await mutante("M07-content-length", "tamanho > limiteBytes) {", "tamanho > Infinity) {", casoContentLengthAcimaDoLimite);

await caso("(7) corpo acima do limite sem Content-Length: 404", () => casoCorpoAcimaDoLimiteSemContentLength(libReal));
await mutante("M08-corpo-sem-limite", "if (total > limiteBytes) {", "if (total < 0) {", casoCorpoAcimaDoLimiteSemContentLength);

await caso("(8) tipo errado (HTML e SVG): 404", () => casoTipoErrado(libReal));
await mutante("M09-tipo", "if (!TIPOS_PERMITIDOS.has(tipo)) {", "if (false) {", casoTipoErrado);

await caso("(9) SKU inexistente: 404; SKU inválido: 404 sem tocar na BD", () => casoSkuEIndiceInvalidosOuInexistentes(libReal));
await mutante("M10-sku-invalido", "!skuValido(sku) || ", "", casoSkuEIndiceInvalidosOuInexistentes);
await mutante("M11-sku-inexistente", "if (!linha) return naoEncontrada();", "if (!linha) return new Response(null, { status: 200 });", casoSkuEIndiceInvalidosOuInexistentes);

await caso("(10) índice fora da lista: 404", () => casoIndiceForaDaLista(libReal));
await mutante("M12-indice", "const url = lista[indice];", "const url = lista[indice] ?? lista[0];", casoIndiceForaDaLista);

await caso("(11) o fetch nunca recebe Referer", () => casoSemReferer(libReal));
await mutante("M13-referer", `"User-Agent": USER_AGENT },`, `"User-Agent": USER_AGENT, Referer: "https://app.exemplo.example/" },`, casoSemReferer);

await caso("(12) erro de rede, aborto e timeout: 404, e o log só tem o nome da classe", () => casoErrosDeRede(libReal));
await mutante("M14-sem-catch", "} catch (err) {", "} catch (err) { throw err;", casoErrosDeRede);
await mutante("M15-log-com-mensagem", `(err?.name || "erro")`, `(err?.message || "erro")`, casoErrosDeRede);

await caso("(13) a rota: exporta loader, não exporta action, sem imports de autenticação", () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  assert.deepEqual(errosDaRota(texto), []);
});
await caso("mutação M16-rota-action (em memória): um action deixa o POST passar", async () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  const mutado = texto + "\nexport async function action() {\n  return null;\n}\n";
  await mutacaoTemDeFalhar("M16-rota-action", () => assert.deepEqual(errosDaRota(mutado), []));
});
await caso("mutação M17-rota-auth (em memória): um import de autenticação passa", async () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  const mutado = 'import { authenticate } from "../../app/utils/authenticate.server";\n' + texto;
  await mutacaoTemDeFalhar("M17-rota-auth", () => assert.deepEqual(errosDaRota(mutado), []));
});

await caso("(14) lista com protocolo relativo: a rota serve a lista que o painel mostra", () => casoListaComProtocoloRelativo(libReal));
await mutanteProductImages(
  "M18-protocolo-relativo",
  'const clean = limpo.startsWith("//") ? "https:" + limpo : limpo;',
  "const clean = limpo;",
  casoListaComProtocoloRelativo
);

await caso("(15) ordem das imagens: cada índice aponta para a imagem certa", () => casoOrdemDasImagens(libReal));
await mutante("M19-ordem", "const lista = resolveAllProductImages(linha.imageUrl);", "const lista = resolveAllProductImages(linha.imageUrl).reverse();", casoOrdemDasImagens);

await caso("(16) só 200 é imagem: 201 e 206 dão 404", () => casoSoRespostaDe200(libReal));
await mutante("M20-status", "if (res.status !== 200) {", "if (res.status >= 300) {", casoSoRespostaDe200);

await caso("(17) índice sem teto: a 21.ª imagem (índice 20) é servida", () => casoIndiceSemTeto(libReal));
await mutante("M21-teto", "return Number.isInteger(indice) && indice >= 0;", "return Number.isInteger(indice) && indice >= 0 && indice <= 19;", casoIndiceSemTeto);

await caso("(18a) a ligação ao fornecedor é libertada em 3xx, erro, tipo errado e limite", () => casoLiberaLigacao(libReal));
await mutante("M22-cancelar", "await res.body?.cancel();", "", casoLiberaLigacao);
await mutante("M23-limite-cancel", "await leitor.cancel().catch(() => {});", "", casoLiberaLigacao);

await caso("(18b) corpo parado: a timeout dá 404 e nunca uma imagem parcial", () => casoCorpoParadoDaTimeout(libReal));
await mutante(
  "M24-corpo-erro",
  "const { done, value } = await leitor.read();",
  "const { done, value } = await leitor.read().catch(() => ({ done: true }));",
  casoCorpoParadoDaTimeout
);

await caso("(19) o SKU vem do caminho cru, descodificado uma vez", () => casoSkuDoCaminho(libReal));
await mutante("M25-sku-duplo", "return decodeURIComponent(partes[2]);", "return decodeURIComponent(decodeURIComponent(partes[2]));", casoSkuDoCaminho);

await caso("(20) a rota: a BD passa por safePrisma com rethrow, e o SKU sai do caminho cru", () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  assert.equal(rotaSeguraDaBd(texto), true);
});
await caso("mutação M26-rota-sem-safePrisma (em memória): a leitura direta da BD passa", async () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  const mutado = trocaUma(
    texto,
    "M26-rota-sem-safePrisma",
    'safePrisma("catalog-image", () => prisma.catalogProduct.findUnique(args), { rethrow: true })',
    "prisma.catalogProduct.findUnique(args)"
  );
  await mutacaoTemDeFalhar("M26-rota-sem-safePrisma", () => assert.equal(rotaSeguraDaBd(mutado), true));
});
await caso("mutação M27-rota-sku-do-parametro (em memória): params.sku passa", async () => {
  const texto = fs.readFileSync(path.join(REPO, ROTA), "utf8");
  const mutado = trocaUma(texto, "M27-rota-sku-do-parametro", "skuDoCaminho(new URL(request.url).pathname)", "params.sku");
  await mutacaoTemDeFalhar("M27-rota-sku-do-parametro", () => assert.equal(rotaSeguraDaBd(mutado), true));
});

if (falhas) {
  console.error(`${falhas} falha(s)`);
  process.exit(1);
}
console.log("catalog-image-proxy — todos os casos passaram");
