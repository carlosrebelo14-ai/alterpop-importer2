#!/usr/bin/env node
/**
 * Remove sessões OAuth stale do SQLite (Prisma).
 * Usar quando a app embedded não carrega ou o token devolve 401.
 *
 * Uso: npm run shopify:reset-session
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "../../app/db.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = path.join(__dirname, "..", "..", "data", "sessions");

const shop =
  process.env.SPOT_CHECK_SHOP ||
  process.env.SHOP ||
  process.env.SHOPIFY_SHOP_URL ||
  process.env.SHOPIFY_STORE ||
  "alterpop-2.myshopify.com";

async function main() {
  const sessionId = `offline_${shop}`;
  const deleted = await prisma.session.deleteMany({
    where: { shop },
  });

  console.log(`Sessões Prisma removidas para ${shop}: ${deleted.count}`);

  try {
    const files = await fs.readdir(sessionsDir);
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(sessionsDir, file), "utf8");
      if (raw.includes(shop)) {
        await fs.unlink(path.join(sessionsDir, file));
        removed++;
      }
    }
    console.log(`Sessões ficheiro removidas: ${removed}`);
  } catch {
    /* dir pode não existir */
  }
  console.log("");
  console.log("Próximos passos:");
  console.log("  1. npm run dev   (se ainda não estiver a correr)");
  console.log("  2. Abre a app no Admin: Apps → alterpop-importer");
  console.log("  3. Aguarda o OAuth concluir (ecrã do Dashboard)");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
