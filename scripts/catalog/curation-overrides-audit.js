#!/usr/bin/env node
/**
 * Tarefa 57 — inventário estrutural de `metadata.overrides` na fila de curadoria.
 *
 * A Tarefa 55 procurou especificamente `metadata.overrides.title` (a chave do bug
 * conhecido) e reportou "1/1 override" — mas o objeto `overrides` desse mesmo item
 * tinha MAIS DUAS chaves (`price`, `category`) que o censo anterior nunca olhou.
 * Auditar a estrutura, não a chave suspeita: percorre TODOS os items com
 * `metadata.overrides` não vazio e lista CADA chave separadamente — um item com 3
 * overrides aparece em 3 linhas, não em 1.
 *
 * SÓ RELATÓRIO — read-only. `autor` fica ∅ (mesmo gap de auditoria da Tarefa 55 —
 * `setManualOverride` nunca capturou quem gravou o override).
 *
 * Correr na Fly:  node scripts/catalog/curation-overrides-audit.js
 */
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";

async function main() {
  console.log(`\n=== curation-overrides-audit — Tarefa 57 ===\n`);

  const items = await listCurationQueueItems();
  const withOverrides = items.filter(
    (i) => i.metadata?.overrides && Object.keys(i.metadata.overrides).length > 0
  );

  console.log(`itens na fila: ${items.length}`);
  console.log(`itens com metadata.overrides não vazio: ${withOverrides.length}\n`);

  /** @type {{ sku: string, field: string, value: unknown, data: string }[]} */
  const rows = [];
  for (const item of withOverrides) {
    const data = item.metadata.overridesUpdatedAt || "∅";
    for (const [field, value] of Object.entries(item.metadata.overrides)) {
      rows.push({ sku: item.sku, field, value, data });
    }
  }

  const countByField = new Map();
  for (const r of rows) countByField.set(r.field, (countByField.get(r.field) || 0) + 1);
  const fieldOrder = [...countByField.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  rows.sort((a, b) => fieldOrder.indexOf(a.field) - fieldOrder.indexOf(b.field) || a.sku.localeCompare(b.sku));

  console.log(`── inventário de chaves (contagem desc) ──`);
  for (const field of fieldOrder) console.log(`  ${String(countByField.get(field)).padStart(4)}  ${field}`);

  console.log(`\n── linhas (sku | campo | valor | autor | data) ──`);
  console.log(`  ${"sku".padEnd(18)}  ${"campo".padEnd(12)}  ${"valor".padEnd(48)}  ${"autor".padEnd(10)}  data`);
  for (const r of rows) {
    console.log(
      `  ${r.sku.padEnd(18)}  ${r.field.padEnd(12)}  ${String(r.value).slice(0, 48).padEnd(48)}  ${"∅ (n/reg)".padEnd(10)}  ${r.data}`
    );
  }

  console.log(`\ntotal de linhas: ${rows.length} (itens distintos: ${withOverrides.length})`);
  console.log(`\n⚠ "autor" não é capturado por setManualOverride — gap de auditoria pré-existente.`);
  console.log(`(nada escrito — só relatório.)`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
