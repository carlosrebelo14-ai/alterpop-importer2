import fs from "fs";
import { PrismaClient } from "@prisma/client";

const dbPath = process.env.DATABASE_URL?.replace(/^file:/, "") || "/app/data/dev.sqlite";

async function checkAndRepairDb() {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("PRAGMA quick_check;");
    await prisma.catalogProduct.count();
    console.log("[db-check] Database integrity OK.");
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("malformed") || msg.includes("corrupt")) {
      console.warn("[db-check] SQLite file is malformed! Recreating clean database file...");
      await prisma.$disconnect().catch(() => {});
      const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      for (const t of targets) {
        try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch {}
      }
      console.log("[db-check] Malformed files removed.");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

checkAndRepairDb().catch(console.error);
