import { authenticateAdmin } from "../utils/authenticate.server";
import { purgeEliteCatalog, lerFilaSemEfeitos } from "../../lib/importer/curation/eliteCuration.server.js";

/**
 * POST /api/curation/elite-purge
 * body: {} → dry-run: o que sairia e o que ficaria retido (DBG-43). Não escreve nada.
 * body: { executar: true } → 409 com a marca [elite-purge]. A purga com escrita fica bloqueada até OK do arquiteto.
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (body?.executar === true) {
    return Response.json(
      {
        ok: false,
        bloqueada: true,
        error: "[elite-purge] Recusada: a purga com escrita está bloqueada até OK do arquiteto (DBG-43).",
      },
      { status: 409 }
    );
  }

  try {
    const resumo = await purgeEliteCatalog(session.shop, { executar: false, dependencias: { lerFila: lerFilaSemEfeitos } });
    return Response.json({ ok: true, ...resumo });
  } catch (err) {
    // Modo degradado (Decisão 34): 503 com a causa, como approve e reject (DBG-115).
    if (err?.code === "DB_DEGRADED") {
      return Response.json({ ok: false, error: err.message, dbDegraded: err.state ?? null }, { status: 503 });
    }
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
