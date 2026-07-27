import { GoogleGenerativeAI } from "@google/generative-ai";
import { executeCuratorTool } from "../../lib/importer/catalog/curatorChatTools.server.js";
import { appendCuratorChatLog } from "../../lib/curation/curatorChatLog.server.js";

const SYSTEM_PROMPT = `Tu és o assistente de curadoria da Alterpop (catálogo indexado OcioStock).

REGRA PRINCIPAL — filtros no painel:
Quando o utilizador pedir para ver, mostrar, filtrar, pesquisar ou listar produtos (ex: "Funko Batman", "figuras Marvel com stock"):
1. Chama SEMPRE a ferramenta apply_catalog_filters com brand, licence (franquia/IP), search, productType e preços conforme o pedido.
2. O painel de resultados à esquerda actualiza-se automaticamente — não repitas listas enormes.
3. Responde em Português de Portugal: 1 frase a confirmar filtros + total no painel.
4. Se o total for ≤ 12, acrescenta uma lista curta (SKU + título, uma linha por produto). Para mais de 12, não listes — diz só o total.

Usa search_products só para contagens rápidas; o utilizador vê a lista completa no painel.
Se não houver resultados, sugere filtros alternativos mais amplos.`;

const TOOL_DECLARATIONS = [
  {
    name: "apply_catalog_filters",
    description:
      "Apply filters to the main catalog panel (sidebar faceted search). REQUIRED when the user wants to browse or filter products. Updates the product list UI.",
    parameters: {
      type: "OBJECT",
      properties: {
        brand: { type: "STRING", description: "Manufacturer/vendor, e.g. Funko, Banpresto" },
        licence: {
          type: "STRING",
          description: "Franchise/IP, e.g. Batman, Star Wars, Marvel, Harry Potter",
        },
        search: {
          type: "STRING",
          description: "Free text in title/SKU when no licence match, e.g. Pikachu",
        },
        productType: {
          type: "STRING",
          description: "Product type, e.g. Action Figures, Mugs, Board Games",
        },
        minPrice: { type: "NUMBER", description: "Minimum net cost EUR" },
        maxPrice: { type: "NUMBER", description: "Maximum net cost EUR" },
        inStockOnly: {
          type: "BOOLEAN",
          description: "Only products with supplier stock > 0",
        },
      },
    },
  },
  {
    name: "search_products",
    description:
      "Internal sample search (prefer apply_catalog_filters for user browsing). brand, licence, search, minPrice, maxPrice.",
    parameters: {
      type: "OBJECT",
      properties: {
        brand: { type: "STRING" },
        licence: { type: "STRING" },
        franchise: { type: "STRING" },
        search: { type: "STRING" },
        productType: { type: "STRING" },
        minPrice: { type: "NUMBER" },
        maxPrice: { type: "NUMBER" },
        inStockOnly: { type: "BOOLEAN" },
        limit: { type: "NUMBER" },
        page: { type: "NUMBER" },
      },
    },
  },
  {
    name: "get_catalog_summary",
    description: "Total indexed products in the shop catalog.",
    parameters: { type: "OBJECT", properties: {} },
  },
];

function resolveModelName() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Gemini exige que o histórico comece com role "user" (não "model").
 * @param {{ role: string, text: string }[]} history
 */
function sanitizeChatHistory(history = []) {
  let items = history
    .filter((h) => h?.text && String(h.text).trim())
    .map((h) => ({
      role: h.role === "user" ? "user" : "model",
      text: String(h.text).slice(0, 4000),
    }));

  while (items.length > 0 && items[0].role === "model") {
    items.shift();
  }

  const merged = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === item.role) {
      prev.text = `${prev.text}\n${item.text}`.slice(0, 4000);
      continue;
    }
    merged.push({ ...item });
  }

  return merged.slice(-8);
}

/**
 * @param {{
 *   shop: string,
 *   message: string,
 *   history?: { role: 'user' | 'model', text: string }[],
 * }} params
 */
function extractReplyText(response) {
  try {
    const text = response?.text?.();
    if (text?.trim()) return text.trim();
  } catch {
    /* resposta só com function calls */
  }

  const parts = response?.candidates?.[0]?.content?.parts || [];
  const joined = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n")
    .trim();
  return joined || "I could not generate a reply. Please try rephrasing your question.";
}

/**
 * @param {unknown} err
 */
/**
 * @param {string} reply
 * @param {{ totalCount?: number, filterSummary?: string, previewProducts?: { sku: string, title: string }[] } | null} applied
 */
function enrichCuratorReply(reply, applied) {
  if (!applied) return reply;
  let text = String(reply || "").trim();

  const lines = [];
  if (applied.filterSummary) {
    lines.push(`Painel: ${applied.filterSummary}`);
  }
  lines.push(`${applied.totalCount ?? 0} produto(s) no catálogo.`);

  const products = applied.previewProducts || [];
  const total = applied.totalCount ?? 0;
  if (total > 0 && total <= 12 && products.length > 0) {
    const alreadyLists = products.some((p) => text.includes(p.sku));
    if (!alreadyLists) {
      lines.push("");
      lines.push("Resultados:");
      for (const p of products) {
        lines.push(`• ${p.sku} — ${p.title}`);
      }
    }
  }

  const block = lines.join("\n");
  if (!text) return block;
  if (text.length < 120 && !text.includes("•")) {
    return `${text}\n\n${block}`;
  }
  if (!text.includes(applied.filterSummary || "___")) {
    return `${text}\n\n${block}`;
  }
  return text;
}

function formatGeminiError(err) {
  const status = err?.status || err?.code;
  const msg = err?.message || String(err);
  if (status === 429) {
    return "Gemini quota exceeded (429). Wait a minute and try again.";
  }
  if (status === 404) {
    return `Gemini model not found. Check GEMINI_MODEL (${resolveModelName()}).`;
  }
  if (/GOOGLE_API_KEY|API key/i.test(msg)) {
    return "Invalid or missing GOOGLE_API_KEY on the server.";
  }
  return msg.slice(0, 300);
}

export async function runCuratorChat({ shop, message, history = [] }) {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "GOOGLE_API_KEY missing on server (.env)." };
  }

  const userMessage = String(message || "").trim().slice(0, 2000);
  if (!userMessage) {
    return { ok: false, error: "Empty message." };
  }

  try {
    await appendCuratorChatLog(shop, { role: "user", message: userMessage });

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = resolveModelName();
    const isThinkingModel = /gemini-2\.5/i.test(modelName);

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: isThinkingModel ? 2048 : 1024,
        ...(isThinkingModel ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    });

    const chatHistory = sanitizeChatHistory(history).map((h) => ({
      role: h.role,
      parts: [{ text: h.text }],
    }));

    const chat = model.startChat({
      history: chatHistory,
    });

    const toolsUsed = [];
    let catalogFilters = null;
    /** @type {{ totalCount?: number, filterSummary?: string, previewProducts?: object[] } | null} */
    let lastApplyResult = null;

    let result = await chat.sendMessage(userMessage);
    let rounds = 0;

    while (rounds < 4) {
      const calls =
        typeof result.response.functionCalls === "function"
          ? result.response.functionCalls() || []
          : [];

      if (!calls.length) break;

      const functionResponses = [];
      for (const call of calls) {
        const name = call.name;
        const args = call.args || {};
        toolsUsed.push(name);
        const toolResult = await executeCuratorTool(shop, name, args);
        if (toolResult?.uiFilters) {
          catalogFilters = toolResult.uiFilters;
        }
        if (toolResult?.applied) {
          lastApplyResult = toolResult;
        }
        functionResponses.push({
          functionResponse: {
            name,
            response: toolResult,
          },
        });
      }

      result = await chat.sendMessage(functionResponses);
      rounds += 1;
    }

    const rawReply = extractReplyText(result.response);
    const reply = enrichCuratorReply(rawReply, lastApplyResult);

    await appendCuratorChatLog(shop, {
      role: "assistant",
      message: reply,
      toolsUsed,
    });

    return {
      ok: true,
      reply,
      toolsUsed,
      catalogFilters,
      filterSummary: lastApplyResult?.filterSummary || null,
      catalogPreview:
        (lastApplyResult?.totalCount ?? 0) <= 12
          ? lastApplyResult?.previewProducts || []
          : [],
      totalCount: lastApplyResult?.totalCount ?? null,
    };
  } catch (err) {
    console.error("[curatorChat] Error:", err?.message || err);
    return { ok: false, error: formatGeminiError(err) };
  }
}
