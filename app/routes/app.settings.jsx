import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Banner,
  BlockStack,
  Button,
  DataTable,
  InlineStack,
  Select,
  Tabs,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { ShopifyResetModal } from "../components/ShopifyResetModal.jsx";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateAdmin } from "../utils/authenticate.server";
import { loadShopSettings, saveShopSettings } from "../../lib/importer/settings.server.js";
import { resolveTranslationConfig } from "../../lib/importer/transform/translationConfig.js";
import {
  readExcludeListJson,
  writeExcludeListJson,
} from "../../lib/importer/curation/excludeListFile.server.js";
import {
  primeMarketSettingsForShop,
  readMarketSettingsJson,
  saveMarketSettings,
} from "../../lib/importer/curation/dynamicRules.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const settings = await loadShopSettings(session.shop);
  const translation = resolveTranslationConfig(settings);
  const excludeListJson = await readExcludeListJson();
  const marketSettings = await primeMarketSettingsForShop(session.shop);
  const marketSettingsJson = await readMarketSettingsJson(session.shop);
  return { settings, translation, excludeListJson, marketSettings, marketSettingsJson };
};

export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "save-exclude-list") {
    const raw = String(form.get("excludeListJson") || "");
    try {
      await writeExcludeListJson(raw);
      return { ok: true, intent: "exclude-list", excludeListJson: await readExcludeListJson() };
    } catch (err) {
      return {
        ok: false,
        intent: "exclude-list",
        error: err?.message || "Erro ao guardar exclude-list",
      };
    }
  }

  if (intent === "save-market-config") {
    const parseTagList = (value) =>
      [...new Set(String(value || "")
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean))];

    try {
      const marketSettings = await saveMarketSettings(session.shop, {
        vipBrands: parseTagList(form.get("vipBrands")),
        vipCategories: parseTagList(form.get("vipCategories")),
        blockedTerms: parseTagList(form.get("blockedTerms")),
        vipLicences: parseTagList(form.get("vipLicences")),
      });
      return {
        ok: true,
        intent: "market-config",
        marketSettings,
        marketSettingsJson: JSON.stringify(marketSettings, null, 2),
      };
    } catch (err) {
      return {
        ok: false,
        intent: "market-config",
        error: err?.message || "Erro ao guardar market configuration",
      };
    }
  }

  const settings = {
    ociostockCsvUrl: String(form.get("ociostockCsvUrl") || ""),
    translationProvider: String(form.get("translationProvider") || "passthrough"),
    translationApiKey: String(form.get("translationApiKey") || ""),
    translateToEnglish: form.get("translateToEnglish") === "on",
    autoGlossaryTranslation: form.get("autoGlossaryTranslation") === "on",
    importMode: String(form.get("importMode") || "CREATE_AND_UPDATE"),
    syncLimit: parseInt(String(form.get("syncLimit") || "0"), 10) || 0,
    skuAllowlist: String(form.get("skuAllowlist") || ""),
    locationId: String(form.get("locationId") || ""),
    syncProducts: form.get("syncProducts") === "on",
    syncInventory: form.get("syncInventory") === "on",
    syncImages: form.get("syncImages") === "on",
    syncPrices: form.get("syncPrices") === "on",
    batchSize: parseInt(String(form.get("batchSize") || "50"), 10) || 50,
    importInStockOnly: form.get("importInStockOnly") === "on",
    csvColumnMap: (() => {
      try {
        const raw = String(form.get("csvColumnMapJson") || "{}");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    })(),
  };

  await saveShopSettings(session.shop, settings);
  return { ok: true, settings };
};

export default function SettingsPage() {
  const { settings, translation, excludeListJson, marketSettings, marketSettingsJson } = useLoaderData();
  const fetcher = useFetcher();
  const excludeFetcher = useFetcher();
  const marketFetcher = useFetcher();
  const shopify = useAppBridge();
  const [excludeDraft, setExcludeDraft] = useState(excludeListJson);
  const [marketDraft, setMarketDraft] = useState(marketSettingsJson);
  const [marketTab, setMarketTab] = useState(0);
  const [vipBrands, setVipBrands] = useState(marketSettings?.vipBrands || []);
  const [vipCategories, setVipCategories] = useState(marketSettings?.vipCategories || []);
  const [blockedTerms, setBlockedTerms] = useState(marketSettings?.blockedTerms || []);
  const [vipLicences, setVipLicences] = useState(marketSettings?.vipLicences || []);
  const [newTag, setNewTag] = useState("");
  const [newLicenceTag, setNewLicenceTag] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetBanner, setResetBanner] = useState(null);
  const [toast, setToast] = useState(null);
  const [csvColumns, setCsvColumns] = useState([]);
  const [csvPreviewRows, setCsvPreviewRows] = useState([]);
  const [csvMapping, setCsvMapping] = useState(() => ({
    sku: settings.csvColumnMap?.sku || "",
    netPrice: settings.csvColumnMap?.netPrice || "",
    vendor: settings.csvColumnMap?.vendor || "",
  }));

  const handleResetComplete = useCallback((status) => {
    setResetBanner(
      `Reset concluído: ${status?.deleted ?? 0} apagado(s), ${status?.failed ?? 0} falha(s).`
    );
    setResetBusy(false);
    setToast({ content: "Shopify Reset complete" });
    shopify.toast.show("Reset Shopify concluído");
  }, [shopify]);

  useEffect(() => {
    setExcludeDraft(excludeListJson);
  }, [excludeListJson]);

  useEffect(() => {
    setMarketDraft(marketSettingsJson);
    setVipBrands(marketSettings?.vipBrands || []);
    setVipCategories(marketSettings?.vipCategories || []);
    setBlockedTerms(marketSettings?.blockedTerms || []);
    setVipLicences(marketSettings?.vipLicences || []);
  }, [
    marketSettingsJson,
    marketSettings?.vipBrands,
    marketSettings?.vipCategories,
    marketSettings?.blockedTerms,
    marketSettings?.vipLicences,
  ]);

  useEffect(() => {
    if (fetcher.data?.ok && !fetcher.data?.intent) {
      setToast({ content: "Settings saved" });
      shopify.toast.show("Definições guardadas");
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (excludeFetcher.data?.ok && excludeFetcher.data?.intent === "exclude-list") {
      shopify.toast.show("exclude-list.json guardado");
      setToast({ content: "Exclude list guardada" });
      if (excludeFetcher.data.excludeListJson) {
        setExcludeDraft(excludeFetcher.data.excludeListJson);
      }
    } else if (excludeFetcher.data?.error) {
      shopify.toast.show(excludeFetcher.data.error, { isError: true });
    }
  }, [excludeFetcher.data, shopify]);

  useEffect(() => {
    if (marketFetcher.data?.ok && marketFetcher.data?.intent === "market-config") {
      shopify.toast.show("Market Configuration guardada");
      setToast({ content: "Market configuration guardada" });
      if (marketFetcher.data.marketSettingsJson) {
        setMarketDraft(marketFetcher.data.marketSettingsJson);
      }
      if (marketFetcher.data.marketSettings) {
        setVipBrands(marketFetcher.data.marketSettings.vipBrands || []);
        setVipCategories(marketFetcher.data.marketSettings.vipCategories || []);
        setBlockedTerms(marketFetcher.data.marketSettings.blockedTerms || []);
        setVipLicences(marketFetcher.data.marketSettings.vipLicences || []);
      }
    } else if (marketFetcher.data?.error) {
      shopify.toast.show(marketFetcher.data.error, { isError: true });
    }
  }, [marketFetcher.data, shopify]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const tabs = [
    { id: "vip-brands", content: "VIP Brands" },
    { id: "vip-categories", content: "VIP Categories" },
    { id: "blocked-terms", content: "Blocked Terms" },
  ];

  const activeTags = marketTab === 0 ? vipBrands : marketTab === 1 ? vipCategories : blockedTerms;
  const activeSetter = marketTab === 0 ? setVipBrands : marketTab === 1 ? setVipCategories : setBlockedTerms;
  const activeLabel = marketTab === 0 ? "VIP Brands" : marketTab === 1 ? "VIP Categories" : "Blocked Terms";

  const addTag = useCallback(() => {
    const value = String(newTag || "").trim();
    if (!value) return;
    activeSetter((prev) => [...new Set([...prev, value])]);
    setNewTag("");
  }, [newTag, activeSetter]);

  const removeTag = useCallback(
    (tag) => activeSetter((prev) => prev.filter((item) => item !== tag)),
    [activeSetter]
  );

  const saveMarketConfig = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "save-market-config");
    fd.set("vipBrands", vipBrands.join("\n"));
    fd.set("vipCategories", vipCategories.join("\n"));
    fd.set("blockedTerms", blockedTerms.join("\n"));
    fd.set("vipLicences", vipLicences.join("\n"));
    marketFetcher.submit(fd, { method: "post" });
  }, [vipBrands, vipCategories, blockedTerms, vipLicences, marketFetcher]);

  const csvMapOptions = useMemo(
    () => [
      { label: "Selecionar coluna…", value: "" },
      ...csvColumns.map((c) => ({ label: c, value: c })),
    ],
    [csvColumns]
  );

  const parseCsvPreview = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4);
      if (lines.length < 2) return;
      const delimiter = lines[0].includes(";") ? ";" : ",";
      const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
      const preview = lines.slice(1, 4).map((line) =>
        line.split(delimiter).map((v) => v.trim().replace(/^"|"$/g, ""))
      );
      setCsvColumns(headers);
      setCsvPreviewRows(preview);
      setToast({ content: "CSV carregado. Mapeia as colunas abaixo." });
    };
    reader.readAsText(file);
  }, []);

  const s = fetcher.data?.settings || settings;
  const busy =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  const translationLabel = translation.translateToEnglish
    ? translation.provider === "passthrough"
      ? "Enabled but inactive (passthrough) — add DeepL API key"
      : `Active (${translation.provider})`
    : "Disabled";

  return (
    <div className="alterpop-dashboard alterpop-page-shell">
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-section heading="OcioStock">
          <s-text-field
            name="ociostockCsvUrl"
            label="CSV URL"
            value={s.ociostockCsvUrl}
            details="Plain CSV export from OcioStock (semicolon-delimited)"
          />
          <input
            type="hidden"
            name="csvColumnMapJson"
            value={JSON.stringify(csvMapping)}
            readOnly
          />
        </s-section>

        <s-section heading="Data Mapping Wizard">
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Faz upload do CSV e mapeia as colunas comerciais para o motor de importação.
            </Text>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => parseCsvPreview(e.target.files?.[0])}
            />
            {csvPreviewRows.length > 0 ? (
              <>
                <DataTable
                  columnContentTypes={new Array(csvColumns.length).fill("text")}
                  headings={csvColumns}
                  rows={csvPreviewRows}
                />
                <InlineStack gap="300" align="start">
                  <div style={{ minWidth: 240 }}>
                    <Select
                      label="Qual é a coluna do SKU?"
                      options={csvMapOptions}
                      value={csvMapping.sku}
                      onChange={(value) => setCsvMapping((prev) => ({ ...prev, sku: value }))}
                    />
                  </div>
                  <div style={{ minWidth: 240 }}>
                    <Select
                      label="Qual é a coluna do Preço?"
                      options={csvMapOptions}
                      value={csvMapping.netPrice}
                      onChange={(value) => setCsvMapping((prev) => ({ ...prev, netPrice: value }))}
                    />
                  </div>
                  <div style={{ minWidth: 240 }}>
                    <Select
                      label="Qual é a coluna da Marca?"
                      options={csvMapOptions}
                      value={csvMapping.vendor}
                      onChange={(value) => setCsvMapping((prev) => ({ ...prev, vendor: value }))}
                    />
                  </div>
                </InlineStack>
              </>
            ) : (
              <Text as="p" tone="subdued">
                Sem preview ainda. Faz upload de um CSV para iniciar o wizard.
              </Text>
            )}
          </BlockStack>
        </s-section>

        <s-section heading="Tradução (ES → EN)">
          <s-paragraph>Status: {translationLabel}</s-paragraph>
          <s-checkbox
            name="autoGlossaryTranslation"
            label="Tradução automática (glossário nos títulos — predefinição da loja)"
            checked={s.autoGlossaryTranslation !== false}
          />
          <s-checkbox
            name="translateToEnglish"
            label="Tradução API (DeepL) — opcional, além do glossário"
            checked={s.translateToEnglish === true}
          />
          <s-select name="translationProvider" label="Provider" value={s.translationProvider}>
            <option value="passthrough">passthrough (no API)</option>
            <option value="deepl">DeepL</option>
            <option value="libretranslate">LibreTranslate</option>
          </s-select>
          <s-text-field
            name="translationApiKey"
            label="API key"
            value={s.translationApiKey}
            details="Required for DeepL. Also set TRANSLATION_API_KEY in .env for dev."
          />
        </s-section>

        <s-section heading="Sync options">
          <s-checkbox name="syncImages" label="Sync product images" checked={s.syncImages !== false} />
          <s-checkbox name="syncPrices" label="Sync prices (gross price + net metafield)" checked={s.syncPrices !== false} />
          <s-checkbox name="syncProducts" label="Sync products" checked={s.syncProducts !== false} />
          <s-checkbox name="syncInventory" label="Sync inventory" checked={s.syncInventory !== false} />
        </s-section>

        <s-section heading="Import">
          <s-select name="importMode" label="Product mode" value={s.importMode}>
            <option value="UPDATE_ONLY">UPDATE_ONLY</option>
            <option value="CREATE_AND_UPDATE">CREATE_AND_UPDATE</option>
          </s-select>
          <s-text-field name="syncLimit" label="Default row limit (0 = all)" value={String(s.syncLimit)} />
          <s-text-field name="skuAllowlist" label="SKU allowlist (comma-separated)" value={s.skuAllowlist} />
          <s-text-field
            name="locationId"
            label="Inventory location GID (optional)"
            value={s.locationId}
            details="Leave empty to auto-detect primary fulfillment location"
          />
          <s-text-field name="batchSize" label="Batch size" value={String(s.batchSize)} />
          <s-checkbox
            name="importInStockOnly"
            label="Importar apenas produtos com stock (fornecedor)"
            checked={s.importInStockOnly === true}
            details="Aplica-se a importações CSV/stream e envios Shopify que usam filtros de importação."
          />
        </s-section>

        <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
          Save settings
        </s-button>
      </fetcher.Form>

      <s-section heading="Filtro de exclusão (exclude-list.json)">
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            Marcas, categorias e regras rejeitadas na indexação e curadoria. Ficheiro:{" "}
            <code>server/data/exclude-list.json</code>
          </Text>
          <excludeFetcher.Form method="post">
            <input type="hidden" name="intent" value="save-exclude-list" />
            <textarea
              name="excludeListJson"
              value={excludeDraft}
              onChange={(e) => setExcludeDraft(e.target.value)}
              rows={16}
              style={{
                width: "100%",
                fontFamily: "ui-monospace, monospace",
                fontSize: "12px",
                padding: "12px",
                borderRadius: "8px",
                border: "1px solid #c9cccf",
              }}
              spellCheck={false}
            />
            <div style={{ marginTop: "12px" }}>
              <Button
                submit
                variant="primary"
                loading={excludeFetcher.state !== "idle"}
              >
                Guardar exclude-list
              </Button>
            </div>
          </excludeFetcher.Form>
        </BlockStack>
      </s-section>

      <s-section heading="Market Configuration">
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            Motor multitenant: regras VIP e termos bloqueados editáveis por mercado.
          </Text>
          <Tabs tabs={tabs} selected={marketTab} onSelect={setMarketTab} />
          <Text as="p" tone="subdued">
            {activeLabel}: adiciona/remover tags dinâmicas para este mercado.
          </Text>
          <InlineStack gap="200" wrap>
            {activeTags.map((tag) => (
              <Tag key={`${activeLabel}-${tag}`} onRemove={() => removeTag(tag)}>
                {tag}
              </Tag>
            ))}
          </InlineStack>
          <InlineStack gap="200" align="start">
            <div style={{ minWidth: 320, flex: 1 }}>
              <TextField
                label={`Adicionar em ${activeLabel}`}
                value={newTag}
                onChange={setNewTag}
                autoComplete="off"
                placeholder="Escreve e adiciona..."
                onClearButtonClick={() => setNewTag("")}
                clearButton
              />
            </div>
            <div style={{ marginTop: 28 }}>
              <Button onClick={addTag}>Adicionar</Button>
            </div>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            VIP Licences (suporte backend): {(vipLicences || []).join(", ") || "sem valores"}
          </Text>
          <InlineStack gap="200" wrap>
            {vipLicences.map((tag) => (
              <Tag key={`lic-${tag}`} onRemove={() => setVipLicences((prev) => prev.filter((x) => x !== tag))}>
                {tag}
              </Tag>
            ))}
          </InlineStack>
          <InlineStack gap="200" align="start">
            <div style={{ minWidth: 320, flex: 1 }}>
              <TextField
                label="Adicionar VIP Licence"
                value={newLicenceTag}
                onChange={setNewLicenceTag}
                autoComplete="off"
                placeholder="Ex: Star Wars"
              />
            </div>
            <div style={{ marginTop: 28 }}>
              <Button onClick={() => {
                const value = String(newLicenceTag || "").trim();
                if (!value) return;
                setVipLicences((prev) => [...new Set([...prev, value])]);
                setNewLicenceTag("");
              }}>Adicionar</Button>
            </div>
          </InlineStack>
          <div style={{ marginTop: "12px" }}>
            <Button variant="primary" loading={marketFetcher.state !== "idle"} onClick={saveMarketConfig}>
              Guardar Market Configuration
            </Button>
          </div>
          <details>
            <summary>Ver JSON efetivo</summary>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: "8px" }}>{marketDraft}</pre>
          </details>
        </BlockStack>
      </s-section>

      <s-section heading="Emergência — Reset Shopify">
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            Apaga <strong>todos os produtos</strong> da loja Shopify (catálogo completo)
            e repõe o estado local para republicação limpa.
          </Text>
          {resetBanner && (
            <Banner tone="warning" onDismiss={() => setResetBanner(null)}>
              {resetBanner}
            </Banner>
          )}
          <Button
            tone="critical"
            onClick={() => setResetOpen(true)}
            disabled={resetBusy}
          >
            {resetBusy ? "Reset em curso…" : "Reset Shopify Catalog"}
          </Button>
        </BlockStack>
      </s-section>

      <ShopifyResetModal
        open={resetOpen}
        onClose={() => {
          setResetOpen(false);
          setResetBusy(false);
        }}
        onStarted={() => setResetBusy(true)}
        onComplete={handleResetComplete}
      />
      {toast && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 700,
            background: "#111827",
            color: "#fff",
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
            minWidth: 260,
          }}
        >
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <span style={{ fontSize: 13 }}>{toast.content}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              style={{
                border: "none",
                background: "transparent",
                color: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
              aria-label="Fechar notificação"
            >
              ×
            </button>
          </InlineStack>
        </div>
      )}
    </s-page>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
