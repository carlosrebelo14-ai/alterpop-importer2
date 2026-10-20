import crypto from "node:crypto";
import { readDbDegraded } from "../../lib/health/dbDegraded.js";
import {
  isCatalogIndexingRunning,
  startCatalogIndexingWorker,
} from "../../lib/importer/catalog/indexingStream.server.js";
import {
  podePublicarDepoisDaIndexacao,
  readCatalogRebuildStatus,
} from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { runApprovedShopifySync } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";
import { publicacaoOuResetEmCurso } from "../../lib/importer/shopify/publicacaoEmCurso.js";
import {
  atividadeAppEmCurso,
  causaDeRecusaPorScript,
  decisaoDaPublicacaoManual,
  marcarAtividadeApp,
  motivoDeRecusaPorScript,
  scriptDeIndexacaoEmCurso,
} from "../../lib/curation/atividadeApp.js";
import { tentarReservarPublicacao } from "../../lib/importer/shopify/publicacaoEmCurso.js";
import { isShopifyResetRunning } from "../../lib/importer/shopify/shopifyResetJob.server.js";
import { syncPublishedStockLevels } from "../../lib/importer/shopify/publishedStockSync.server.js";
import { isShopifySyncRunning } from "../../lib/importer/shopify/shopifySyncJob.server.js";
import { listApprovedSkusForShopifySync } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { loadShopSettings, getDefaultSettings } from "../../lib/importer/settings.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { ensureOciostockMetafieldDefinitions } from "../../lib/importer/shopify/metafieldSetup.js";
import { syncFranchiseCatalog } from "../../lib/importer/shopify/franchiseCatalogSync.server.js";
import { reconcileNewArrivalsCycle } from "../../lib/importer/shopify/newArrivals.server.js";
import { reconcileLiveDriftCycle } from "../../lib/importer/shopify/liveDriftReconcileCycle.server.js";
import { reconcileCharacterPagesCycle } from "../../lib/importer/shopify/characterPagesReconcileCycle.server.js";
import { reconcileCollectionPublicationCycle } from "../../lib/importer/shopify/collectionPublicationReconcileCycle.server.js";
import { persistSyncError } from "../../lib/importer/sync/syncErrorLog.server.js";
import {
  reconcileMarginErosionCycle,
  markMarginErosionCycleSkipped,
} from "../../lib/importer/curation/marginErosion.server.js";

/**
 * POST /api/trigger-sync — dispara indexação + publicação sem sessão OAuth.
 *
 * Existe para a máquina-relógio (app Fly `alterpop-sync-clock`) poder acordar o ciclo
 * periodicamente. NÃO usa autenticação Shopify: quem chama é uma máquina, não um browser.
 *
 * SEGURANÇA
 * - Segredo partilhado em `SYNC_TRIGGER_SECRET` (Fly secret, nunca no fly.toml).
 * - Sem segredo configurado o endpoint fica FECHADO (503) — falha segura: um deploy que
 *   perca a env var não abre o endpoint ao mundo.
 * - Comparação em tempo constante (timingSafeEqual) para não vazar o segredo byte a byte
 *   através da duração da resposta.
 * - Resposta 401 é sempre idêntica, sem distinguir "sem header" de "header errado".
 *
 * ASSÍNCRONO por desenho: o ciclo completo (download de ~71 MB + indexação de ~30k
 * produtos + publish) leva vários minutos, muito acima do timeout do proxy da Fly.
 * Responde 202 assim que arranca e o chamador não espera pelo fim — o progresso real
 * consulta-se em /api/catalog-status e /api/shopify-sync.
 */

const JSON_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
};

/** Espera máxima pela indexação antes de desistir do publish (indexação típica: ~6 min). */
const INDEXING_TIMEOUT_MS = 40 * 60 * 1000;
const INDEXING_POLL_MS = 10 * 1000;

/** Comparação em tempo constante, tolerante a comprimentos diferentes. */
function secretMatches(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual exige comprimentos iguais; compara hashes para normalizar sem
  // revelar o comprimento do segredo pela via do erro.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const unauthorized = () =>
  Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: JSON_HEADERS });

export const loader = () =>
  Response.json(
    { ok: false, error: "Method not allowed" },
    { status: 405, headers: JSON_HEADERS }
  );

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers: JSON_HEADERS }
    );
  }

  const expected = process.env.SYNC_TRIGGER_SECRET;
  if (!expected) {
    console.warn("[trigger-sync] SYNC_TRIGGER_SECRET não configurado — endpoint fechado.");
    return Response.json(
      { ok: false, error: "Trigger endpoint not configured" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  if (!secretMatches(request.headers.get("X-Sync-Token"), expected)) {
    return unauthorized();
  }

  const shop = process.env.SHOPIFY_SHOP_URL;
  if (!shop) {
    return Response.json(
      { ok: false, error: "SHOPIFY_SHOP_URL not configured" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  // Nunca sobrepor ciclos: uma segunda indexação sobre a mesma BD corromperia contagens
  // e duplicaria trabalho. 409 é resposta normal para o relógio, não erro.
  // `skipped: true` distingue "não havia nada a fazer" de "correu mal" — o relógio usa
  // este campo para não registar um ciclo saltado como falha nos seus logs.
  if (isCatalogIndexingRunning(shop)) {
    console.log("[trigger-sync] ciclo saltado: indexação já em curso.");
    return Response.json(
      { ok: true, skipped: true, reason: "indexing_already_running" },
      { status: 409, headers: JSON_HEADERS }
    );
  }
  // PR 5 (DBG-140 e DBG-141): um script de reindexação vivo tem a loja. O ciclo não arranca por cima dele.
  const atividadeScript = scriptDeIndexacaoEmCurso();
  const recusaScript = motivoDeRecusaPorScript(atividadeScript);
  if (recusaScript) {
    console.log(`[trigger-sync] ciclo saltado: ${recusaScript}`);
    // Sem registo, o Relatório mostrava o último ciclo como se este não tivesse sido pedido (PR 5, revisão de convergência).
    await markMarginErosionCycleSkipped(shop, `ciclo saltado: ${causaDeRecusaPorScript(atividadeScript)}`);
    return Response.json(
      { ok: true, skipped: true, reason: atividadeScript.tipo === "script" ? "script_indexing_running" : "activity_marker_unreadable" },
      { status: 409, headers: JSON_HEADERS }
    );
  }
  // PR 5 (revisão): um reset ou uma publicação com a reserva tomada faz o ciclo responder 409 já aqui, e não 202.
  if (publicacaoOuResetEmCurso()) {
    console.log("[trigger-sync] ciclo saltado: publicação ou reset Shopify em curso.");
    await markMarginErosionCycleSkipped(shop, "ciclo saltado: publicação ou reset Shopify em curso");
    return Response.json(
      { ok: true, skipped: true, reason: "publish_or_reset_running" },
      { status: 409, headers: JSON_HEADERS }
    );
  }
  if (await isShopifySyncRunning(shop)) {
    console.log("[trigger-sync] ciclo saltado: publicação já em curso.");
    return Response.json(
      { ok: true, skipped: true, reason: "publish_already_running" },
      { status: 409, headers: JSON_HEADERS }
    );
  }

  let session;
  try {
    session = await loadOfflineSessionForShop(shop);
  } catch (err) {
    console.error("[trigger-sync] sessão indisponível:", err?.message || err);
    return Response.json(
      { ok: false, error: "Shopify session unavailable" },
      { status: 503, headers: JSON_HEADERS }
    );
  }

  // Definições ilegíveis: o ciclo salta tudo o que depende delas — indexação (URL e
  // mapa de colunas do CSV), publicação (margem) e stock (buffer) — e corre o resto
  // (novidades, drift, coleções, personagens, erosão sobre o catálogo existente). O erro
  // fica no registo de sync; sem indexação, nada o desativa até o ficheiro ser reposto.
  let settings;
  let settingsError = null;
  try {
    settings = await loadShopSettings(shop);
  } catch (err) {
    settingsError = err?.message || String(err);
    console.error("[trigger-sync] definições ilegíveis — indexação, publicação e stock saltados:", settingsError);
    // persistSyncError ignora entradas sem SKU — "(definições)" põe o erro no registo
    // de sync que a UI já lê.
    await persistSyncError({ shop, sku: "(definições)", reason: `Definições ilegíveis: ${err?.message || err}` }).catch(
      (logErr) => console.error("[trigger-sync] persistSyncError falhou:", logErr?.message || logErr)
    );
    settings = getDefaultSettings();
  }
  // Modo degradado (Decisão 34): o ciclo inteiro não arranca (indexação, publish, stock).
  const dbDegraded = readDbDegraded();
  if (dbDegraded) {
    console.error(`[trigger-sync] BD em modo degradado (${dbDegraded.cause}) — ciclo não arrancou.`);
    return Response.json({ ok: false, error: `BD em modo degradado: ${dbDegraded.cause}`, dbDegraded }, { status: 503 });
  }
  const startedAt = new Date().toISOString();

  // Arranca em background e devolve já — o ciclo demora minutos.
  //
  // ATENÇÃO: startCatalogIndexingWorker devolve ANTES de terminar (o trabalho corre num
  // IIFE destacado) — daí o polling explícito antes de publicar sobre um catálogo já
  // completo. Dentro do IIFE, runApprovedShopifySync e syncPublishedStockLevels (item
  // 18b) correm sequencialmente com await — não bloqueiam a resposta HTTP (já foi
  // devolvida antes disto), só garantem que não disputam a API da Shopify ao mesmo tempo.
  void (async () => {
    try {
      console.log(`[trigger-sync] ciclo iniciado @ ${startedAt}`);
      if (!settingsError) {
        // PR 5: null é recusa (script, publicação ou reset em curso) ou falha ao gravar o estado. O ciclo não segue,
        // nem publica com o estado antigo do disco (que ainda diz completed com linhas).
        const arranque = await startCatalogIndexingWorker(shop, settings, { runPurge: false, resume: false, causa: "ciclo" });
        if (arranque === null) {
          // null é recusa por script, por publicação ou reset, ou falha ao gravar o estado. O Relatório diz a causa.
          const scriptVivo = scriptDeIndexacaoEmCurso();
          let causa = "marcação ou gravação do estado falhou (ver log)";
          if (scriptVivo) causa = causaDeRecusaPorScript(scriptVivo);
          else if (publicacaoOuResetEmCurso()) causa = "publicação ou reset Shopify em curso";
          console.error(`[trigger-sync] ciclo parado antes da publicação: indexação não arrancou (${causa}).`);
          await markMarginErosionCycleSkipped(shop, `ciclo parado: ${causa}`);
          return;
        }

        const deadline = Date.now() + INDEXING_TIMEOUT_MS;
        while (isCatalogIndexingRunning(shop)) {
          if (Date.now() > deadline) {
            console.error("[trigger-sync] indexação excedeu o tempo limite — publish cancelado.");
            await markMarginErosionCycleSkipped(shop, "indexação excedeu o tempo limite");
            return;
          }
          await new Promise((r) => setTimeout(r, INDEXING_POLL_MS));
        }

        // Decisão 7 (DBG-69). Só completed com totalRows > 0 publica. Qualquer outro caso recusa a publicação. A recusa
        // fica no log com a marca estável "[ciclo] publicação recusada" e em Relatórios, como "não correu".
        const status = await readCatalogRebuildStatus(shop);
        if (!podePublicarDepoisDaIndexacao(status)) {
          const motivo =
            status?.error || (status?.state === "completed" ? "indexação sem linhas" : `estado ${status?.state ?? "ausente"}`);
          console.error(`[ciclo] publicação recusada: ${motivo}.`);
          await markMarginErosionCycleSkipped(shop, `indexação terminou com erro (${motivo})`);
          return;
        }

        console.log(`[trigger-sync] indexação concluída (${status.totalRows ?? "?"} linhas).`);
      }

      // Garante que as definições de metafield existem (ociostock.net_price e
      // ociostock.dimensions) — na primeira execução automática ninguém abriu o Admin
      // para as criar. Falha aqui não impede o publish: as definições são um extra,
      // não um pré-requisito para criar produtos.
      try {
        const client = createShopifyClientFromSession(session);
        await ensureOciostockMetafieldDefinitions(client, null);
        console.log("[trigger-sync] definições de metafield garantidas.");
      } catch (err) {
        console.warn("[trigger-sync] definições de metafield falharam:", err?.message || err);
      }

      if (!settingsError) {
        // DBG-105: a reserva é tomada logo antes da chamada, sem await pelo meio. Se a publicação manual já a tem,
        // o ciclo salta a publicação de aprovados.
        // PR 5 (revisão): a reserva e a marca da app nascem no mesmo passo síncrono. Com a reserva na mão, confirma-se a
        // indexação, que pode ter arrancado depois do arranque do ciclo. Se houver indexação ou script, o ciclo para aqui, sem publicar nem seguir para o stock.
        // D42 (Decisão 35): com um reset em curso, o ciclo salta a publicação e regista o salto. O reset pode correr
        // noutro processo (purga CLI), por isso confirma-se também pelo estado em disco, não só pela reserva em memória.
        const resetEmCurso = await isShopifyResetRunning(shop);
        let reserva = null;
        let marcaFalhou = false;
        if (!resetEmCurso) {
          try {
            reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });
          } catch (err) {
            marcaFalhou = true;
            console.error("[trigger-sync] ciclo parado antes da publicação: não foi possível marcar a atividade da app.", err?.message || err);
          }
        }
        if (marcaFalhou) {
          // PR 5 (revisão): sem marca, a exclusão com a indexação não se garante. O ciclo para, como no caso de confirmação.
          await markMarginErosionCycleSkipped(shop, "não foi possível marcar a atividade da app antes da publicação");
          return;
        } else if (!reserva) {
          const causa = resetEmCurso
            ? "reset Shopify em curso (estado em disco)"
            : "reserva ocupada por uma publicação manual ou por um reset em curso";
          console.log(`[trigger-sync] publicação de aprovados saltada: ${causa}.`);
          await markMarginErosionCycleSkipped(shop, `publicação de aprovados saltada: ${causa}`);
        } else {
          let decisao = null;
          try {
            decisao = decisaoDaPublicacaoManual({
              indexacaoEmCurso: isCatalogIndexingRunning(shop) || atividadeAppEmCurso()?.tipo === "indexacao",
              atividadeScript: scriptDeIndexacaoEmCurso(),
            });
          } catch (err) {
            // A falha da confirmação conta como recusa: o ciclo para com a causa, e a exceção não sai do IIFE.
            decisao = {
              causa: "não foi possível confirmar a indexação",
              mensagem: `não foi possível confirmar a indexação (${err?.message || err})`,
            };
          }
          if (decisao) {
            // PR 5 (revisão): sem confirmação de que não há indexação, o ciclo para aqui. Não publica nem corre o stock,
            // as franquias, a erosão nem as coleções, porque as coleções publicam sem reserva. O Relatório recebe a causa
            // curta. A frase da recusa fica no log.
            reserva.libertar();
            console.log(`[trigger-sync] ciclo parado antes da publicação: ${decisao.mensagem}`);
            await markMarginErosionCycleSkipped(shop, `ciclo parado: ${decisao.causa}`);
            return;
          } else {
            console.log("[trigger-sync] a publicar aprovados…");
            try {
              await runApprovedShopifySync(session, { skipInit: true, reserva });
              console.log("[trigger-sync] publicação de aprovados concluída.");
            } catch (err) {
              console.error("[trigger-sync] publicação de aprovados falhou:", err?.message || err);
            }
          }
        }
      }

      // As coleções automáticas por licença (ociostock.licence) foram substituídas pelas
      // coleções Universe (alterpop.franchise, ver universeCollections.server.js) e
      // apagadas na limpeza de 2026-09-08. O módulo autoCollections.server.js foi removido.

      // Item 18b — produtos já PUBLISHED não entram no runApprovedShopifySync acima
      // (esse só processa status APPROVED). Sem isto, um produto que esgota e o
      // fornecedor repõe stock ficava preso a "sem stock" na Shopify até alguém o
      // reaprovar manualmente. Corre sempre a seguir ao publish normal, nunca em
      // paralelo — evita as duas rotinas disputarem o mesmo variantCache/rate limit.
      if (!settingsError) {
        try {
          const stockClient = createShopifyClientFromSession(session);
          const stockResult = await syncPublishedStockLevels(stockClient, shop, {
            stockBuffer: settings.stockBuffer,
          });
          console.log(
            `[trigger-sync] stock de publicados: ${stockResult.checked} verificados, ${stockResult.updated} atualizados, ${stockResult.skipped} sem alteração, ${stockResult.failed} falhas.`
          );
          // stockResult.failures[] era calculado e nunca lido por ninguém — a falha
          // ficava só na contagem, sem SKU nem mensagem (achado 24/09). Grava no mesmo
          // registo de sync que a UI já lê, em vez de inventar um caminho novo.
          for (const f of stockResult.failures || []) {
            console.error(`[trigger-sync] stock de publicados — falha em ${f.sku}: ${f.message}`);
            await persistSyncError({ shop, sku: f.sku, reason: f.message }).catch((err) => {
              console.error(`[trigger-sync] persistSyncError falhou para ${f.sku}:`, err?.message || err);
            });
          }
        } catch (err) {
          // DBG-09: a falha de leitura do catálogo (ou de outra etapa do ciclo de stock) tem de
          // contar como falha no registo de sync, não só no console. Sem SKU, o rótulo entre
          // parênteses é o que persistSyncError aceita.
          console.error("[trigger-sync] sync de stock de publicados falhou:", err?.message || err);
          await persistSyncError({
            shop,
            sku: "(stock de publicados)",
            reason: `Ciclo de stock interrompido: ${err?.message || err}`,
          }).catch((logErr) => {
            console.error("[trigger-sync] persistSyncError falhou (stock):", logErr?.message || logErr);
          });
        }
      }

      // Erosão de margem (revisão do dry-run de preços, 07/10/2026) — preço live contra
      // o custo atual do feed, que a indexação acima acabou de refrescar. Só lê e grava
      // o estado para Relatórios; nunca mexe em preço. Nunca bloqueia o ciclo.
      if (settingsError) {
        // Sem indexação o custo do catálogo é o do último ciclo bom — medir agora daria um
        // verde atual sobre dados velhos. Fica "não correu", à vista nos Relatórios.
        await markMarginErosionCycleSkipped(shop, "definições ilegíveis — catálogo não reindexado");
      } else {
        try {
          const erosionClient = createShopifyClientFromSession(session);
          const erosion = await reconcileMarginErosionCycle(erosionClient, shop);
          const line = `[trigger-sync] erosão de margem: ${erosion.status} — ${erosion.red.length} abaixo de ${erosion.thresholdPct}%, ${erosion.noData.length} sem dados, ${erosion.measured}/${erosion.publishedCount} medidos.`;
          if (erosion.status === "red") console.error(line);
          else console.log(line);
        } catch (err) {
          console.error("[trigger-sync] erosão de margem falhou:", err?.message || err);
        }
      }

      // Catálogo de franquias com stock, para a grelha de /pages/franquias no tema.
      // Corre depois do sync de stock de publicados (item 18b), para refletir o
      // stock mais recente. Nunca bloqueia nem falha o ciclo.
      try {
        const franchiseClient = createShopifyClientFromSession(session);
        const franchiseResult = await syncFranchiseCatalog(franchiseClient, shop);
        if (franchiseResult.ok) {
          console.log(
            `[trigger-sync] catálogo de franquias: ${franchiseResult.franchiseCount} franquias, ${franchiseResult.inStockCount} com stock.`
          );
        } else {
          console.error("[trigger-sync] catálogo de franquias falhou:", franchiseResult.error);
        }
      } catch (err) {
        console.error("[trigger-sync] catálogo de franquias falhou:", err?.message || err);
      }

      // new-arrivals — N1 (briefing 27/09). Substitui o newArrivalsSync (tags): a
      // coleção é smart por alterpop.is_new_arrival EQUALS true; este ciclo preenche
      // first_published_at nos ACTIVE publicados sem data e expira is_new_arrival
      // depois de NEW_ARRIVAL_DAYS. Só metafieldsSet. Grava sempre o estado V15, também
      // em falha — nunca bloqueia o ciclo, mas nunca falha em silêncio.
      try {
        const naClient = createShopifyClientFromSession(session);
        const naState = await reconcileNewArrivalsCycle(naClient, shop);
        const line =
          `[trigger-sync] new-arrivals V15 ${naState.status}: ` +
          (naState.reason
            ? naState.reason
            : `${naState.expirations.length} expirado(s), ${naState.fills.length} preenchido(s), ${naState.anomalies.length} anomalia(s), ${naState.processed}/${naState.activeCount} ACTIVE.`);
        if (naState.status === "red") console.error(line);
        else console.log(line);
      } catch (err) {
        console.error("[trigger-sync] new-arrivals V15 falhou:", err?.message || err);
      }

      // Item 7 (ADENDA 7, 17/09/2026) — reconciliador de drift alterpop.* por ciclo,
      // V13. Só metafieldsSet, só alterpop.*, nunca título/preço/descrição. Travão
      // MAX_AUTO_RECONCILE: acima disso não escreve nada, fica vermelho para um humano
      // ver antes de qualquer escrita em massa. Nunca bloqueia o ciclo.
      try {
        const driftClient = createShopifyClientFromSession(session);
        const driftResult = await reconcileLiveDriftCycle(driftClient, shop);
        console.log(
          `[trigger-sync] live-drift (V13): ${driftResult.status} — ${driftResult.corrected.length} corrigido(s), ${driftResult.blocked.length} bloqueado(s) pelo travão.`
        );
      } catch (err) {
        console.error("[trigger-sync] live-drift (V13) falhou:", err?.message || err);
      }

      // B14, secções 7-8 (briefing backend, 24/09/2026) — reconciliação de publicação
      // de coleções Universe/Line, V14. Cobre coleções que já existiam antes deste
      // ciclo ou que perderam a publicação por um erro pontual (a publicação-na-criação
      // vive em universeCollections.server.js). Nunca despublica — uma "closed" já
      // publicada fica só registada. Travão MAX_AUTO_PUBLISH: acima disso não publica
      // nenhuma, fica vermelho para um humano ver. Nunca bloqueia o ciclo.
      try {
        const collPubClient = createShopifyClientFromSession(session);
        const collPubResult = await reconcileCollectionPublicationCycle(collPubClient, shop);
        console.log(
          `[trigger-sync] collection-publication (V14): ${collPubResult.status}${collPubResult.reason ? ` (${collPubResult.reason})` : ""} — ${collPubResult.published.length} publicada(s), ${collPubResult.registerOnly.length} registada(s) (closed publicada), ${collPubResult.blocked.length} bloqueada(s) pelo travão.`
        );
      } catch (err) {
        console.error("[trigger-sync] collection-publication (V14) falhou:", err?.message || err);
      }

      // B7, passo 9 (briefing backend, 17/09/2026) — ciclo de metaobjects `character`.
      // Mesmo travão do live-drift acima (MAX_CHARACTER_CHANGES_PER_CYCLE = 10): até 10
      // Characters alterados no ciclo aplica sozinho, acima disso não escreve nada e fica
      // vermelho. Nunca bloqueia o ciclo.
      try {
        const characterClient = createShopifyClientFromSession(session);
        const characterResult = await reconcileCharacterPagesCycle(characterClient, shop);
        console.log(
          `[trigger-sync] character-pages: ${characterResult.status} — ${characterResult.changed.length} alterado(s), ${characterResult.blocked.length} bloqueado(s) pelo travão, ${characterResult.invalid.length} inválido(s) (>128 produtos).`
        );
      } catch (err) {
        console.error("[trigger-sync] character-pages falhou:", err?.message || err);
      }
    } catch (err) {
      console.error("[trigger-sync] ciclo falhou:", err?.message || err);
    }
  })();

  const approvedCount = (await listApprovedSkusForShopifySync()).length;
  return Response.json(
    { ok: true, accepted: true, startedAt, shop, approvedCount },
    { status: 202, headers: JSON_HEADERS }
  );
};
