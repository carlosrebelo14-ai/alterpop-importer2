#!/usr/bin/env node
/**
 * D1 (briefing de integridade, 09/10/2026) — confirmação das ações em massa acima de 50.
 * O servidor recusa sem confirmação do número exato e quando o número confirmado não é o real.
 * Helper puro + verificação de que as rotas o chamam ANTES de qualquer escrita.
 * Uso: node scripts/tests/bulk-confirm.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBulkConfirm,
  BulkConfirmError,
  isBulkConfirmed,
  BULK_CONFIRM_THRESHOLD,
  BULK_SAMPLE_SIZE,
} from "../../lib/curation/bulkConfirm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

check("o limiar é 50 e a amostra são 5 SKUs", () => {
  assert.equal(BULK_CONFIRM_THRESHOLD, 50);
  assert.equal(BULK_SAMPLE_SIZE, 5);
});
check("até 50 produtos não exige confirmação", () => {
  assert.doesNotThrow(() => assertBulkConfirm(1, undefined));
  assert.doesNotThrow(() => assertBulkConfirm(50, undefined));
  assert.doesNotThrow(() => assertBulkConfirm(0, null));
});
check("51 produtos sem confirmação → CONFIRM_REQUIRED", () => {
  assert.throws(() => assertBulkConfirm(51, undefined), (e) => e instanceof BulkConfirmError && e.code === "CONFIRM_REQUIRED" && e.count === 51);
  assert.throws(() => assertBulkConfirm(13016, null), (e) => e.code === "CONFIRM_REQUIRED");
});
check("confirmação que não é um inteiro (texto, decimal, string) é recusada", () => {
  for (const bad of ["13016", 13016.5, NaN, "abc", {}, true]) {
    assert.throws(() => assertBulkConfirm(13016, bad), (e) => e.code === "CONFIRM_REQUIRED", String(bad));
  }
});
check("número confirmado diferente do real → COUNT_MISMATCH com os dois números", () => {
  assert.throws(() => assertBulkConfirm(13016, 4), (e) => e.code === "COUNT_MISMATCH" && e.count === 13016 && e.confirmed === 4);
  assert.throws(() => assertBulkConfirm(51, 50), (e) => e.code === "COUNT_MISMATCH");
});
check("número exato passa", () => {
  assert.doesNotThrow(() => assertBulkConfirm(13016, 13016));
  assert.doesNotThrow(() => assertBulkConfirm(51, 51));
});
check("a mensagem diz a ação e o número, para o utilizador ver o que está a confirmar", () => {
  assert.throws(() => assertBulkConfirm(13016, undefined, { what: "Aprovar" }), /Aprovar aplica-se a 13016 produtos/);
});
check("isBulkConfirmed: abaixo do limiar nada a escrever; acima, o número exato", () => {
  assert.equal(isBulkConfirmed(10, ""), true);
  assert.equal(isBulkConfirmed(50, ""), true);
  assert.equal(isBulkConfirmed(51, ""), false);
  assert.equal(isBulkConfirmed(13016, "13016"), true);
  assert.equal(isBulkConfirmed(13016, " 13016 "), true);
  assert.equal(isBulkConfirmed(13016, "13 016"), false);
});

console.log("Rotas");
check("a ação em massa (aprovar/rejeitar, seleção e filtro) confirma ANTES de gravar", () => {
  const src = read("app/routes/api.curation.queue.bulk.jsx");
  const confirmAt = src.indexOf("assertBulkConfirm(skus.length");
  const writeAt = src.indexOf("bulkSetQueueStatus(skus, targetStatus)");
  assert.ok(confirmAt > 0, "não chama assertBulkConfirm");
  assert.ok(writeAt > confirmAt, "grava antes de confirmar");
  assert.match(src, /\["approve", "reject", "approve_filtered", "reject_filtered"\]\.includes\(actionName\)/);
  assert.match(src, /instanceof BulkConfirmError/);
});
check("a ação em massa tem pré-visualização do âmbito (contagem e amostra) sem gravar", () => {
  const src = read("app/routes/api.curation.queue.bulk.jsx");
  const a = src.indexOf('actionName === "preview_filtered"');
  assert.ok(a > 0);
  const block = src.slice(a, a + 700);
  assert.ok(!/bulkSetQueueStatus|bulkSetMarginPct/.test(block), "a pré-visualização escreve");
  assert.match(block, /BULK_SAMPLE_SIZE/);
});
check("a publicação confirma ANTES de iniciar o job e de qualquer escrita na Shopify", () => {
  const src = read("app/routes/api.shopify-sync.jsx");
  const confirmAt = src.indexOf("assertBulkConfirm(approvedSkus.length");
  const jobAt = src.indexOf("await initShopifySyncJob(");
  const startAt = src.indexOf("startApprovedShopifySyncInBackground(session");
  assert.ok(confirmAt > 0, "não chama assertBulkConfirm");
  assert.ok(jobAt > confirmAt && startAt > confirmAt, "inicia o job antes de confirmar");
  assert.match(src, /Number\.isInteger\(json\.confirmCount\)/);
});
check("há um único componente de confirmação e usa as constantes partilhadas", () => {
  const src = read("app/components/BulkActionConfirm.jsx");
  assert.match(src, /lib\/curation\/bulkConfirm\.js/);
  assert.ok(!/export const BULK_CONFIRM_THRESHOLD = 50/.test(src), "duplicou o limiar");
});

console.log("Interface");
const page = read("app/routes/app._index.jsx");
check("nenhum botão chama a ação em massa diretamente: seleção passa por requestBulkStatus", () => {
  assert.ok(!/onAction: \(\) => runBulkStatus\(/.test(page), "ação de menu chama runBulkStatus");
  assert.ok(!/onClick=\{\(\) => runBulkStatus\(/.test(page), "botão chama runBulkStatus");
  assert.match(page, /requestBulkStatus\("approve"\)/);
  assert.match(page, /requestBulkStatus\("reject"\)/);
  assert.match(page, /selectedSkus\.length > BULK_CONFIRM_THRESHOLD/);
});
check("«Aprovar/Rejeitar Toda a Pesquisa» conta no servidor e confirma com o número exato", () => {
  assert.match(page, /action: "preview_filtered"/);
  assert.match(page, /runBulkApproveFiltered\(action, confirmCount\)/);
  assert.match(page, /<BulkConfirmModal[\s\S]{0,200}massActionConfirm/);
  assert.ok(!/onClick=\{\(\) => runBulkApproveFiltered\(/.test(page), "executa o filtro sem confirmar");
});
check("publicar envia o número e passa pela confirmação acima de 50 (botão e modal de staging)", () => {
  assert.match(page, /body: JSON\.stringify\(\{ confirmCount \}\)/);
  assert.match(page, /approvedSkus\.length > BULK_CONFIRM_THRESHOLD/);
  assert.match(page, /confirmCount: \(selectedSkus\.length > 0 \? selectedSkus : approvedSkus\)\.length/);
  const staging = read("app/components/SyncStagingModal.jsx");
  assert.match(staging, /isBulkConfirmed\(publishCount, typed\)/);
  assert.match(staging, /BulkActionConfirm/);
});
check("os dois modais de confirmação usam o mesmo componente BulkActionConfirm", () => {
  assert.match(read("app/components/BulkConfirmModal.jsx"), /BulkActionConfirm/);
  assert.match(read("app/components/RepricePublishedButton.jsx"), /BulkActionConfirm/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
