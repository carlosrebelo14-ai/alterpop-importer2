#!/usr/bin/env node
/* eslint-env node */
// Tarefa image_check. Só leitura: conta as imagens do catálogo e vê se as miniaturas as conseguem carregar.
//
// Corre na Fly por stdin, sem argumentos (maintenance.sh):
//   cd /app && echo <base64> | base64 -d | node --input-type=module -
// Por isso este ficheiro não importa módulos relativos, não usa import.meta nem process.argv.
// Os caminhos saem de process.cwd().
//
// Repositório público: o stdout tem SÓ as linhas do contrato (contagens, estados e o host do fornecedor).
// Nunca URL completo, SKU, caminho, cabeçalho Location nem mensagem de erro.
// O Prisma escreve no stdout ao carregar (app/db.server.js). Por isso console.log vai para stderr,
// e as linhas do contrato saem por process.stdout.write.
//
// Leitura da BD: count() e findMany paginado pela chave (shop, sku), em lotes de 1000. O script não escreve.
// Ao carregar o cliente, a app põe a BD em WAL (app/db.server.js), como no arranque: numa BD já em WAL não há
// escrita. Numa BD em modo rollback, essa mudança reescreve o cabeçalho do ficheiro.
// Sem BD no volume sai antes de importar o Prisma: senão o SQLite criaria um ficheiro vazio (DBG-87).
//
// Contrato (lido por maintenance.sh e pelos testes):
//   IC: total=<n> vazio=<n> https=<n> http=<n> invalido=<n> multi=<n>
//   IC_HOST: pos=<1..5> host=<host> n=<n>   (só hosts com 2 ou mais linhas)
//   IC_AMOSTRA: pedidas=20 obtidas=<n> https=<n> http=<n>
//   IC_HTTPS: testadas=<m> ok=<n> com_erro=<k>   (m = linhas http da amostra; ok = 200 com image/*, pedido com https e sem Referer)
//   IC_TOTAIS: ok_sem_referer=<n> ok_referer_app=<n> para_https=<n> para_http=<n> com_erro=<n>
//   IC_RESULTADO: n=<n> esquema=<https|http> sem_referer=<cod> app=<cod> redireciona=<nao|para_https|para_http|sem_location|outro_esquema> destino=<mesmo|-|host|outro>
//     Os redirecionamentos não se seguem: o 3xx fica registado, com o esquema e o destino do Location. O host do destino só sai com 2 ou mais linhas no catálogo; senão, outro.
//   IC_ERRO: classe=<catalogo_falhou|catalogo_mudou|modulo_falhou>   (exit 1, e nada mais no stdout)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Os módulos do Prisma usam console.log. Essa saída vai para stderr, para o stdout ter só o contrato.
console.log = (...args) => console.error(...args);
const linha = (texto) => process.stdout.write(`${texto}\n`);

const TAMANHO_LOTE = 1000;
const TAMANHO_AMOSTRA = 20;
const TIMEOUT_MS = 10_000;
// Browser de desktop, e o mesmo pedido de imagem que a miniatura e o modal fazem.
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
const REFERER_APP = "https://alterpop-importer-app.fly.dev/";
// Mesmas regras de resolveAllProductImages (app/components/CatalogProductThumbnail.jsx).
const SEPARADORES = /[,;|\n\r]+/;
const URL_VALIDO = /^https?:\/\/[^\s]+/i;
// Código de erro de rede: só um token de maiúsculas, para nada do texto do erro sair.
const CODIGO_REDE = /^[A-Z0-9_]{1,40}$/;

/** Caminho da BD como o Prisma o abre. Mesma regra de dbFilePath (lib/health/dbDegraded.js). */
function caminhoDaBd() {
  const bruto = (process.env.DATABASE_URL || "file:/app/data/dev.sqlite").replace(/^file:/, "");
  return path.isAbsolute(bruto) ? bruto : path.resolve(process.cwd(), "prisma", bruto);
}

function comparar(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Partes com URL válido, pela regra da miniatura: divide, tira espaços e aspas, e fica com as que casam.
 * @param {string} bruto
 * @returns {string[]}
 */
function partesValidas(bruto) {
  const partes = [];
  for (const parte of bruto.split(SEPARADORES)) {
    const limpo = parte.trim().replace(/^["']|["']$/g, "");
    if (limpo && URL_VALIDO.test(limpo)) partes.push(limpo);
  }
  return partes;
}

/**
 * Classifica uma linha. `multi` conta à parte e não tira a linha do seu balde.
 * Só https e http são elegíveis: têm primeiro URL válido, e levam host e amostra.
 * @param {string | null | undefined} imageUrl
 */
function classificar(imageUrl) {
  if (imageUrl === null || imageUrl === undefined) return { balde: "vazio", multi: false };
  const bruto = String(imageUrl);
  if (bruto.trim() === "") return { balde: "vazio", multi: false };
  const partes = partesValidas(bruto);
  const multi = partes.length > 1;
  if (partes.length === 0) return { balde: "invalido", multi };
  let url;
  try {
    url = new URL(partes[0]);
  } catch {
    return { balde: "invalido", multi };
  }
  const balde = url.protocol === "https:" ? "https" : "http";
  return { balde, multi, primeiro: partes[0], host: url.host };
}

function novoAcumulador() {
  return { total: 0, vazio: 0, https: 0, http: 0, invalido: 0, multi: 0, hosts: new Map(), elegiveis: 0, amostra: [] };
}

/**
 * Soma uma linha. A amostra é reservoir sampling numa só passagem: cada elegível fica com probabilidade
 * 20/N e sem repetições. Só guarda o URL e o esquema das 20 escolhidas.
 */
function acumular(acum, imageUrl) {
  const c = classificar(imageUrl);
  acum.total += 1;
  if (c.multi) acum.multi += 1;
  acum[c.balde] += 1;
  if (c.balde !== "https" && c.balde !== "http") return;
  acum.hosts.set(c.host, (acum.hosts.get(c.host) || 0) + 1);
  const k = acum.elegiveis;
  acum.elegiveis += 1;
  const item = { url: c.primeiro, esquema: c.balde };
  if (k < TAMANHO_AMOSTRA) {
    acum.amostra.push(item);
  } else {
    const j = crypto.randomInt(0, k + 1);
    if (j < TAMANHO_AMOSTRA) acum.amostra[j] = item;
  }
}

/**
 * Lê o catálogo inteiro. Paginação por (shop, sku), com o WHERE da chave e não com cursor/skip:
 * não salta linhas se uma linha desaparecer entre lotes. Só imageUrl é classificado. shop e sku
 * servem de cursor e não ficam guardados.
 */
async function lerCatalogo(prisma) {
  const acum = novoAcumulador();
  const total = await prisma.catalogProduct.count();
  let cursor = null;
  let lidas = 0;
  for (;;) {
    const lote = await prisma.catalogProduct.findMany({
      where: cursor ? { OR: [{ shop: { gt: cursor.shop } }, { shop: cursor.shop, sku: { gt: cursor.sku } }] } : undefined,
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: TAMANHO_LOTE,
      select: { shop: true, sku: true, imageUrl: true },
    });
    if (lote.length === 0) break;
    for (const linhaDoCatalogo of lote) acumular(acum, linhaDoCatalogo.imageUrl);
    lidas += lote.length;
    const ultima = lote[lote.length - 1];
    cursor = { shop: ultima.shop, sku: ultima.sku };
    if (lote.length < TAMANHO_LOTE) break;
  }
  // Se o catálogo mudou entre count() e a leitura, o total não fecha a conta. Sai falha, não um número errado.
  // A classe própria deixa o maintenance.sh dizer "mudou durante a leitura" (indexação?), e não "não li o catálogo".
  if (lidas !== total) throw Object.assign(new Error("catalogo_mudou"), { classe: "catalogo_mudou" });
  return acum;
}

/**
 * Os cinco hosts mais frequentes, por n decrescente e depois por nome. Só entram hosts com 2 ou mais linhas:
 * um host de uma linha pode ser o de um só produto, com o SKU no nome, e não o do fornecedor.
 */
function topHosts(hosts) {
  return [...hosts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || comparar(a[0], b[0]))
    .slice(0, 5);
}

/** Tipo a partir do content-type: imagem, nao_imagem, ou - se vazio. */
function tipoDoConteudo(valor) {
  const s = (valor || "").trim().toLowerCase();
  if (!s) return "-";
  return s.startsWith("image/") ? "imagem" : "nao_imagem";
}

/**
 * O destino de um 3xx, sem o seguir. O Location resolve-se contra o pedido. O host só sai se tiver 2 ou mais
 * linhas no catálogo, a mesma regra da lista de hosts. Se não, sai "outro". O cabeçalho em bruto não sai.
 * @param {string | null} localizacao
 * @param {string} urlPedido
 * @param {Set<string>} hostsComDuas
 */
function destinoDoRedirecionamento(localizacao, urlPedido, hostsComDuas) {
  if (!localizacao) return { redireciona: "sem_location", destino: "-" };
  let alvo;
  try {
    alvo = new URL(localizacao, urlPedido);
  } catch {
    return { redireciona: "sem_location", destino: "outro" };
  }
  if (alvo.protocol !== "https:" && alvo.protocol !== "http:") return { redireciona: "outro_esquema", destino: "outro" };
  const redireciona = alvo.protocol === "https:" ? "para_https" : "para_http";
  if (alvo.host === new URL(urlPedido).host) return { redireciona, destino: "mesmo" };
  return { redireciona, destino: hostsComDuas.has(alvo.host) ? alvo.host : "outro" };
}

/**
 * Um GET parecido com o que o browser faz à miniatura. Sai da Fly, com IP de datacenter, não do browser.
 * Não segue redirecionamentos: o 3xx fica registado, com o esquema e o destino do Location.
 * Lê só o estado, o tipo e o destino, e cancela o corpo.
 * Nunca guarda bytes, nem a mensagem do erro.
 */
async function pedir(url, referer, hostsComDuas) {
  const controlo = new AbortController();
  const temporizador = setTimeout(() => controlo.abort(), TIMEOUT_MS);
  const headers = { "User-Agent": USER_AGENT, Accept: ACCEPT };
  if (referer) headers.Referer = referer;
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: controlo.signal });
    const redirecionamento = res.status >= 300 && res.status < 400;
    const tipo = redirecionamento ? "-" : tipoDoConteudo(res.headers.get("content-type"));
    const { redireciona, destino } = redirecionamento
      ? destinoDoRedirecionamento(res.headers.get("location"), url, hostsComDuas)
      : { redireciona: "nao", destino: "-" };
    try {
      await res.body?.cancel();
    } catch {
      // O corpo não interessa: basta o estado.
    }
    return { cod: `${res.status}/${tipo}`, erro: false, status: res.status, tipo, redireciona, destino };
  } catch (err) {
    if (err?.name === "AbortError") return { cod: "timeout/-", erro: true, status: null, tipo: null, redireciona: "nao", destino: "-" };
    // Sem err.message: pode trazer o URL. Só o código de rede, se for um token simples.
    const codigo = err?.cause?.code;
    const classe = typeof codigo === "string" && CODIGO_REDE.test(codigo) ? codigo : "FETCH";
    return { cod: `erro/${classe}`, erro: true, status: null, tipo: null, redireciona: "nao", destino: "-" };
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Dois pedidos por URL da amostra: sem Referer, e com o Referer da app. Uma linha http leva mais um pedido, à mesma
 * URL com https e sem Referer: é isso que diz se o https responde. Um de cada vez, para não martelar o fornecedor.
 */
async function verificarAmostra(amostra, hostsComDuas) {
  const resultados = [];
  for (const item of amostra) {
    const sem = await pedir(item.url, null, hostsComDuas);
    const app = await pedir(item.url, REFERER_APP, hostsComDuas);
    const https = item.esquema === "http" ? await pedir(item.url.replace(/^http:\/\//i, "https://"), null, hostsComDuas) : null;
    resultados.push({ esquema: item.esquema, sem, app, https });
  }
  return resultados;
}

/** Imagem = 2xx e tipo imagem. */
function ok(r) {
  return !r.erro && r.status >= 200 && r.status < 300 && r.tipo === "imagem";
}

/** Sonda https: 200 exato e tipo imagem. É o critério do arquiteto para decidir entre reescrever e proxy. */
function okHttps(r) {
  return !r.erro && r.status === 200 && r.tipo === "imagem";
}

/** Hosts com 2 ou mais linhas, como conjunto. É a regra da lista de hosts e a do destino dos redirecionamentos. */
function hostsComDuasOuMais(hosts) {
  return new Set([...hosts.entries()].filter(([, n]) => n >= 2).map(([host]) => host));
}

function resumirAmostra(resultados) {
  const totais = { ok_sem_referer: 0, ok_referer_app: 0, para_https: 0, para_http: 0, com_erro: 0 };
  const httpsTotais = { testadas: 0, ok: 0, com_erro: 0 };
  const combinacoes = new Map();
  for (const r of resultados) {
    if (ok(r.sem)) totais.ok_sem_referer += 1;
    if (ok(r.app)) totais.ok_referer_app += 1;
    if (r.sem.redireciona === "para_https") totais.para_https += 1;
    if (r.sem.redireciona === "para_http") totais.para_http += 1;
    if (r.sem.erro || r.app.erro) totais.com_erro += 1;
    if (r.https) {
      httpsTotais.testadas += 1;
      if (okHttps(r.https)) httpsTotais.ok += 1;
      if (r.https.erro) httpsTotais.com_erro += 1;
    }
    const resto = `esquema=${r.esquema} sem_referer=${r.sem.cod} app=${r.app.cod} redireciona=${r.sem.redireciona} destino=${r.sem.destino}`;
    combinacoes.set(resto, (combinacoes.get(resto) || 0) + 1);
  }
  const combinacoesOrdenadas = [...combinacoes.entries()]
    .sort((a, b) => b[1] - a[1] || comparar(a[0], b[0]))
    .map(([resto, n]) => `IC_RESULTADO: n=${n} ${resto}`);
  return { totais, httpsTotais, combinacoesOrdenadas };
}

function imprimirResultado(acum, resultados) {
  linha(`IC: total=${acum.total} vazio=${acum.vazio} https=${acum.https} http=${acum.http} invalido=${acum.invalido} multi=${acum.multi}`);
  topHosts(acum.hosts).forEach(([host, n], i) => linha(`IC_HOST: pos=${i + 1} host=${host} n=${n}`));
  const https = acum.amostra.filter((s) => s.esquema === "https").length;
  linha(`IC_AMOSTRA: pedidas=${TAMANHO_AMOSTRA} obtidas=${acum.amostra.length} https=${https} http=${acum.amostra.length - https}`);
  const { totais, httpsTotais, combinacoesOrdenadas } = resumirAmostra(resultados);
  linha(`IC_HTTPS: testadas=${httpsTotais.testadas} ok=${httpsTotais.ok} com_erro=${httpsTotais.com_erro}`);
  linha(
    `IC_TOTAIS: ok_sem_referer=${totais.ok_sem_referer} ok_referer_app=${totais.ok_referer_app} para_https=${totais.para_https} para_http=${totais.para_http} com_erro=${totais.com_erro}`,
  );
  for (const l of combinacoesOrdenadas) linha(l);
}

/** Erro sem detalhe. Devolve o código de saída. */
function falha(classe) {
  linha(`IC_ERRO: classe=${classe}`);
  return 1;
}

async function fecharPrisma(prisma) {
  try {
    await prisma.$disconnect();
  } catch {
    // A leitura já acabou. Nada a fazer.
  }
}

async function main() {
  const teste = process.env.IMAGE_CHECK_PRISMA;
  // DBG-87: sem BD no volume, o Prisma cria um SQLite vazio no primeiro acesso. Sai antes do import.
  if (!teste && !fs.existsSync(caminhoDaBd())) return falha("catalogo_falhou");

  let prisma;
  try {
    const caminho = teste || path.join(process.cwd(), "lib", "prisma", "prismaSafe.server.js");
    const modulo = await import(pathToFileURL(caminho).href);
    prisma = modulo.prisma;
    if (!prisma?.catalogProduct) throw new Error("sem_modelo");
  } catch {
    // Sem err.message: pode trazer caminhos ou dados da loja.
    return falha("modulo_falhou");
  }

  let acum = null;
  let classe = "catalogo_falhou";
  try {
    acum = await lerCatalogo(prisma);
  } catch (err) {
    // Sem err.message, pelo mesmo motivo. Só a classe, que vem de uma lista fechada.
    if (err?.classe === "catalogo_mudou") classe = "catalogo_mudou";
  }
  await fecharPrisma(prisma);
  if (!acum) return falha(classe);

  const resultados = await verificarAmostra(acum.amostra, hostsComDuasOuMais(acum.hosts));
  imprimirResultado(acum, resultados);
  return 0;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch(() => {
    linha("IC_ERRO: classe=catalogo_falhou");
    process.exit(1);
  });
