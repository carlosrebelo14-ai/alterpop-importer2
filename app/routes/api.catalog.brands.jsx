import { authenticateAdmin } from "../utils/authenticate.server";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";

/** GET /api/catalog/brands — marcas distintas (paginação leve). */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  const rows = await safePrisma("catalog.brands", () =>
    prisma.catalogProduct.findMany({
      where: { shop: session.shop, vendor: { not: null } },
      distinct: ["vendor"],
      select: { vendor: true },
      orderBy: { vendor: "asc" },
      take: 500,
    }),
    { fallback: [] }
  );

  const brands = rows.map((r) => r.vendor).filter(Boolean);

  return Response.json({ ok: true, brands });
};
