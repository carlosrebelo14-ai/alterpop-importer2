/**
 * Reconciliação dos preços PUBLISHED com a regra de pricing.server.js — a lógica
 * partilhada pelo dry-run e pela aplicação (scripts/catalog/price-reconcile-*.js), para
 * os dois nunca decidirem de maneira diferente.
 *
 * Só entra em "muda" um preço que a app escreveu: o preço live tem de bater (ao
 * cêntimo) com a fórmula antiga do publisher, round2(precio_neto × 1,4), com
 * precio_neto = costAtPublish (custo no momento da publicação) ou o netPrice atual.
 * Tudo o resto fica de fora, com o motivo:
 *   manual       preço live não bate com × 1,4 — editado à mão, nunca reescrito
 *   override     preço fixado na curadoria (CSV re-import) — decisão do Carlos
 *   sync_locked  ociostock.sync_locked=true
 *   sem dados    fora do feed/catálogo, sem variante live, ou sem precio_distribuidores
 *
 * Testado em scripts/tests/price-reconcile.test.js.
 */
import { priceRow } from "./pricing.server.js";

/** Fórmula antiga do publisher (antes de 07/10/2026). */
export const OLD_PUBLISHER_MARGIN = 1.4;

export const RECONCILE_CATEGORIES = ["muda", "igual", "manual", "override", "sync_locked", "sem dados"];

const cents = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));

/**
 * @param {{
 *   item: { metadata?: { costAtPublish?: number|null, overrides?: { price?: number } } },
 *   prices: { distributorPrice: number|null, grossPrice: number|null } | null,
 *   netPrice: number|null|undefined,
 *   live: { price: number, syncLocked?: boolean, duplicate?: boolean } | null | undefined,
 *   missingLiveReason?: string|null,
 *   marginPct: number,
 * }} input
 * @returns {{ category: string, reason: string, price: ReturnType<typeof tryPriceProduct>|null }}
 */
export function classifyPriceReconcile({ item, prices, netPrice, live, missingLiveReason, marginPct }) {
  if (!prices) return { category: "sem dados", reason: "SKU fora do feed/catálogo atual", price: null };
  if (!live) {
    return { category: "sem dados", reason: missingLiveReason || "sem variante live na Shopify", price: null };
  }
  if (live.duplicate) return { category: "sem dados", reason: "SKU em mais de uma variante live", price: null };

  // Margem do produto (curadoria) ou a global; inválida → sem dados, nunca outra margem.
  const price = priceRow(prices.distributorPrice, prices.grossPrice, marginPct, item);
  if (price.marginError) return { category: "sem dados", reason: price.marginError, price: null };
  if (live.syncLocked) return { category: "sync_locked", reason: "ociostock.sync_locked=true", price };

  const override = item.metadata?.overrides?.price;
  if (override != null && Number(override) > 0) {
    return { category: "override", reason: `preço fixado na curadoria (${Number(override).toFixed(2)})`, price };
  }
  if (price.priceError) return { category: "sem dados", reason: price.priceError, price };

  const liveC = cents(live.price);
  const costAtPublish = item.metadata?.costAtPublish;
  const candidates = [
    costAtPublish != null ? ["× 1,4 (custo na publicação)", cents(costAtPublish * OLD_PUBLISHER_MARGIN)] : null,
    netPrice != null ? ["× 1,4 (custo atual)", cents(netPrice * OLD_PUBLISHER_MARGIN)] : null,
  ].filter(Boolean);
  const match = candidates.find(([, c]) => c === liveC);
  if (!match) return { category: "manual", reason: "preço live já não bate com × 1,4 — não foi a app", price };

  if (cents(price.finalPrice) === liveC) return { category: "igual", reason: match[0], price };
  return { category: "muda", reason: match[0], price };
}

/**
 * Linha de relatório (CSV/terminal) a partir da classificação.
 * @param {{ sku: string, title: string, live: { price: number }|null|undefined,
 *   result: ReturnType<typeof classifyPriceReconcile> }} input
 */
export function toReconcileRow({ sku, title, live, result }) {
  const { category, reason, price } = result;
  const before = live?.price ?? null;
  const applies = category === "muda" || category === "igual";
  return {
    sku,
    title: title || "",
    cost: price?.cost ?? null,
    pvpr: price?.pvpr ?? null,
    before,
    after: applies ? price.finalPrice : null,
    // Fora de "muda"/"igual": o que a regra daria, só para referência — nunca aplicado.
    ruleWouldBe: price?.finalPrice ?? null,
    profit: price?.profit ?? null,
    priceStatus: price?.priceStatus ?? null,
    delta: category === "muda" && before != null ? (cents(price.finalPrice) - cents(before)) / 100 : null,
    category,
    reason,
  };
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV completo, ordenado por categoria. */
export function reconcileRowsToCsv(rows) {
  const header = ["sku", "titulo", "custo", "pvpr", "antes", "depois", "delta", "lucro", "estado_preco", "regra_daria", "categoria", "motivo"];
  const sorted = [...rows].sort((a, b) => RECONCILE_CATEGORIES.indexOf(a.category) - RECONCILE_CATEGORIES.indexOf(b.category));
  const lines = [header.join(",")];
  for (const r of sorted) {
    lines.push(
      [
        r.sku,
        r.title,
        r.cost?.toFixed(2),
        r.pvpr?.toFixed(2),
        r.before?.toFixed(2),
        r.after?.toFixed(2),
        r.delta?.toFixed(2),
        r.profit?.toFixed(2),
        r.priceStatus,
        r.ruleWouldBe?.toFixed(2),
        r.category,
        r.reason,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

const fmt = (v) => (v == null ? "—" : v.toFixed(2));

/**
 * Resumo para o terminal — o mesmo no dry-run e na aplicação.
 * @param {ReturnType<typeof toReconcileRow>[]} rows
 * @param {string[]} priceStatuses valores de PRICE_STATUS, pela ordem a mostrar
 * @param {(line: string) => void} [out]
 */
export function printReconcileSummary(rows, priceStatuses, out = console.log) {
  out("--- Por categoria ---");
  for (const c of RECONCILE_CATEGORIES) out(`  ${c.padEnd(12)} ${rows.filter((r) => r.category === c).length}`);

  out("\n--- Por estado de preço (todos os que têm preço calculado) ---");
  for (const st of priceStatuses) out(`  ${st.padEnd(12)} ${rows.filter((r) => r.priceStatus === st).length}`);

  const changing = rows.filter((r) => r.category === "muda");
  if (changing.length) {
    const up = changing.filter((r) => r.delta > 0).length;
    const down = changing.filter((r) => r.delta < 0).length;
    const sum = changing.reduce((s, r) => s + r.delta, 0);
    const profit = changing.reduce((s, r) => s + r.profit, 0);
    out(`\n  sobem: ${up} · descem: ${down} · variação total: ${sum.toFixed(2)} € · lucro unitário somado: ${profit.toFixed(2)} €`);

    out("\n--- Muda (ordenado pela maior variação absoluta) ---");
    out(
      "SKU".padEnd(16) +
        "Custo".padStart(8) +
        "PVPR".padStart(8) +
        "Antes".padStart(8) +
        "Depois".padStart(8) +
        "Δ".padStart(8) +
        "Lucro".padStart(8) +
        "  Estado".padEnd(13) +
        "  Título"
    );
    for (const r of [...changing].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
      out(
        r.sku.padEnd(16) +
          fmt(r.cost).padStart(8) +
          fmt(r.pvpr).padStart(8) +
          fmt(r.before).padStart(8) +
          fmt(r.after).padStart(8) +
          fmt(r.delta).padStart(8) +
          fmt(r.profit).padStart(8) +
          `  ${r.priceStatus}`.padEnd(13) +
          "  " + r.title.slice(0, 45)
      );
    }
  }

  const others = rows.filter((r) => r.category !== "muda" && r.category !== "igual");
  if (others.length) {
    out("\n--- Fora da reconciliação ---");
    for (const r of others) out(`  ${r.sku.padEnd(16)} ${r.category.padEnd(12)} ${r.reason}`);
  }
}
