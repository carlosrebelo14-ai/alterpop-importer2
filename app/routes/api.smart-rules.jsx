import { authenticateAdmin } from "../utils/authenticate.server";
import { loadSmartRules, saveSmartRules } from "../../lib/importer/curation/smartRules.server.js";

/** GET /api/smart-rules — lista as regras activas (server/data/rules.json). */
export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  const { rules } = loadSmartRules();
  return Response.json({ ok: true, rules: rules || [] });
};

/**
 * POST /api/smart-rules
 * intent=create: brand?, category?, minPrice?, maxPrice?, action (AUTO_APPROVE|AUTO_REJECT), name?
 * intent=delete: id
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  await authenticateAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const { rules } = loadSmartRules();

  if (intent === "create") {
    const ruleAction = String(form.get("action") || "");
    if (ruleAction !== "AUTO_APPROVE" && ruleAction !== "AUTO_REJECT") {
      return Response.json({ ok: false, error: "action tem de ser AUTO_APPROVE ou AUTO_REJECT" }, { status: 400 });
    }

    const brand = String(form.get("brand") || "").trim();
    const category = String(form.get("category") || "").trim();
    const minPriceRaw = String(form.get("minPrice") || "").trim();
    const maxPriceRaw = String(form.get("maxPrice") || "").trim();
    const name = String(form.get("name") || "").trim();

    if (!brand && !category && !minPriceRaw && !maxPriceRaw) {
      return Response.json({ ok: false, error: "A regra precisa de pelo menos uma condição (marca, categoria ou preço)" }, { status: 400 });
    }

    const rule = { id: `rule_${Date.now()}`, action: ruleAction };
    if (name) rule.name = name;
    if (brand) rule.brand = brand;
    if (category) rule.category = category;
    if (minPriceRaw) {
      const n = parseFloat(minPriceRaw.replace(",", "."));
      if (Number.isFinite(n)) rule.minPrice = n;
    }
    if (maxPriceRaw) {
      const n = parseFloat(maxPriceRaw.replace(",", "."));
      if (Number.isFinite(n)) rule.maxPrice = n;
    }

    const next = saveSmartRules([...(rules || []), rule]);
    return Response.json({ ok: true, rule, rules: next.rules });
  }

  if (intent === "delete") {
    const id = String(form.get("id") || "");
    const next = saveSmartRules((rules || []).filter((r) => r.id !== id));
    return Response.json({ ok: true, rules: next.rules });
  }

  return Response.json({ ok: false, error: "intent desconhecido" }, { status: 400 });
};
