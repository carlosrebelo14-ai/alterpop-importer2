import { authenticateAdmin } from "../utils/authenticate.server";
import { computeDecisionGroups } from "../../lib/curation/decisionQueue.server.js";
import { DECISION_GROUP_LABELS } from "../../lib/curation/decisionQueue.js";

/**
 * GET /api/curation/decision-queue → { ok, groups: [{ id, label, count }], liveError, computedAt }
 * Fila de decisão (Decisão 31): Prontos a aprovar · Preço manual · Regra desatualizada · Erros
 * de sincronização. Só contagens; a lista de cada grupo vem de /api/products?group=<id>.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  try {
    const { counts, liveError, computedAt } = await computeDecisionGroups(session.shop);
    return Response.json({
      ok: true,
      groups: Object.entries(DECISION_GROUP_LABELS).map(([id, label]) => ({ id, label, count: counts[id] ?? 0 })),
      liveError,
      computedAt,
    });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
