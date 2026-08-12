import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDefaultConfig } from "../config.js";
import { logExecution } from "../logging/executionHistory.js";
import { normalizeForMatch } from "./loadCuration.js";
import { evaluateEliteCuration } from "./eliteCuration.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rulesPath() {
  return path.join(getDefaultConfig().paths.serverData, "rules.json");
}

/** @type {{ version: number, rules: SmartRule[] } | null} */
let cachedRules = null;

/**
 * @typedef {{ id?: string, brand?: string, category?: string, minPrice?: number, maxPrice?: number, action: 'AUTO_APPROVE' | 'AUTO_REJECT' }} SmartRule
 */

export function loadSmartRules() {
  if (cachedRules) return cachedRules;
  const raw = fs.readFileSync(rulesPath(), "utf8");
  cachedRules = JSON.parse(raw);
  return cachedRules;
}

export function invalidateSmartRulesCache() {
  cachedRules = null;
}

/**
 * @param {SmartRule[]} rules
 */
export function saveSmartRules(rules) {
  const current = loadSmartRules();
  const next = { version: current?.version ?? 1, rules };
  fs.writeFileSync(rulesPath(), JSON.stringify(next, null, 2));
  invalidateSmartRulesCache();
  return next;
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {SmartRule} rule
 */
function matchesRule(record, rule) {
  if (rule.brand) {
    const vendor = normalizeForMatch(record.vendor);
    const want = normalizeForMatch(rule.brand);
    if (!vendor || vendor !== want) return false;
  }

  if (rule.category) {
    const want = normalizeForMatch(rule.category);
    const candidates = [
      record.categoryMain,
      record.category,
      ...(record.categorySegments || []),
    ]
      .filter(Boolean)
      .map((c) => normalizeForMatch(c));

    const hit = candidates.some(
      (c) => c === want || c.includes(want) || want.includes(c)
    );
    if (!hit) return false;
  }

  const net = record.netPrice;
  if (rule.maxPrice != null) {
    if (net == null || net > rule.maxPrice) return false;
  }
  if (rule.minPrice != null) {
    if (net == null || net < rule.minPrice) return false;
  }

  return true;
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {{ jobId?: string }} [ctx]
 * @returns {{ action: 'AUTO_APPROVE' | 'AUTO_REJECT' | null, rule: SmartRule | null, reasons: string[] }}
 */
export function evaluateSmartRules(record, ctx = {}) {
  try {
    const elite = evaluateEliteCuration(record);
    if (elite.action) {
      return { action: null, rule: null, reasons: elite.reasons };
    }

    const { rules } = loadSmartRules();
    for (const rule of rules || []) {
      if (!rule?.action) continue;
      if (matchesRule(record, rule)) {
        return {
          action: rule.action,
          rule,
          reasons: [
            `smart_rule:${rule.id || rule.action}`,
            rule.brand ? `brand:${rule.brand}` : null,
            rule.category ? `category:${rule.category}` : null,
            rule.maxPrice != null ? `maxPrice:${rule.maxPrice}` : null,
          ].filter(Boolean),
        };
      }
    }
    return { action: null, rule: null, reasons: [] };
  } catch (err) {
    const message = err?.message || String(err);
    logExecution({
      sku: record?.sku || "(rule-engine)",
      action: "rejeitado",
      reason: `Rule Engine Error: ${message}`,
      jobId: ctx.jobId,
    }).catch(() => {});

    return { action: null, rule: null, reasons: [`rule_engine_error:${message}`] };
  }
}

/**
 * @param {import('../../curation/curationQueue.server.js').CurationQueueItem[]} items
 */
export function countSmartRuleDecisions(items) {
  let autoApproved = 0;
  let autoRejected = 0;
  for (const item of items) {
    if (!item.metadata?.smartRule) continue;
    if (item.status === "APPROVED") autoApproved += 1;
    if (item.status === "REJECTED") autoRejected += 1;
  }
  return { autoApproved, autoRejected, total: autoApproved + autoRejected };
}
