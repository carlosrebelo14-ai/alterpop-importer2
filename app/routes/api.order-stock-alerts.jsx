import { authenticateAdmin } from "../utils/authenticate.server";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";

/** GET /api/order-stock-alerts?resolved=0 — heurística de encomendas a rever (item 18). */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const resolvedParam = url.searchParams.get("resolved");
  const resolved = resolvedParam === "1" ? true : resolvedParam === "0" ? false : undefined;

  const alerts = await safePrisma("orderStockAlert.list", () =>
    prisma.orderStockAlert.findMany({
      where: { shop: session.shop, ...(resolved !== undefined ? { resolved } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    { fallback: [] }
  );

  return Response.json({ ok: true, alerts });
};

/** POST /api/order-stock-alerts — intent=resolve, id */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "resolve") {
    const id = String(form.get("id") || "");
    await safePrisma("orderStockAlert.resolve", () =>
      prisma.orderStockAlert.updateMany({
        where: { id, shop: session.shop },
        data: { resolved: true },
      })
    );
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "intent desconhecido" }, { status: 400 });
};
