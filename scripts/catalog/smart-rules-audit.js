#!/usr/bin/env node
/**
 * SÓ LEITURA. As regras automáticas ativas em produção e o que já fizeram à fila.
 *
 * Decisão do Carlos (setembro/2026): a aprovação é sempre manual. As regras inteligentes
 * (painel «Criar regra deste filtro» → server/data/rules.json) ainda podem AUTO_APPROVE no
 * reindex. Este script diz, sem escrever nada:
 *   - onde está o ficheiro de regras, desde quando, e quantas regras tem (por ação);
 *   - cada regra: id, ação, marca, categoria, intervalo de preço;
 *   - quantos itens da fila foram decididos por regra (smartRule / eliteCuration / aiCuration),
 *     por estado atual.
 * Sai com código 2 se existir alguma regra AUTO_APPROVE.
 * Nota: server/data/rules.json vive no sistema de ficheiros do contentor, não no volume
 * /app/data — um deploy ou reinício volta a pô-lo como está no repositório.
 *
 *   node scripts/catalog/smart-rules-audit.js
 */
import fs from "node:fs";
import path from "node:path";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { loadSmartRules } from "../../lib/importer/curation/smartRules.server.js";
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";

const file = path.join(getDefaultConfig().paths.serverData, "rules.json");
const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

async function main() {
  console.log("=== smart-rules-audit · SÓ LEITURA ===\n");
  const st = fs.statSync(file);
  console.log(`Ficheiro de regras: ${file}`);
  console.log(`Modificado em:      ${st.mtime.toISOString()}`);

  const { rules } = loadSmartRules();
  const list = rules || [];
  const byAction = new Map();
  for (const r of list) count(byAction, r.action || "(sem ação)");
  console.log(`\nRegras: ${list.length}${list.length ? ` — ${[...byAction].map(([a, n]) => `${a}: ${n}`).join(", ")}` : ""}`);
  for (const r of list) {
    console.log(`  ${String(r.id || "(sem id)").padEnd(28)} ${String(r.action).padEnd(13)} marca=${r.brand ?? "—"} categoria=${r.category ?? "—"} preço=${r.minPrice ?? "—"}..${r.maxPrice ?? "—"} (${r.priceField || "netPrice"})`);
  }

  const queue = await loadCurationQueue();
  const decided = new Map();
  let total = 0;
  for (const item of queue.items) {
    total += 1;
    const m = item.metadata || {};
    if (m.smartRule) count(decided, `smartRule ${m.smartAction || "?"} → ${item.status}`);
    if (m.eliteCuration) count(decided, `eliteCuration ${m.eliteAction || "?"} → ${item.status}`);
    if (m.aiCuration) count(decided, `aiCuration ${m.aiAction || "?"} → ${item.status}`);
  }
  console.log(`\nFila: ${total} itens. Decididos por regra automática, por estado atual:`);
  if (!decided.size) console.log("  (nenhum)");
  for (const [k, n] of [...decided].sort()) console.log(`  ${String(n).padStart(6)}  ${k}`);

  const approvers = list.filter((r) => r.action === "AUTO_APPROVE");
  if (approvers.length) {
    console.error(`\n⚠ ${approvers.length} regra(s) AUTO_APPROVE ativa(s): ${approvers.map((r) => r.id || "(sem id)").join(", ")} — contraria a decisão de aprovação manual.`);
    process.exitCode = 2;
  } else {
    console.log("\nNenhuma regra AUTO_APPROVE ativa.");
  }
}

main().catch((err) => {
  console.error("Erro:", err?.message || err);
  process.exitCode = 1;
});
