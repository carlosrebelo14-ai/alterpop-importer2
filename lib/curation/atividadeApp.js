import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveCurationDataDir } from "./dataDir.js";

/**
 * Marcadores de atividade da app (Decisão 35, D3 e D7).
 *
 * A app marca a atividade que escreve na fila (indexação do catálogo e publicação Shopify)
 * com um ficheiro `catalog-busy-<tipo>-<pid>-<token>.json` no diretório de estado da fila. O token
 * é aleatório, por marcação, para duas marcações do mesmo tipo e pid não partilharem o ficheiro.
 * Retirar uma marcação apaga só o seu ficheiro. A leitura aceita também os nomes antigos sem token. Os scripts
 * de escrita leem esses ficheiros antes de gravar e recusam se houver atividade viva. O pid
 * vem no marcador: um marcador cujo processo já não existe é uma sobra de um crash e não
 * bloqueia a fila para sempre. Um marcador ilegível conta como atividade em curso (fail closed).
 *
 * Tipos: "indexacao" (corrida de indexação, pid do processo que a arranca: a app ou um script) e "publicacao"
 * (processo principal).
 *
 * Origem (PR 5, DBG-140 e DBG-141): "app" é o padrão e cobre o worker e a publicação da app. "script" marca uma
 * reindexação por linha de comando (full-catalog-reindex.js). A app não arranca indexação nem publicação por cima de
 * um marcador de script vivo. Um marcador antigo, sem origem, conta como "app".
 */

const PREFIXO = "catalog-busy-";

/** Identificador deste processo. Distingue as marcas próprias das de outro processo com o mesmo pid (outro container). */
const PROCESSO_ID = crypto.randomUUID();

/**
 * Regista uma atividade. Devolve a função que a retira. Falha ao gravar lança erro: quem
 * chama não arranca a atividade sem marcador (fail closed).
 * @param {{ tipo: "indexacao" | "publicacao", pid?: number, dir?: string, origem?: "app" | "script" }} opcoes
 * @returns {() => void}
 */
export function marcarAtividadeApp({ tipo, pid = process.pid, dir = resolveCurationDataDir(), origem = "app" }) {
  fs.mkdirSync(dir, { recursive: true });
  const ficheiro = path.join(dir, `${PREFIXO}${tipo}-${pid}-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(
      ficheiro,
      JSON.stringify({ tipo, pid, origem, processo: PROCESSO_ID, startedAt: new Date().toISOString() }),
      "utf8"
    );
  } catch (err) {
    // PR 5 (revisão): uma escrita que falha a meio não pode deixar um marcador ilegível. Bloquearia a app 10 min.
    // Se a remoção também falhar, o erro que interessa é o da escrita.
    try {
      fs.rmSync(ficheiro, { force: true });
    } catch {
      /* sem remoção */
    }
    throw err;
  }
  return () => {
    try {
      fs.rmSync(ficheiro, { force: true });
    } catch {
      /* já retirado */
    }
  };
}

/** @param {number} pid */
function processoVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Atividade da app em curso, ou null.
 * @param {{ dir?: string }} [opcoes]
 * @returns {{ tipo: string, pid: number | null, motivo: string } | null}
 */
export function atividadeAppEmCurso({ dir = resolveCurationDataDir() } = {}) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  // Um marcador escrito antes do arranque desta máquina é sobra de uma execução anterior. Um pid
  // pode ser reutilizado noutra máquina (o processo principal costuma ser o PID 1 no container).
  const arranque = Date.now() - os.uptime() * 1000;
  for (const nome of entradas.filter((n) => n.startsWith(PREFIXO) && n.endsWith(".json")).sort()) {
    let texto;
    try {
      texto = fs.readFileSync(path.join(dir, nome), "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      // Erro de leitura não é conteúdo ilegível: não expira pelo prazo (PR 5, revisão).
      return { tipo: "desconhecida", pid: null, motivo: `marcador ilegível (${nome})` };
    }
    let dados;
    try {
      dados = JSON.parse(texto);
    } catch {
      if (marcadorIlegivelExpirou(path.join(dir, nome), nome)) continue;
      return { tipo: "desconhecida", pid: null, motivo: `marcador ilegível (${nome})` };
    }
    if (typeof dados?.pid !== "number") {
      return { tipo: "desconhecida", pid: null, motivo: `marcador sem pid (${nome})` };
    }
    const escritoEm = Date.parse(dados.startedAt);
    if (Number.isFinite(escritoEm) && escritoEm < arranque - 2000) continue;
    if (!processoVivo(dados.pid)) continue;
    return {
      tipo: String(dados.tipo || "desconhecida"),
      pid: dados.pid,
      motivo: `${dados.tipo} em curso (pid ${dados.pid}, desde ${dados.startedAt})`,
    };
  }
  return null;
}

/**
 * Para os scripts que escrevem a fila: sai com código 1 e mensagem clara se houver atividade
 * da app em curso. Não grava nada.
 * @param {string} nomeScript
 * @param {{ dir?: string }} [opcoes]
 */
export function recusarSeAtividadeApp(nomeScript, opcoes = {}) {
  const atividade = atividadeAppEmCurso(opcoes);
  if (!atividade) return;
  console.error(
    `[${nomeScript}] Recusado: a app tem atividade em curso (${atividade.motivo}). ` +
      "Espera que a indexação ou a publicação termine e corre o script de novo. Nada foi gravado."
  );
  process.exit(1);
}

/**
 * Decisão do reset Shopify (D3): devolve a mensagem de recusa (HTTP 409) ou null.
 * @param {{ indexacaoEmCurso: boolean, atividade: { tipo: string, motivo: string } | null }} estado
 * @returns {string | null}
 */
export function motivoDeRecusaDoReset({ indexacaoEmCurso, atividade }) {
  if (indexacaoEmCurso || atividade?.tipo === "indexacao") {
    return "Aguarda que a indexação em curso termine antes do reset.";
  }
  if (atividade?.tipo === "desconhecida") {
    return `Atividade da app ilegível (${atividade.motivo}). Reset recusado.`;
  }
  return null;
}

/**
 * Reindexação por script com marcador vivo, ou null (PR 5, DBG-140 e DBG-141). Lê todos os marcadores, porque um
 * marcador de script pode vir depois de um marcador da app na ordem dos nomes. Um marcador ilegível conta como script
 * em curso (fail closed), como em atividadeAppEmCurso. A `causa` diz porque se bloqueia: "script", "leitura",
 * "ilegivel" ou "sem_pid".
 * @param {{ dir?: string }} [opcoes]
 * @returns {{ tipo: "script" | "desconhecida", causa: string, pid: number | null, motivo: string } | null}
 */
export function scriptDeIndexacaoEmCurso({ dir = resolveCurationDataDir() } = {}) {
  // Assume uma loja por volume (Decisão 36): o marcador de script não leva o domínio da loja.
  let entradas;
  try {
    entradas = fs.readdirSync(dir);
  } catch {
    // Sem leitura da pasta não há prova de script. Não rebenta a guarda: a marcação da indexação falha fechada.
    return null;
  }
  const arranque = Date.now() - os.uptime() * 1000;
  for (const nome of entradas.filter((n) => n.startsWith(PREFIXO) && n.endsWith(".json")).sort()) {
    const ficheiro = path.join(dir, nome);
    let texto;
    try {
      texto = fs.readFileSync(ficheiro, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      // Erro de leitura não é conteúdo ilegível: não expira pelo prazo. Um erro transitório com um script vivo
      // há mais de 10 min não pode deixar a indexação passar (PR 5, revisão).
      return { tipo: "desconhecida", causa: "leitura", pid: null, motivo: nome };
    }
    let dados;
    try {
      dados = JSON.parse(texto);
    } catch {
      if (marcadorIlegivelExpirou(ficheiro, nome)) continue;
      return { tipo: "desconhecida", causa: "ilegivel", pid: null, motivo: nome };
    }
    if (dados?.origem !== "script") continue;
    // PR 5 (revisão): um script não se recusa a si próprio. A purga marca-se antes do worker e precisa de arrancar.
    // A exceção exige o mesmo processo, e não só o mesmo pid, porque um pid pode repetir-se noutro container.
    if (dados.pid === process.pid && dados.processo === PROCESSO_ID) continue;
    if (typeof dados.pid !== "number") {
      return { tipo: "desconhecida", causa: "sem_pid", pid: null, motivo: nome };
    }
    const escritoEm = Date.parse(dados.startedAt);
    if (Number.isFinite(escritoEm) && escritoEm < arranque - 2000) continue;
    if (!processoVivo(dados.pid)) continue;
    return { tipo: "script", causa: "script", pid: dados.pid, motivo: `pid ${dados.pid}, desde ${dados.startedAt}` };
  }
  return null;
}

/** Prazo a partir do qual um marcador ilegível deixa de contar como atividade. */
const IDADE_DE_SOBRA_MS = 10 * 60 * 1000;

/**
 * Um marcador ilegível com mais de 10 min é sobra de uma escrita interrompida, e não bloqueia para sempre. Sem pid,
 * não há como saber se o processo vive, por isso o tempo é o único critério. Fica um aviso no log com a causa.
 * @returns {boolean} true se o marcador é sobra e deve ser ignorado
 */
function marcadorIlegivelExpirou(ficheiro, nome) {
  if (idadeDoMarcadorMs(ficheiro) <= IDADE_DE_SOBRA_MS) return false;
  console.warn(`[atividade] causa=marcador_ilegivel_expirado: ${nome} ignorado (mais de 10 min).`);
  return true;
}

/**
 * Idade de um marcador em ms, pelo relógio do sistema de ficheiros. Escreve uma sonda no mesmo diretório e compara os
 * dois mtime. Sem sonda, devolve 0: o marcador conta como recente (fail closed).
 * @param {string} ficheiro
 */
function idadeDoMarcadorMs(ficheiro) {
  const sonda = path.join(path.dirname(ficheiro), `.sonda-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(sonda, "", "utf8");
    return fs.statSync(sonda).mtimeMs - fs.statSync(ficheiro).mtimeMs;
  } catch {
    return 0;
  } finally {
    fs.rmSync(sonda, { force: true });
  }
}

/**
 * Mensagem por causa de marcador de script que não se lê ou não tem pid (PR 5, revisão). Cada uma diz o que o prende.
 * Só a leitura e o JSON ilegível são julgados pelo tempo, e só o JSON ilegível expira.
 */
const MENSAGEM_DE_MARCADOR_DESCONHECIDO = {
  leitura: (nome) =>
    `Marcador de atividade da app não lido (${nome}). Não expira pelo tempo. A leitura repete-se a cada pedido: sai quando o ficheiro voltar a ler-se sem ser um script vivo, ou quando for apagado.`,
  ilegivel: (nome) =>
    `Marcador de atividade da app ilegível (${nome}). Expira 10 min depois de escrito. Antes disso, só sai quando o ficheiro for apagado.`,
  sem_pid: (nome) =>
    `Marcador de script sem pid (${nome}). Não expira pelo tempo, e sem pid não há como ver se o processo vive. Só sai quando o ficheiro for apagado.`,
};

/** Causa curta de cada marcador desconhecido, para o Relatório de Margem (sem frases de instrução). */
const CAUSA_CURTA_DE_MARCADOR_DESCONHECIDO = {
  leitura: "marcador de atividade não lido",
  ilegivel: "marcador de atividade ilegível",
  sem_pid: "marcador de script sem pid",
};

/**
 * Mensagem para recusar a indexação ou a publicação da app por causa de um script de reindexação, ou null.
 * @param {{ tipo: string, causa?: string, pid: number | null, motivo: string } | null} atividadeScript
 * @returns {string | null}
 */
export function motivoDeRecusaPorScript(atividadeScript) {
  if (!atividadeScript) return null;
  if (atividadeScript.tipo === "desconhecida") {
    const mensagem = MENSAGEM_DE_MARCADOR_DESCONHECIDO[atividadeScript.causa] ?? MENSAGEM_DE_MARCADOR_DESCONHECIDO.ilegivel;
    return mensagem(atividadeScript.motivo);
  }
  return `Reindexação por script em curso (${atividadeScript.motivo}). Espera que termine antes de continuar.`;
}

/**
 * Decisão da publicação manual e do ciclo (DBG-141): devolve { causa, mensagem } ou null. `mensagem` é a recusa
 * (HTTP 409). `causa` é a frase curta que vai para o Relatório. Recusa com indexação do catálogo em curso, porque a
 * indexação esvazia o catálogo e a publicação marca SYNC_ERROR. Recusa também com script.
 * @param {{ indexacaoEmCurso: boolean, atividadeScript: { tipo: string, causa?: string, pid: number | null, motivo: string } | null }} estado
 * @returns {{ causa: string, mensagem: string } | null}
 */
export function decisaoDaPublicacaoManual({ indexacaoEmCurso, atividadeScript }) {
  if (indexacaoEmCurso) {
    return { causa: "indexação em curso", mensagem: "Aguarda que a indexação do catálogo termine antes de publicar." };
  }
  if (!atividadeScript) return null;
  const causa =
    atividadeScript.tipo === "desconhecida"
      ? CAUSA_CURTA_DE_MARCADOR_DESCONHECIDO[atividadeScript.causa] ?? CAUSA_CURTA_DE_MARCADOR_DESCONHECIDO.ilegivel
      : "reindexação por script em curso";
  return { causa, mensagem: motivoDeRecusaPorScript(atividadeScript) };
}

/**
 * Mensagem de recusa da publicação manual (DBG-141), ou null. Ver decisaoDaPublicacaoManual.
 * @param {{ indexacaoEmCurso: boolean, atividadeScript: { tipo: string, causa?: string, pid: number | null, motivo: string } | null }} estado
 * @returns {string | null}
 */
export function motivoDeRecusaDaPublicacaoManual(estado) {
  return decisaoDaPublicacaoManual(estado)?.mensagem ?? null;
}
