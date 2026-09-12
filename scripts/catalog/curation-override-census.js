#!/usr/bin/env node
/**
 * Tarefa 55 — censo de overrides manuais de título na fila de curadoria
 * (`curation-queue.json → item.metadata.overrides.title`, `setManualOverride`, item
 * 9). Bloqueante para a importação final: overrides de QA antigos publicam texto de
 * teste em produtos reais — achado no SKU 0030506556343 ("TITULO NAO DEVE MUDAR
 * (ProductImporter locked)", 2026-08-12).
 *
 * SÓ RELATÓRIO — read-only. `autor` não existe no modelo de dados: `setManualOverride`
 * nunca gravou quem fez a alteração, só `overridesUpdatedAt`. Fica ∅ de propósito, não
 * é um bug deste censo — é um gap de auditoria pré-existente, sinalizado no output.
 *
 * "parece teste" — heurística sobre o texto do override (maiúsculas em excesso,
 * tokens como TESTE/TEST/QA/DEBUG/XYZ/LOREM/TODO/PROVA/LOCKED, ou o próprio texto
 * comercialmente sem sentido). Falso positivo/negativo possível — é triagem, não
 * veredicto automático.
 *
 * Correr na Fly:  node scripts/catalog/curation-override-census.js
 */
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";

const TEST_TOKEN_RE = /\b(teste?|test|qa|debug|xyz|lorem\s*ipsum|todo|prova|locked|n[aã]o\s*deve\s*mudar|dummy|placeholder|foo|bar|xxx+)\b/i;

function looksLikeTest(title) {
  if (!title) return false;
  if (TEST_TOKEN_RE.test(title)) return true;
  // Maiúsculas em excesso num texto que não é sigla — sinal fraco, mas comum em
  // overrides de QA escritos à mão em CAPS LOCK.
  const letters = title.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length > 8 && letters === letters.toUpperCase()) return true;
  return false;
}

async function main() {
  console.log(`\n=== curation-override-census — Tarefa 55 ===\n`);

  const items = await listCurationQueueItems();
  const withTitleOverride = items.filter((i) => i.metadata?.overrides?.title);

  console.log(`itens na fila: ${items.length}`);
  console.log(`com override de título: ${withTitleOverride.length}\n`);

  if (!withTitleOverride.length) {
    console.log(`✓ nenhum override de título ativo — nada a rever.`);
    return;
  }

  console.log(`  ${"sku".padEnd(18)}  ${"override".padEnd(48)}  ${"autor".padEnd(10)}  ${"data".padEnd(24)}  parece teste?`);
  let suspectCount = 0;
  for (const i of withTitleOverride) {
    const title = String(i.metadata.overrides.title);
    const suspect = looksLikeTest(title);
    if (suspect) suspectCount += 1;
    const data = i.metadata.overridesUpdatedAt || "∅";
    console.log(
      `  ${i.sku.padEnd(18)}  ${title.slice(0, 48).padEnd(48)}  ${"∅ (n/reg)".padEnd(10)}  ${data.padEnd(24)}  ${suspect ? "SIM" : "não"}`
    );
  }

  console.log(`\n${suspectCount}/${withTitleOverride.length} parecem overrides de teste, por heurística.`);
  console.log(`\n⚠ "autor" não é capturado por setManualOverride — gap de auditoria pré-existente, não deste censo.`);
  console.log(`(nada escrito — só relatório. Decisão sobre limpar cada override fica para revisão manual.)`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
