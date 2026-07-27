import fs from "fs/promises";
import path from "path";
import { Session } from "@shopify/shopify-api";

/**
 * Persistência de sessões OAuth em ficheiros JSON (sobrevive a reinícios do Vite).
 * @implements {import('@shopify/shopify-app-session-storage').SessionStorage}
 */
export class FileSessionStorage {
  /**
   * @param {string} directory
   */
  constructor(directory) {
    this.directory = directory;
    this.ready = this.#ensureDir();
  }

  async #ensureDir() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  #filePath(id) {
    const safe = String(id).replace(/[/\\:]/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }

  async storeSession(session) {
    await this.ready;
    const payload = session.toObject ? session.toObject() : session;
    await fs.writeFile(this.#filePath(session.id), JSON.stringify(payload, null, 2), "utf8");
    return true;
  }

  async loadSession(id) {
    await this.ready;
    try {
      const raw = await fs.readFile(this.#filePath(id), "utf8");
      const data = JSON.parse(raw);
      if (data.expires && typeof data.expires === "string") {
        data.expires = new Date(data.expires).getTime();
      }
      if (data.refreshTokenExpires && typeof data.refreshTokenExpires === "string") {
        data.refreshTokenExpires = new Date(data.refreshTokenExpires).getTime();
      }
      return Session.fromPropertyArray(Object.entries(data), true);
    } catch {
      return undefined;
    }
  }

  async deleteSession(id) {
    await this.ready;
    try {
      await fs.unlink(this.#filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async deleteSessions(ids) {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop) {
    await this.ready;
    const entries = await fs.readdir(this.directory).catch(() => []);
    const sessions = [];
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.directory, file), "utf8");
        const data = JSON.parse(raw);
        if (data.shop === shop) {
          sessions.push(Session.fromPropertyArray(Object.entries(data), true));
        }
      } catch {
        /* skip corrupt */
      }
    }
    return sessions;
  }
}
