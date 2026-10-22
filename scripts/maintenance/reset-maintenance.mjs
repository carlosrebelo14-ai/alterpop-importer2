#!/usr/bin/env node
/* eslint-env node */
// Tarefa reset_maintenance: dry-run e execução do reset Shopify em produção, por ssh, com o motor de 605e20a.
//
// Corre na Fly por stdin, sem argumentos (scripts/ci/maintenance.sh, tarefas reset_dry_run e reset_execute):
//   cd /app && echo <base64> | base64 -d | RESET_MODO=<dry|execute> RESET_OK=<12 hex> node --input-type=module -
// RESET_OK só se lê com RESET_MODO=execute. Os módulos do motor carregam-se por caminho relativo a process.cwd(),
// com import() dinâmico. Por isso não há import relativo, nem import.meta, nem process.argv.
//
// Repositório público: o stdout tem SÓ as linhas do contrato. O que o motor e o Prisma escrevem na consola ou no
// stdout é descartado, por isso nenhum SKU, GID, título ou mensagem de erro chega aos logs. Os erros saem só como classe.
//
// Contrato (lido por scripts/ci/maintenance.sh e pelos testes):
//   RS: produtos_na_loja=<n> itens_publicados=<n> impressao=<12 hex>
//   RS_ESTADO: estado=<PENDING|APPROVED|REJECTED|PUBLISHED|SYNC_ERROR|outro> n=<n>
//   RS_D2: decisoes_humanas_mantidas=<n>
//   RS_GUARDAS: indexacao=<livre|ocupada> reserva=<livre|ocupada> trinco=<livre|ocupada> db_degradado=<nao|sim>
//   RS_RESULTADO: modo=execute apagados=<n> revertidos=<n> falhados=<n> produtos_restantes=<n|?> published_restantes=<n|?>
//   RS_ERRO: classe=<guarda|impressao_diferente|reserva_ocupada|motor_falhou|leitura_falhou|entrada_invalida>
// As linhas RS, RS_ESTADO, RS_D2 e RS_GUARDAS saem nos dois modos, antes de qualquer escrita.
// Um ? em RS_RESULTADO quer dizer que essa leitura final falhou. O reset já correu, e a classe diz o resto.
// Códigos de saída: 0 ok; 64 entrada inválida; 3 impressão diferente; 4 guarda ou reserva recusa;
// 2 leitura falhou; 1 motor falhou.
//
// Impressão digital: sha256 dos productIds a apagar, por ordem de código e sem repetições, juntos por "\n".
// Ficam os 12 primeiros hex. Confere-se antes da reserva (sem escrita) e outra vez dentro dela. Só apaga se bater
// com RESET_OK. Depois do reset confere-se o total que o motor apagou: o motor relista a loja por conta própria,
// por isso essa conferência só deteta uma diferença, não a impede.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// O motor e o Prisma escrevem na consola e no stdout ao carregar. Só as linhas do contrato saem, por esta via.
const escreverNoStdout = process.stdout.write.bind(process.stdout);
const linha = (texto) => escreverNoStdout(`${texto}\n`);
const descartar = () => true;
for (const metodo of ["log", "info", "warn", "error", "debug"]) console[metodo] = descartar;
process.stdout.write = descartar;
process.stderr.write = descartar;

const ESTADOS = ["APPROVED", "PENDING", "PUBLISHED", "REJECTED", "SYNC_ERROR"];
const CODIGO_DE_SAIDA = {
  entrada_invalida: 64,
  impressao_diferente: 3,
  guarda: 4,
  reserva_ocupada: 4,
  leitura_falhou: 2,
  motor_falhou: 1,
};
const RESET_OK_RE = /^[0-9a-f]{12}$/;
// Mesmo prazo do motor: um trinco ou um job sem escrita há 10 min conta como parado.
const PRAZO_OBSOLETO_MS = 10 * 60 * 1000;
// Estados em que um reset já arrancou e pode ser retomado. O D2 conta desde o primeiro arranque.
const ESTADOS_DE_RETOMA = new Set(["running", "listing", "deleting", "failed"]);

/** Erro do driver com classe fechada. A mensagem do erro do motor fica de fora: pode trazer dados da loja. */
class FalhaDoDriver extends Error {
  constructor(classe) {
    super(classe);
    this.classe = classe;
  }
}
const falhar = (classe) => new FalhaDoDriver(classe);

/** Chama o motor ou uma leitura. Qualquer erro vira só a classe. */
async function chamar(classe, fn) {
  try {
    return await fn();
  } catch {
    throw falhar(classe);
  }
}

/** Leitura final que falha dá null. O reset já aconteceu, e não se perde o resto por isso. */
async function tentar(fn) {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const caminhoDoMotor = (relativo) => pathToFileURL(path.join(process.cwd(), relativo)).href;

/** Impressão digital da lista a apagar: 12 hex do sha256 dos ids, por ordem de código e sem repetições. */
function impressaoDaLista(ids) {
  const ordenados = [...new Set(ids)].sort(comparar);
  return crypto.createHash("sha256").update(ordenados.join("\n")).digest("hex").slice(0, 12);
}

const processoExiste = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM quer dizer que o processo existe, só que não é nosso.
    return err?.code !== "ESRCH";
  }
};

/**
 * Trinco de publicação, lido sem o tomar: o dry-run não escreve. Espelha o motor (curationQueueFileLock): PID morto,
 * ou data anterior ao arranque da máquina, ou sem renovação há 10 min, é obsoleto. Conteúdo ilegível sem data
 * conta pela data de escrita do ficheiro; sem ela, conta como ocupado.
 */
function trincoOcupado(caminho) {
  let texto;
  try {
    texto = fs.readFileSync(caminho, "utf8");
  } catch (err) {
    return err?.code !== "ENOENT";
  }
  let dados = null;
  try {
    dados = JSON.parse(texto);
  } catch {
    dados = null;
  }
  const pid = Number.isInteger(dados?.pid) && dados.pid > 0 ? dados.pid : null;
  if (pid !== null && !processoExiste(pid)) return false;
  let referencia = typeof dados?.em === "string" ? Date.parse(dados.em) : NaN;
  if (!Number.isFinite(referencia)) {
    try {
      referencia = fs.statSync(caminho).mtimeMs;
    } catch {
      return false;
    }
  }
  if (referencia < Date.now() - os.uptime() * 1000) return false;
  return Date.now() - referencia <= PRAZO_OBSOLETO_MS;
}

/** Sync Shopify em curso: estado running e escrita recente. Sem data não se prova que parou, e conta como ativo. */
function syncAtivo(sync) {
  if (sync?.state !== "running") return false;
  const sinal = Date.parse(sync.updatedAt || sync.startedAt || "");
  if (!Number.isFinite(sinal)) return true;
  return Date.now() - sinal <= PRAZO_OBSOLETO_MS;
}

/**
 * Guardas em livre ou ocupada. Atividade ilegível conta como ocupada nas duas: não se sabe o que é, e o motor também
 * recusa. Com `propria`, a reserva já é deste processo, e o marcador de publicação que ele deixou não conta.
 */
function avaliarGuardas(sinais, { propria }) {
  const { atividade, script, rebuild, sync, resetVivo, db } = sinais;
  const indexacao =
    atividade?.tipo === "indexacao" ||
    atividade?.tipo === "desconhecida" ||
    Boolean(script) ||
    rebuild?.state === "running" ||
    rebuild?.indexing === true;
  const reserva =
    (!propria && atividade?.tipo === "publicacao") ||
    atividade?.tipo === "desconhecida" ||
    syncAtivo(sync) ||
    resetVivo === true;
  return {
    indexacao: indexacao ? "ocupada" : "livre",
    reserva: reserva ? "ocupada" : "livre",
    db: db ? "sim" : "nao",
  };
}

/**
 * Classe da recusa antes de tomar a reserva, ou null. O trinco não entra aqui: a própria tomada é a prova, e um trinco
 * obsoleto não deve travar a execução.
 */
function classeDaRecusa(guardas) {
  if (guardas.db === "sim" || guardas.indexacao === "ocupada") return "guarda";
  if (guardas.reserva === "ocupada") return "reserva_ocupada";
  return null;
}

/**
 * Espelha decidiuUmHumano do motor (D2, Decisão 35), que não se exporta: estado diferente de PUBLISHED e
 * statusChangedAt depois do arranque do primeiro reset. Sem arranque (desde null), nada se decidiu depois.
 */
function decidiuUmHumano(item, desde) {
  if (desde === null || !item.statusChangedAt || item.status === "PUBLISHED") return false;
  const quando = Date.parse(item.statusChangedAt);
  return Number.isFinite(quando) && quando > desde;
}

/** Instante do primeiro arranque, em ms, quando há um reset a retomar (D39). Sem retoma, null. */
function instanteDaRetoma(job) {
  if (!ESTADOS_DE_RETOMA.has(job?.state)) return null;
  const quando = Date.parse(job.inicioDoPrimeiroArranque || job.startedAt || "");
  return Number.isFinite(quando) ? quando : null;
}

/**
 * D2: decisões humanas que o reset mantém. Conta o que o motor conta em reverterTodosPublicados: itens com vínculo à
 * Shopify (metadata.shopifyProductId), fora de SYNC_ERROR, decididos depois do arranque. O resto não entra.
 */
function decisoesHumanasMantidas(itens, desde) {
  return itens.filter(
    (item) => item.status !== "SYNC_ERROR" && item.metadata?.shopifyProductId && decidiuUmHumano(item, desde),
  ).length;
}

/**
 * Estado da fila depois do reset, com a regra do motor (reverterTodosPublicados, deletedInAdmin): um item com vínculo,
 * ou PUBLISHED, passa a PENDING, salvo decisão humana (D2). SYNC_ERROR fica como está. O motor não dá isto no dry-run,
 * porque não recebe o instante do arranque, e daria mais PENDING do que a execução deixa.
 */
function estadoFinalSimulado(itens, desde) {
  const contagem = {};
  for (const item of itens) {
    const vai =
      item.status !== "SYNC_ERROR" &&
      (item.status === "PUBLISHED" || item.metadata?.shopifyProductId) &&
      !decidiuUmHumano(item, desde);
    const estado = vai ? "PENDING" : item.status;
    contagem[estado] = (contagem[estado] || 0) + 1;
  }
  return contagem;
}

/**
 * Loja Shopify. A mesma ordem que o purge usa para a loja de escrita. Sem loja, a entrada está incompleta.
 */
function lerShop() {
  const shop = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP;
  if (!shop) throw falhar("entrada_invalida");
  return shop;
}

/** O motor de 605e20a, carregado da raiz da app (/app na Fly). Só se importa o que existe nesse commit. */
async function carregarMotor() {
  return {
    reset: await import(caminhoDoMotor("lib/importer/shopify/shopifyReset.server.js")),
    publicacao: await import(caminhoDoMotor("lib/importer/shopify/publicacaoEmCurso.js")),
    atividade: await import(caminhoDoMotor("lib/curation/atividadeApp.js")),
    rebuild: await import(caminhoDoMotor("lib/importer/catalog/catalogRebuildStatus.server.js")),
    db: await import(caminhoDoMotor("lib/health/dbDegraded.js")),
    fila: await import(caminhoDoMotor("lib/curation/curationQueue.server.js")),
    job: await import(caminhoDoMotor("lib/importer/shopify/shopifyResetJob.server.js")),
    sync: await import(caminhoDoMotor("lib/importer/shopify/shopifySyncJob.server.js")),
  };
}

/** Sinais de atividade, só leitura. Cada um vem da fonte que o motor e as rotas usam. */
async function lerSinais(motor, shop) {
  const atividade = motor.atividade.atividadeAppEmCurso();
  const script = motor.atividade.scriptDeIndexacaoEmCurso();
  const rebuild = await chamar("leitura_falhou", () => motor.rebuild.readCatalogRebuildStatusFromDisk(shop));
  const sync = await chamar("leitura_falhou", () => motor.sync.readShopifySyncStatus(shop));
  const resetVivo = await chamar("leitura_falhou", () => motor.job.isShopifyResetRunning(shop));
  return { atividade, script, rebuild, sync, resetVivo, db: motor.db.readDbDegraded() };
}

/** Ids de todos os produtos da loja. O reset apaga a loja toda (scope 'all'), por isso a lista é a da loja. */
async function listarIds(motor, shop) {
  const { products } = await chamar("leitura_falhou", () =>
    motor.reset.collectProductsForShopifyReset({ shop }, { scope: "all" }),
  );
  return products.map((produto) => produto.id);
}

/**
 * Fotografia do estado. Não escreve na loja, na fila nem no estado do reset. A única escrita possível é a da sessão
 * offline, quando o token expirou e o motor o renova (benigno). É o dry-run, e também o ponto de partida da execução.
 */
async function fotografia(motor, shop) {
  // A fila conta-se antes da simulação do motor, como no contrato.
  const fila = await chamar("leitura_falhou", () => motor.fila.lerFicheiroDaFilaSemEfeitos());
  const plano = await chamar("leitura_falhou", () => motor.reset.runShopifyCatalogReset({ shop }, { dryRun: true }));
  const ids = await listarIds(motor, shop);
  const job = await chamar("leitura_falhou", () => motor.job.readShopifyResetStatus(shop));
  const sinais = await lerSinais(motor, shop);
  const trinco = trincoOcupado(motor.publicacao.caminhoDoTrincoDePublicacao()) ? "ocupada" : "livre";
  const desde = instanteDaRetoma(job);
  return {
    produtosNaLoja: plano.produtosNaLoja,
    publicados: fila.items.filter((item) => item.status === "PUBLISHED").length,
    estadoFinal: estadoFinalSimulado(fila.items, desde),
    impressao: impressaoDaLista(ids),
    d2: decisoesHumanasMantidas(fila.items, desde),
    guardas: { ...avaliarGuardas(sinais, { propria: false }), trinco },
  };
}

/** As linhas da fotografia. Os estados fora da lista saem agregados, num só 'outro'. */
function imprimirFotografia(foto) {
  linha(`RS: produtos_na_loja=${foto.produtosNaLoja} itens_publicados=${foto.publicados} impressao=${foto.impressao}`);
  for (const estado of ESTADOS) linha(`RS_ESTADO: estado=${estado} n=${foto.estadoFinal[estado] ?? 0}`);
  const outro = Object.entries(foto.estadoFinal)
    .filter(([estado]) => !ESTADOS.includes(estado))
    .reduce((soma, [, n]) => soma + n, 0);
  if (outro > 0) linha(`RS_ESTADO: estado=outro n=${outro}`);
  linha(`RS_D2: decisoes_humanas_mantidas=${foto.d2}`);
  const g = foto.guardas;
  linha(`RS_GUARDAS: indexacao=${g.indexacao} reserva=${g.reserva} trinco=${g.trinco} db_degradado=${g.db}`);
}

/** Contagens finais, lidas com a reserva ainda tomada: produtos na loja e PUBLISHED na fila. */
async function lerFinal(motor, shop) {
  const restantes = await tentar(() => motor.reset.countShopifyProductsForReset({ shop }));
  const publicados = await tentar(async () => {
    const fila = await motor.fila.lerFicheiroDaFilaSemEfeitos();
    return fila.items.filter((item) => item.status === "PUBLISHED").length;
  });
  return { restantes, publicados };
}

/** RS_RESULTADO. Um ? no lugar de uma contagem quer dizer que a leitura final falhou. */
function imprimirResultado(c, final) {
  linha(
    `RS_RESULTADO: modo=execute apagados=${c.apagados} revertidos=${c.revertidos} falhados=${c.falhados} produtos_restantes=${final.restantes ?? "?"} published_restantes=${final.publicados ?? "?"}`,
  );
}

/** Melhor esforço depois de uma falha a meio: o job diz o que chegou a apagar, e a loja e a fila dizem o que sobra. */
async function imprimirParcial(motor, shop) {
  let job = null;
  try {
    job = await motor.job.readShopifyResetStatus(shop);
  } catch {
    job = null;
  }
  const final = await lerFinal(motor, shop);
  imprimirResultado(
    { apagados: job?.deleted ?? 0, revertidos: job?.revertedLocal ?? 0, falhados: job?.failed ?? 0 },
    final,
  );
}

/** O reset real, com a reserva tomada aqui (reservaTomada). Numa falha, imprime o que o job regista e sai com a classe. */
async function apagarComContagem(motor, shop) {
  try {
    const r = await chamar("motor_falhou", () => motor.reset.runShopifyCatalogReset({ shop }, { reservaTomada: true }));
    return { apagados: r.deleted ?? 0, revertidos: r.revertedLocal ?? 0, falhados: r.failed ?? 0, total: r.total };
  } catch {
    // Parou a meio. Uma BD degradada a meio conta como guarda, não como falha do motor.
    const classe = motor.db.readDbDegraded() ? "guarda" : "motor_falhou";
    await imprimirParcial(motor, shop);
    throw falhar(classe);
  }
}

/**
 * Depois de libertar a reserva. O motor tem de ter apagado a lista aprovada: o total que devolve é o que ele listou
 * e apagou. A loja e a fila têm de ficar vazias. Se não bate, o apagamento já aconteceu, e a classe diz porquê.
 */
function conferirFim({ contadores, final, esperados }) {
  if (contadores.total !== esperados) throw falhar("impressao_diferente");
  if (final.restantes === null || final.publicados === null) throw falhar("leitura_falhou");
  if (final.restantes !== 0 || final.publicados !== 0) throw falhar("motor_falhou");
}

/** Execução: confere a impressão, toma a reserva entre processos, confere outra vez dentro dela e corre o reset real. */
async function executar(motor, shop, ok, foto) {
  const recusa = classeDaRecusa(foto.guardas);
  if (recusa) throw falhar(recusa);

  // Antes da reserva: uma impressão diferente sai sem tomar o trinco nem deixar marca. Nada é escrito.
  const idsAntes = await listarIds(motor, shop);
  if (impressaoDaLista(idsAntes) !== ok) throw falhar("impressao_diferente");

  const reserva = await chamar("motor_falhou", () =>
    motor.publicacao.reservarPublicacaoEntreProcessos({
      marcar: () => motor.atividade.marcarAtividadeApp({ tipo: "publicacao" }),
    }),
  );
  if (!reserva) throw falhar("reserva_ocupada");

  let resultado;
  try {
    // Com a reserva tomada, confirma-se o que pode ter mudado. A marca de publicação é a nossa, e não conta.
    const agora = await lerSinais(motor, shop);
    const recusaAgora = classeDaRecusa(avaliarGuardas(agora, { propria: true }));
    if (recusaAgora) throw falhar(recusaAgora);
    const ids = await listarIds(motor, shop);
    if (impressaoDaLista(ids) !== ok) throw falhar("impressao_diferente");
    // Também com a loja vazia: o motor confirma a lista vazia com uma segunda leitura, e fecha o reset (D37).
    const contadores = await apagarComContagem(motor, shop);
    // Lida com a reserva ainda tomada. Depois de a libertar, uma publicação nova deixaria um PUBLISHED que não é deste reset.
    const final = await lerFinal(motor, shop);
    imprimirResultado(contadores, final);
    resultado = { contadores, final, esperados: new Set(ids).size };
  } finally {
    await reserva.libertar();
  }
  conferirFim(resultado);
  return 0;
}

/** Corre o driver. Devolve o código de saída. As falhas saem como classe, pelo catch. */
async function principal() {
  const modo = process.env.RESET_MODO;
  if (modo !== "dry" && modo !== "execute") throw falhar("entrada_invalida");
  const ok = process.env.RESET_OK;
  if (modo === "execute" && !RESET_OK_RE.test(ok ?? "")) throw falhar("entrada_invalida");
  const shop = lerShop();
  const motor = await chamar("motor_falhou", carregarMotor);
  const foto = await fotografia(motor, shop);
  imprimirFotografia(foto);
  if (modo === "dry") return 0;
  return executar(motor, shop, ok, foto);
}

/** Sai com a classe. A mensagem do erro nunca sai. */
function sair(classe) {
  linha(`RS_ERRO: classe=${classe}`);
  process.exit(CODIGO_DE_SAIDA[classe]);
}

process.on("uncaughtException", () => sair("motor_falhou"));
process.on("unhandledRejection", () => sair("motor_falhou"));

principal()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => sair(erro instanceof FalhaDoDriver ? erro.classe : "motor_falhou"));
