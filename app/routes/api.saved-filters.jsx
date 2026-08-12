import { authenticateAdmin } from "../utils/authenticate.server";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";

/** GET /api/saved-filters — lista os conjuntos de filtros guardados desta loja. */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  const rows = await safePrisma(
    "savedFilterSet.list",
    () =>
      prisma.savedFilterSet.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
      }),
    { fallback: [] }
  );

  const filters = rows.map((r) => {
    let filters = {};
    try {
      filters = JSON.parse(r.filtersJson || "{}");
    } catch {
      filters = {};
    }
    return { id: r.id, name: r.name, filters, createdAt: r.createdAt };
  });

  return Response.json({ ok: true, filters });
};

/**
 * POST /api/saved-filters
 * intent=create: name, filtersJson (JSON string dos filtros activos)
 * intent=delete: id
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const name = String(form.get("name") || "").trim();
    const filtersRaw = String(form.get("filters") || "{}");
    if (!name) {
      return Response.json({ ok: false, error: "Nome em falta" }, { status: 400 });
    }
    let parsed;
    try {
      parsed = JSON.parse(filtersRaw);
    } catch {
      return Response.json({ ok: false, error: "Filtros inválidos" }, { status: 400 });
    }

    const created = await safePrisma("savedFilterSet.create", () =>
      prisma.savedFilterSet.create({
        data: {
          shop: session.shop,
          name,
          filtersJson: JSON.stringify(parsed),
        },
      })
    );

    return Response.json({
      ok: true,
      filter: { id: created.id, name: created.name, filters: parsed, createdAt: created.createdAt },
    });
  }

  if (intent === "delete") {
    const id = String(form.get("id") || "");
    if (!id) {
      return Response.json({ ok: false, error: "id em falta" }, { status: 400 });
    }
    await safePrisma("savedFilterSet.delete", () =>
      prisma.savedFilterSet.deleteMany({ where: { id, shop: session.shop } })
    );
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "intent desconhecido" }, { status: 400 });
};
