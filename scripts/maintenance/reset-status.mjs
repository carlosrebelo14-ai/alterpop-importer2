/* eslint-env node */
/**
 * Estado do reset Shopify, para a tarefa reset_status. Só lê, nunca escreve.
 *
 * Lê o ficheiro de estado do reset (readShopifyResetStatus, lib/importer/shopify/shopifyResetJob.server.js) e
 * imprime UMA linha:
 *   RS_STATUS: jobId=… state=… ilegivel=… retomou=… retomadoDe=… total=… processed=… deleted=… failed=…
 *              revertedLocal=… startedAt=… inicioDoPrimeiroArranque=… finishedAt=…
 *
 * O repositório é público. Os campos de texto livre do ficheiro (recentErrors, currentTitle, error) nunca saem.
 * Os ids e as datas só passam se tiverem o formato esperado; senão saem como "-". Os contadores que não são
 * inteiros não nulos saem como "?", para que um ficheiro corrompido se veja, em vez de parecer zero.
 *
 * Corre na Fly por stdin, com o código da versão que a máquina corre. Carrega o módulo por caminho a partir de
 * process.cwd(), como o driver de reset. Falha: RS_ERRO classe=leitura_falhou (código 2), sem mensagem de erro.
 * Sem loja no ambiente: RS_ERRO classe=entrada_invalida (código 64).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

// Os módulos da app usam console.log. Essa saída vai para stderr, para o stdout ter só a linha do contrato.
console.log = (...args) => console.error(...args);
const linha = (texto) => process.stdout.write(`${texto}\n`);

const ESTADOS = new Set(["idle", "running", "listing", "deleting", "completed", "failed"]);
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const DATA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const id = (valor) => (typeof valor === "string" && ID.test(valor) ? valor : "-");
const data = (valor) => (typeof valor === "string" && DATA.test(valor) ? valor : "-");
const contador = (valor) => (Number.isInteger(valor) && valor >= 0 ? String(valor) : "?");

function lerShop() {
  return process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP || "";
}

async function principal() {
  const shop = lerShop();
  if (!shop) {
    linha("RS_ERRO: classe=entrada_invalida");
    return 64;
  }

  let estado;
  try {
    const motor = await import(pathToFileURL(path.join(process.cwd(), "lib/importer/shopify/shopifyResetJob.server.js")).href);
    estado = await motor.readShopifyResetStatus(shop);
  } catch {
    // Sem err.message: pode trazer caminhos ou dados da loja.
    linha("RS_ERRO: classe=leitura_falhou");
    return 2;
  }

  const retomou = estado?.retomadoDe !== null && estado?.retomadoDe !== undefined;
  linha(
    `RS_STATUS: jobId=${id(estado?.jobId)} state=${ESTADOS.has(estado?.state) ? estado.state : "-"} ` +
      `ilegivel=${estado?.ilegivel === true ? "sim" : "nao"} retomou=${retomou ? "sim" : "nao"} ` +
      `retomadoDe=${id(estado?.retomadoDe)} total=${contador(estado?.total)} processed=${contador(estado?.processed)} ` +
      `deleted=${contador(estado?.deleted)} failed=${contador(estado?.failed)} revertedLocal=${contador(estado?.revertedLocal)} ` +
      `startedAt=${data(estado?.startedAt)} inicioDoPrimeiroArranque=${data(estado?.inicioDoPrimeiroArranque)} ` +
      `finishedAt=${data(estado?.finishedAt)}`,
  );
  return 0;
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch(() => {
    linha("RS_ERRO: classe=leitura_falhou");
    process.exit(2);
  });
