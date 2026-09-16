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
 * Grava a referência, se a corrida der para isso.
 *
 * `houveVermelho` trava: é qualquer vermelha do portão inteiro, não só V5/V7 — a
 * referência tem de apontar ao último estado que o portão inteiro considerou são.
 * Amarelos não travam.
 *
 * `aceitarNovaBase` é o caminho de recuperação (ADENDA 5). Sem ele, uma descida
 * LEGÍTIMA do catálogo — o fornecedor larga linhas e 25 421 passam a 22 000 — prende o
 * portão: a corrida fica vermelha, não grava, o horizonte continua nos 25 421, e a
 * seguinte fica vermelha pelo mesmo motivo, para sempre. Quem encontrasse isso apagava o
 * ficheiro para destravar, e perdia base e histórico de uma vez. Aceitar uma nova linha
 * de base é uma decisão humana, e uma decisão tem de ter um botão — senão faz-se com um
 * `rm`.
 *
 * Reiniciar o histórico é o ponto todo do sinalizador: gravar sem o limpar deixava o
 * máximo antigo no horizonte e o portão continuava vermelho na mesma.
 *
 * @param {string} statePath
 * @param {{ estadoAnterior: object|null, houveVermelho: boolean, catalogTotal: number,
 *           resolvedFormatRatio: number, cleanTitleDiff?: number, shop: string,
 *           horizonteN: number, aceitarNovaBase?: boolean }} args
 *  `cleanTitleDiff` é opcional (briefing 16/09/2026, V6 convertido à forma comparativa)
 *  — quando ausente, o campo/histórico anteriores ficam como estavam (spread de
 *  `estadoAnterior`), para não partir chamadores mais antigos nem os testes existentes.
 * @returns {Promise<{ escreveu: boolean, baseReiniciada: boolean }>}
 */
export async function gravarReferencia(statePath, args) {
  const {
    estadoAnterior,
    houveVermelho,
    catalogTotal,
    resolvedFormatRatio,
    cleanTitleDiff,
    shop,
    horizonteN,
    aceitarNovaBase = false,
  } = args;
  if (houveVermelho && !aceitarNovaBase) return { escreveu: false, baseReiniciada: false };

  const ratio = Number(resolvedFormatRatio.toFixed(2));
  const historicoTotal = aceitarNovaBase
    ? [catalogTotal]
    : [...(estadoAnterior?.catalogTotalHistorico || []), catalogTotal].slice(-horizonteN);
  const historicoRacio = aceitarNovaBase
    ? [ratio]
    : [...(estadoAnterior?.resolvedFormatRatioHistorico || []), ratio].slice(-horizonteN);
  const historicoCleanTitleDiff =
    typeof cleanTitleDiff === "number"
      ? aceitarNovaBase
        ? [cleanTitleDiff]
        : [...(estadoAnterior?.cleanTitleDiffHistorico || []), cleanTitleDiff].slice(-horizonteN)
      : undefined;

  const novo = {
    ...(estadoAnterior || {}),
    catalogTotal,
    resolvedFormatRatio: ratio,
    catalogTotalHistorico: historicoTotal,
    resolvedFormatRatioHistorico: historicoRacio,
    shop,
    ranAt: new Date().toISOString(),
    ...(typeof cleanTitleDiff === "number"
      ? { cleanTitleDiff, cleanTitleDiffHistorico: historicoCleanTitleDiff }
      : {}),
    ...(aceitarNovaBase ? { baseAceiteEm: new Date().toISOString() } : {}),
  };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(novo, null, 2), "utf8");
  return { escreveu: true, baseReiniciada: aceitarNovaBase };
}
