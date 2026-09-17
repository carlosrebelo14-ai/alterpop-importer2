#!/usr/bin/env node
/**
 * Garante a definição do metaobject `character` e as duas definições de metafield
 * (`alterpop.character` no produto, `alterpop.characters` na coleção) na loja jyr17t-wr.
 *
 * Resposta da app de 17/09/2026 (claude/resposta-app-briefing-16-09-2026.md), secção
 * "Ordem antes de criar a definição": nenhuma escrita antes do probe de leitura passar —
 * uma definição criada com campos errados numa loja live não se corrige, migra-se.
 *
 * Uso:
 *   node scripts/setup/ensure-character-metaobject.js            # dry-run: só sonda e reporta
 *   node scripts/setup/ensure-character-metaobject.js --execute  # cria o que faltar
 *
 * Corre com a sessão OAuth da própria app alterpop-importer (não o conector MCP —
 * são integrações distintas com scopes concedidos separadamente).
 */
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import {
  CHARACTER_METAOBJECT_TYPE,
  probeMetaobjectDefinitionsReadAccess,
  ensureCharacterMetaobjectDefinition,
  ensureCharacterMetafieldDefinitions,
} from "../../lib/importer/shopify/characterMetaobjectSetup.js";

const EXECUTE = process.argv.includes("--execute");

async function main() {
  const shop =
    process.env.CHARACTER_SETUP_SHOP ||
    process.env.SHOPIFY_SHOP_URL ||
    "jyr17t-wr.myshopify.com";

  // Mesma fonte de sessão que os jobs de sync em background usam (resolveSessionStorage
  // — FileSessionStorage em produção, não a tabela Session do Prisma, que fica vazia).
  const session = await loadOfflineSessionForShop(shop);
  const client = createShopifyClientFromSession(session);

  console.log("=== Alterpop — ensure character metaobject ===");
  console.log(`Loja: ${session.shop}`);
  console.log(`Modo: ${EXECUTE ? "EXECUTE (vai escrever)" : "dry-run (só sonda)"}`);

  console.log("\n1. Probe de leitura (read_metaobject_definitions)...");
  await probeMetaobjectDefinitionsReadAccess(client);
  console.log("   ✓ Probe passou — read_metaobject_definitions concedido.");

  if (!EXECUTE) {
    console.log(
      `\nDry-run terminado. Corre com --execute para criar a definição '${CHARACTER_METAOBJECT_TYPE}' e os metafields alterpop.character / alterpop.characters, se ainda não existirem.`
    );
    return;
  }

  console.log(`\n2. metaobjectDefinitionCreate (idempotente, type=${CHARACTER_METAOBJECT_TYPE})...`);
  const metaobjectResult = await ensureCharacterMetaobjectDefinition(client);
  console.log(
    `   ${metaobjectResult.created ? "✓ Criada via API" : "= Já existia"} — id ${metaobjectResult.definition.id}`
  );
  console.log(
    `   Campos: ${metaobjectResult.definition.fieldDefinitions
      .map((f) => `${f.key}:${f.type.name}`)
      .join(", ")}`
  );

  console.log("\n3. Metafield definitions (alterpop.character, alterpop.characters)...");
  const { product, collection } = await ensureCharacterMetafieldDefinitions(
    client,
    metaobjectResult.definition.id
  );
  console.log(
    `   alterpop.character: ${product.created ? "criado via API" : "já existia"} (${product.definition.id})`
  );
  console.log(
    `   alterpop.characters: ${collection.created ? "criado via API" : "já existia"} (${collection.definition.id})`
  );

  console.log("\n✓ Concluído.");
}

main().catch((err) => {
  console.error("\n✗ " + (err.message || err));
  process.exit(1);
});
