import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-1.5-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
]
  .filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i);

const TITLE_CACHE_MAX = 10_000;
const titleCache = new Map();

let requestChain = Promise.resolve();
let lastRequestAt = 0;

function rpmIntervalMs() {
  const rpm = Math.max(1, Number(process.env.GEMINI_RPM) || 4);
  return Math.ceil(60_000 / rpm);
}

function cacheGet(title) {
  const key = title.toLowerCase();
  const hit = titleCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > 3_600_000) {
    titleCache.delete(key);
    return null;
  }
  return hit.verdict;
}

function cacheSet(title, verdict) {
  const key = title.toLowerCase();
  if (titleCache.size >= TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next().value;
    titleCache.delete(oldest);
  }
  titleCache.set(key, { verdict, at: Date.now() });
}

async function throttle() {
  const wait = lastRequestAt + rpmIntervalMs() - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

function parseRetryDelayMs(err) {
  const details = err?.errorDetails || [];
  for (const d of details) {
    if (d?.["@type"]?.includes?.("RetryInfo") && d.retryDelay) {
      const sec = parseFloat(String(d.retryDelay).replace(/s$/i, ""));
      if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000) + 500;
    }
  }
  const match = String(err?.message || "").match(/retry in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  return 35_000;
}

function parseVerdict(rawText) {
  const text = String(rawText || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if (
    text === "APPROVE" ||
    text.startsWith("APPROVE") ||
    text.startsWith("APPROV")
  ) {
    return "APPROVE";
  }
  if (text === "REJECT" || text.startsWith("REJECT")) return "REJECT";
  return null;
}

async function callGemini(apiKey, modelName, prompt) {
  const isThinkingModel = /gemini-2\.5/i.test(modelName);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: isThinkingModel ? 32 : 16,
      ...(isThinkingModel ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });

  const result = await model.generateContent(prompt);
  return result?.response?.text?.() || "";
}

async function curateTitleOnce(safeTitle) {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  const prompt = `Tu és um curador de uma loja de elite de cultura pop (Alterpop).

O teu objectivo é ignorar material escolar (canetas, lápis, cadernos), vestuário de baixo custo, malas ou acessórios genéricos.

Classifica como APPROVE apenas produtos de colecionismo, figuras, estátuas, jogos de tabuleiro de marca ou merchandising de luxo (canecas premium, réplicas).

Responde APENAS com uma palavra: APPROVE ou REJECT.

- APPROVE: colecionável premium, figura/estátua licenciada, board game de marca, merch de luxo
- REJECT: papelaria, material escolar, têxtil barato, malas, acessórios genéricos, spam, adult-only, placeholders

Título do produto: "${safeTitle}"

Resposta:`;

  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    let retried429 = false;
    for (;;) {
      try {
        const rawText = await callGemini(apiKey, modelName, prompt);
        const verdict = parseVerdict(rawText);
        if (verdict) return verdict;
        console.warn(`[curator] Resposta ambígua (${modelName}):`, rawText);
        return "PENDING";
      } catch (err) {
        lastError = err;
        const status = err?.status;
        if (status === 429 && !retried429) {
          retried429 = true;
          const delay = parseRetryDelayMs(err);
          console.warn(`[curator] Quota 429 — retry em ${Math.round(delay / 1000)}s (${modelName})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (status === 404 || status === 429) break;
        return "PENDING";
      }
    }
  }

  const code = lastError?.status || lastError?.code || "";
  const message = lastError?.message || String(lastError);
  console.warn(`[curator] Gemini falhou (${code}): ${message}`);
  return "PENDING";
}

let sessionCallCount = 0;

async function curateWithRateLimit(safeTitle) {
  const maxCalls = Number(process.env.GEMINI_MAX_CALLS) || 0;
  if (maxCalls > 0 && sessionCallCount >= maxCalls) {
    return "PENDING";
  }

  await throttle();
  sessionCallCount += 1;
  return curateTitleOnce(safeTitle);
}

/**
 * Curadoria automática via Gemini — fila + RPM + cache por título.
 * Falha segura: nunca bloqueia o pipeline (devolve PENDING).
 *
 * @param {string} title Título do produto (preferencialmente EN após glossário).
 * @returns {Promise<'APPROVE' | 'REJECT' | 'PENDING'>}
 */
export async function curateWithAI(title) {
  const safeTitle = String(title || "").trim().slice(0, 500);
  if (!safeTitle) return "PENDING";

  if (!process.env.GOOGLE_API_KEY?.trim()) return "PENDING";
  if (process.env.GEMINI_CURATION_ENABLED === "0") return "PENDING";

  const cached = cacheGet(safeTitle);
  if (cached) return cached;

  const task = requestChain.then(() => curateWithRateLimit(safeTitle));
  requestChain = task.catch(() => {});
  const verdict = await task;
  if (verdict !== "PENDING") cacheSet(safeTitle, verdict);
  return verdict;
}
