#!/usr/bin/env node
/**
 * Valida short-circuit de marcas/franquias premium no importador.
 */
import { evaluateStructuredCatalogFilter } from "../lib/importer/curation/structuredCatalogFilter.server.js";

const cases = [
  {
    name: "BANPRESTO maiúsculas + papelaria + 2€",
    record: {
      sku: "T1",
      vendor: "  BANPRESTO  ",
      title: "Figura test",
      categoryMain: "papeleria escolar",
      netPrice: 2,
      franchises: [],
      availableQuantity: 0,
    },
    expectPass: true,
  },
  {
    name: "Funko no título, vendor genérico",
    record: {
      sku: "T2",
      vendor: "distribuidor sa",
      title: "FUNKO POP Marvel",
      categoryMain: "papeleria",
      netPrice: 1.5,
      franchises: [],
    },
    expectPass: true,
  },
  {
    name: "Star Wars na franquia",
    record: {
      sku: "T3",
      vendor: "unknown",
      title: "Poster",
      categoryMain: "decoracion",
      netPrice: 3,
      franchises: ["STAR_WARS_EP"],
    },
    expectPass: true,
  },
  {
    name: "Genérico barato papelaria (rejeitar)",
    record: {
      sku: "T4",
      vendor: "marca x",
      title: "Caderno",
      categoryMain: "papeleria escolar",
      categorySegments: ["papeleria escolar"],
      netPrice: 2,
      franchises: [],
    },
    expectPass: false,
  },
];

let failed = 0;
for (const c of cases) {
  const r = evaluateStructuredCatalogFilter(c.record);
  const pass = !r.excluded;
  const ok = pass === c.expectPass;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${c.name} → ${pass ? "PASS" : "REJECT"} (${r.reason})`);
}

if (failed > 0) {
  console.error(`\n${failed} caso(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os casos de short-circuit premium passaram.");
