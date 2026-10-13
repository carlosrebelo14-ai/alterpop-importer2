/* eslint-env node */
/**
 * Compara a versão ativa da app (config/shopify-app-version-12.json) com o que o
 * `shopify app deploy` vai enviar (shopify.app.toml + extensions/<x>/shopify.extension.toml).
 * Só lê ficheiros locais. Sai com erro se faltar QUALQUER item da versão ativa (scope, webhook,
 * extensão, redirect URL, api_version dos webhooks), ou se houver um acrescento que não esteja
 * em expectedAdditions. Um deploy a partir de um toml incompleto retiraria webhooks, scopes ou
 * extensões da versão nova, e a Shopify trata isso como remoção.
 *
 * Uso: node scripts/maintenance/check-app-config.mjs [--root <dir>] [--baseline <ficheiro>]
 */
import fs from "node:fs";
import path from "node:path";

/** TOML mínimo (só o que os ficheiros da app usam): tabelas, arrays de tabelas, strings, bool, números, arrays. */
export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  const walk = (keys, make) => {
    let o = root;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      if (last && make === "array") {
        o[k] = o[k] || [];
        const t = {};
        o[k].push(t);
        o = t;
      } else {
        o[k] = o[k] ?? {};
        o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k];
      }
    });
    return o;
  };
  const stripComment = (s) => {
    let q = false;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '"' && s[i - 1] !== "\\") q = !q;
      if (s[i] === "#" && !q) return s.slice(0, i);
    }
    return s;
  };
  const value = (raw) => {
    const v = raw.trim();
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('"')) return JSON.parse(v);
    if (v.startsWith("[")) {
      const inner = v.slice(1, v.lastIndexOf("]")).trim();
      if (!inner) return [];
      const parts = [];
      let q = false;
      let buf = "";
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner[i];
        if (c === '"' && inner[i - 1] !== "\\") q = !q;
        if (c === "," && !q) {
          parts.push(buf);
          buf = "";
        } else buf += c;
      }
      if (buf.trim()) parts.push(buf);
      return parts.map(value);
    }
    throw new Error(`TOML não suportado: ${raw}`);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    let m = line.match(/^\[\[([^\]]+)\]\]$/);
    if (m) {
      cur = walk(m[1].split(".").map((s) => s.trim()), "array");
      continue;
    }
    m = line.match(/^\[([^\]]+)\]$/);
    if (m) {
      cur = walk(m[1].split(".").map((s) => s.trim()), "table");
      continue;
    }
    m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m) throw new Error(`TOML ilegível, linha ${i + 1}: ${lines[i]}`);
    let rhs = m[2];
    while (rhs.trim().startsWith("[") && !/\]\s*$/.test(stripComment(rhs).trim())) {
      i += 1;
      rhs += `\n${stripComment(lines[i])}`;
    }
    cur[m[1]] = value(stripComment(rhs).replace(/\n/g, " "));
  }
  return root;
}

/** O que o deploy envia, lido dos ficheiros. */
export function readLocalConfig(rootDir) {
  const app = parseToml(fs.readFileSync(path.join(rootDir, "shopify.app.toml"), "utf8"));
  const extDir = path.join(rootDir, "extensions");
  const extensions = [];
  if (fs.existsSync(extDir)) {
    for (const d of fs.readdirSync(extDir)) {
      const f = path.join(extDir, d, "shopify.extension.toml");
      if (!fs.existsSync(f)) continue;
      const t = parseToml(fs.readFileSync(f, "utf8"));
      for (const e of t.extensions || []) extensions.push(e.handle);
    }
  }
  const subs = app.webhooks?.subscriptions || [];
  return {
    client_id: app.client_id,
    scopes: String(app.access_scopes?.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
    webhooks: { api_version: app.webhooks?.api_version, topics: subs.flatMap((s) => s.topics || []), uris: subs.map((s) => s.uri) },
    extensions,
    redirect_urls: app.auth?.redirect_urls || [],
    application_url: app.application_url,
  };
}

export function compareConfig(baseline, local) {
  const rows = [];
  const problems = [];
  const sets = [
    ["scopes", baseline.scopes, local.scopes, baseline.expectedAdditions?.scopes || []],
    ["webhooks (tópicos)", baseline.webhooks.topics, local.webhooks.topics, []],
    ["extensões", baseline.extensions, local.extensions, []],
    ["redirect URLs", baseline.redirect_urls, local.redirect_urls, []],
  ];
  for (const [name, base, now, allowed] of sets) {
    const missing = base.filter((x) => !now.includes(x));
    const added = now.filter((x) => !base.includes(x));
    const unexpected = added.filter((x) => !allowed.includes(x));
    const pendingAdd = allowed.filter((x) => !now.includes(x));
    rows.push({ name, missing, added, unexpected, kept: base.length - missing.length });
    for (const x of missing) problems.push(`${name}: falta "${x}" (existe na versão 12)`);
    for (const x of unexpected) problems.push(`${name}: acrescento inesperado "${x}"`);
    for (const x of pendingAdd) problems.push(`${name}: falta o acrescento esperado "${x}"`);
  }
  if (local.webhooks.api_version !== baseline.webhooks.api_version) {
    problems.push(`webhooks.api_version é ${local.webhooks.api_version}, a versão 12 tem ${baseline.webhooks.api_version}`);
  }
  if (new Set(local.webhooks.topics).size !== local.webhooks.topics.length) problems.push("webhooks: tópico repetido");
  return { rows, problems };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const root = path.resolve(opt("--root", process.cwd()));
  const baseline = JSON.parse(fs.readFileSync(path.resolve(opt("--baseline", path.join(root, "config/shopify-app-version-12.json"))), "utf8"));
  const local = readLocalConfig(root);
  const { rows, problems } = compareConfig(baseline, local);
  console.log(`Versão ativa ${baseline.version}  →  o que o deploy envia (${local.client_id})\n`);
  for (const r of rows) {
    console.log(`${r.name}`);
    console.log(`  mantém:     ${r.kept} item(ns)`);
    console.log(`  acrescenta: ${r.added.length ? r.added.map((x) => `+ ${x}`).join(", ") : "(nada)"}`);
    console.log(`  remove:     ${r.missing.length ? r.missing.map((x) => `- ${x}`).join(", ") : "(nada)"}`);
  }
  console.log(`\nwebhooks api_version: ${local.webhooks.api_version} (versão 12: ${baseline.webhooks.api_version})`);
  console.log(`webhooks URIs: ${local.webhooks.uris.join(", ")}`);
  if (problems.length) {
    console.error(`\nFALHOU, o deploy retiraria ou mudaria coisas da versão 12:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nOK. O toml reproduz a versão 12 e só acrescenta o esperado.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
