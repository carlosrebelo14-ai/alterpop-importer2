/**
 * Estado entre corridas do portão de saúde (scripts/catalog/pre-pilot-verify.js).
 *
 * Vive fora do script por uma razão concreta: o script só arranca com BD e sessão da
 * loja, e os ramos que mais interessam aqui são os VERMELHOS — precisamente os que
 * ninguém consegue provocar em produção sem partir alguma coisa. Separado, testa-se com
 * estado fabricado num diretório temporário (scripts/tests/health-gate-state.test.js).
 *
 * O que este módulo decide (ADENDA 4):
 *   - Só corridas verdes actualizam a referência. Se uma vermelha gravasse, a seguinte
 *     comparava com o valor já partido e passava verde — o alarme apagava-se sozinho.
 *   - Duas referências, não uma: a corrida anterior e o máximo das últimas N verdes.
 *     Só a primeira deixa passar deriva lenta (quatro quedas de 8% seguidas).
 *
 * Puro fs + aritmética. Sem Prisma, sem Shopify, sem config global — o caminho do
 * ficheiro entra sempre por argumento, para o teste poder apontar para /tmp.
 */
import fs from "fs/promises";
import path from "path";

/** Máximo de um histórico, ou null se não houver nenhum valor utilizável. */
export function maxDe(historico) {
  if (!Array.isArray(historico) || !historico.length) return null;
  const nums = historico.filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

/** Queda percentual de `atual` face a `ref`. null sem referência; negativa = cresceu. */
export function quedaPct(ref, atual) {
  if (ref == null || !ref) return null;
  return ((ref - atual) / ref) * 100;
}

/**
 * Avalia uma métrica contra as DUAS referências e devolve a pior queda.
 * @param {{ anterior: number|null, horizonte: number|null, atual: number, limiar: number,
 *           modo?: "pct"|"pp" }} args
 *   modo "pct" (V5, total do catálogo) — queda relativa em percentagem.
 *   modo "pp"  (V7, rácio) — queda absoluta em pontos percentuais.
 * @returns {{ pior: number, passa: boolean, temReferencia: boolean }}
 */
export function avaliarQueda({ anterior, horizonte, atual, limiar, modo = "pct" }) {
  const temReferencia = anterior != null || horizonte != null;
  if (!temReferencia) return { pior: 0, passa: true, temReferencia: false };

  const calc = (ref) => {
    if (ref == null) return null;
    return modo === "pp" ? ref - atual : quedaPct(ref, atual);
  };
  // Crescimento não é queda: o pior caso nunca desce abaixo de zero.
  const pior = Math.max(calc(anterior) ?? 0, calc(horizonte) ?? 0, 0);
  return { pior, passa: pior < limiar, temReferencia: true };
}

/**
 * Lê o estado. Ficheiro ausente é ausência legítima (primeira corrida) e devolve null.
 * Ficheiro que existe mas não se lê ou não faz parse LANÇA — Decisão 30: falha de
 * leitura nunca vira "sem histórico", que aqui daria verde a uma queda de catálogo por
 * não haver com que a comparar.
 * @param {string} statePath
 */
export async function carregarEstado(statePath) {
  let raw;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${statePath}): ${err?.message || err}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`FALHA DE LEITURA (${statePath}): JSON inválido — ${err?.message || err}`);
  }
}

/**
 * Grava a referência SE a corrida der para a gravar.
 *
 * `houveVermelho` trava: é qualquer vermelha do portão inteiro, não só V5/V7 — a
 * referência tem de apontar ao último estado que o portão inteiro considerou são.
 * Amarelos não travam.
 *
 * @param {string} statePath
 * @param {{ estadoAnterior: object|null, houveVermelho: boolean, catalogTotal: number,
 *           resolvedFormatRatio: number, shop: string, horizonteN: number }} args
 * @returns {Promise<boolean>} true se escreveu.
 */
export async function gravarReferenciaSeVerde(statePath, args) {
  const { estadoAnterior, houveVermelho, catalogTotal, resolvedFormatRatio, shop, horizonteN } = args;
  if (houveVermelho) return false;

  const ratio = Number(resolvedFormatRatio.toFixed(2));
  const novo = {
    ...(estadoAnterior || {}),
    catalogTotal,
    resolvedFormatRatio: ratio,
    catalogTotalHistorico: [...(estadoAnterior?.catalogTotalHistorico || []), catalogTotal].slice(-horizonteN),
    resolvedFormatRatioHistorico: [...(estadoAnterior?.resolvedFormatRatioHistorico || []), ratio].slice(-horizonteN),
    shop,
    ranAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(novo, null, 2), "utf8");
  return true;
}
