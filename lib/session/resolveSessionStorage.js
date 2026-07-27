import path from "path";
import { fileURLToPath } from "url";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "../../app/db.server.js";
import { FileSessionStorage } from "./fileSessionStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

/**
 * Dev: ficheiros em data/sessions (persiste entre reloads Vite).
 * Produção / SESSION_STORAGE=prisma: SQLite via Prisma.
 */
export function resolveSessionStorage() {
  const mode = (process.env.SESSION_STORAGE || "file").toLowerCase();

  if (mode === "prisma") {
    console.log("[session] PrismaSessionStorage (SQLite prisma/dev.sqlite)");
    return new PrismaSessionStorage(prisma);
  }

  const dir = process.env.SESSION_FILES_DIR || path.join(projectRoot, "data", "sessions");
  console.log(`[session] FileSessionStorage (${dir})`);
  return new FileSessionStorage(dir);
}
