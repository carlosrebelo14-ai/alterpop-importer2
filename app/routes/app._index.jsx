import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import {
  Page,
  Layout,
  Card,
  Text,
  ResourceList,
  ResourceItem,
  Badge,
  Pagination,
  BlockStack,
  InlineStack,
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Modal,
  SkeletonBodyText,
  SkeletonDisplayText,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateAdmin } from "../utils/authenticate.server";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { getCurationLiteStats } from "../../lib/importer/dashboard/getDashboardStats.server.js";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";
import {
  startCatalogCleanupInBackground,
  startCatalogRebuildInBackground,
} from "../../lib/importer/catalog/catalogRebuild.server.js";
import {
  canResumeCatalogRebuild,
  readCatalogRebuildStatus,
} from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { countSmartRuleDecisions } from "../../lib/importer/curation/smartRules.server.js";
import { formatEur } from "../../lib/importer/catalog/categoryLabel.js";
import { translateCategoryLabel } from "../../lib/importer/catalog/categoryLabel.js";
import { FacetedSearchSidebar } from "../components/FacetedSearchSidebar.jsx";
import { ActiveFilterPills } from "../components/ActiveFilterPills.jsx";
import { SyncStagingModal } from "../components/SyncStagingModal.jsx";
import { ShopifyPublishModal } from "../components/ShopifyPublishModal.jsx";
import { CuratorChatWidget } from "../components/CuratorChatWidget.jsx";
import { CatalogProductThumbnail } from "../components/CatalogProductThumbnail.jsx";
import { DashboardPageToolbar } from "../components/DashboardPageToolbar.jsx";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { useImportJobPolling } from "../hooks/useImportJobPolling.js";

const PAGE_SIZE = 50;

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const settings = await loadShopSettings(session.shop);
  const dashboardStats = await getCurationLiteStats(session.shop);
  const indexingActive = isCatalogIndexingRunning(session.shop);
  const catalogRebuildStatus = await readCatalogRebuildStatus(session.shop);
  const catalogCanResume = canResumeCatalogRebuild(catalogRebuildStatus);

  const curationQueue = await loadCurationQueue();
  const decisions = {};
  const smartFlags = {};
  for (const item of curationQueue.items) {
    if (
      item.status === "APPROVED" ||
      item.status === "REJECTED" ||
      item.status === "PUBLISHED" ||
      item.status === "SYNC_ERROR"
    ) {
      decisions[item.sku] = item.status;
    }
    if (item.metadata?.smartRule && item.metadata?.smartAction) {
      smartFlags[item.sku] = item.metadata.smartAction;
    } else if (item.metadata?.aiCuration && item.metadata?.aiAction === "APPROVE") {
      smartFlags[item.sku] = "AI_APPROVE";
    }
  }

  const smartStats = countSmartRuleDecisions(curationQueue.items);

  return {
    shop: session.shop,
    dashboardStats,
    totalRows: dashboardStats.totalIndexed,
    indexingActive,
    catalogRebuildStatus,
    catalogCanResume,
    decisions,
    smartFlags,
    smartStats,
    settings,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "pause-indexing") {
    const { stopCatalogIndexingWorker } = await import("../../lib/importer/catalog/indexingStream.server.js");
    await stopCatalogIndexingWorker(session.shop);
    return { ok: true, rebuilding: false, message: "Indexação pausada com sucesso." };
  }

  if (intent === "refresh-catalog" || intent === "purge-catalog" || intent === "force-reindex-catalog") {
    const settings = await loadShopSettings(session.shop);
    const purge = intent === "purge-catalog";
    const forceFull = intent === "force-reindex-catalog";
    const fileStatus = await readCatalogRebuildStatus(session.shop);
    const willResume =
      !purge && !forceFull && canResumeCatalogRebuild(fileStatus);

    if (purge) {
      startCatalogCleanupInBackground(session.shop, settings);
    } else {
      startCatalogRebuildInBackground(session.shop, settings, {
        resume: willResume,
        forceFull,
      });
    }
    return {
      ok: true,
      rebuilding: true,
      purgeStarted: purge,
      resumed: willResume,
      message: purge
        ? "Limpeza geral + reindexação iniciadas em background. O dashboard mantém-se responsivo."
        : willResume
          ? `A retomar indexação a partir da linha ${Number(fileStatus.checkpointScanned ?? fileStatus.scanned ?? 0).toLocaleString("pt-PT")} do CSV — os produtos já importados mantêm-se.`
          : "Reindexação iniciada em background. O dashboard mantém-se responsivo.",
    };
  }

  return { error: "Unknown intent" };
};

function buildProductsApiUrl({
  page,
  limit,
  brand,
  filterIds,
  search,
  searchScope,
  minPrice,
  maxPrice,
  inStockOnly,
  sortBy,
  sortDir,
  curationStatus,
  reasonFilter,
}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (brand) params.set("brand", brand);
  if (filterIds.length) params.set("filters", filterIds.join(","));
  if (search) params.set("search", search);
  if (search && searchScope && searchScope !== "all") params.set("searchScope", searchScope);
  if (minPrice) params.set("minPrice", minPrice);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (inStockOnly) params.set("inStockOnly", "1");
  if (sortBy) params.set("sortBy", sortBy);
  if (sortDir) params.set("sortDir", sortDir);
  if (curationStatus) params.set("curationStatus", curationStatus);
  if (reasonFilter) params.set("reason", reasonFilter);
  return `/api/products?${params.toString()}`;
}

export default function CurationDashboard() {
  const loaderData = useLoaderData();
  const fetcher = useFetcher();
  const importFetcher = useFetcher();
  const shopify = useAppBridge();

  const settings = loaderData.settings;

  const [facetLicences, setFacetLicences] = useState([]);
  const [facetBrands, setFacetBrands] = useState([]);
  const [facetProductTypes, setFacetProductTypes] = useState([]);
  const [metaLoading, setMetaLoading] = useState(true);

  const [selectedLicenceIds, setSelectedLicenceIds] = useState([]);
  const [selectedProductTypeIds, setSelectedProductTypeIds] = useState([]);
  const [selectedBrand, setSelectedBrand] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [inStockOnly, setInStockOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("");
  const [sortDir, setSortDir] = useState("desc");
  const [curationStatus, setCurationStatus] = useState("");
  const [searchScope, setSearchScope] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("");
  const [savedFilters, setSavedFilters] = useState([]);
  const [decisions, setDecisions] = useState(() => ({ ...loaderData.decisions }));

  useEffect(() => {
    setDecisions({ ...loaderData.decisions });
  }, [loaderData.decisions]);

  const [smartFlags] = useState(() => ({ ...loaderData.smartFlags }));
  const [products, setProducts] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [indexingActive, setIndexingActive] = useState(Boolean(loaderData.indexingActive));
  const [dashboardStats, setDashboardStats] = useState(
    () =>
      loaderData.dashboardStats ?? {
        totalIndexed: 0,
        totalApproved: 0,
        totalRejected: 0,
        totalPending: 0,
      }
  );
  const [catalogCleanupMessage, setCatalogCleanupMessage] = useState(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [streamStats, setStreamStats] = useState({ scanned: 0, indexed: 0 });
  const productsFetchGen = useRef(0);

  const [stagingOpen, setStagingOpen] = useState(false);
  const [stagingSummary, setStagingSummary] = useState(null);
  const [stagingLoading, setStagingLoading] = useState(false);
  const [stagingLiveMode, setStagingLiveMode] = useState(false);
  const [pendingLiveAfterDryRun, setPendingLiveAfterDryRun] = useState(false);
  const [importJobId, setImportJobId] = useState(null);
  const [importJobStatus, setImportJobStatus] = useState(null);
  const [shopifyPublishOpen, setShopifyPublishOpen] = useState(false);
  const [shopifyPublishJobId, setShopifyPublishJobId] = useState(null);
  const [shopifyPublishBusy, setShopifyPublishBusy] = useState(false);
  const [shopifyPublishBanner, setShopifyPublishBanner] = useState(null);
  const [toast, setToast] = useState(null);
  const [selectedSkus, setSelectedSkus] = useState([]);
  const [bulkMargin, setBulkMargin] = useState("1.4");
  const [undoSnapshots, setUndoSnapshots] = useState([]);
  const [massActionConfirm, setMassActionConfirm] = useState(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const debouncedBrand = useDebouncedValue(selectedBrand, 300);
  const combinedFilterIds = useMemo(
    () => [...selectedLicenceIds, ...selectedProductTypeIds],
    [selectedLicenceIds, selectedProductTypeIds]
  );
  const debouncedFiltersKey = useDebouncedValue(
    [...combinedFilterIds].sort().join(","),
    300
  );
  const debouncedFilterIds = useMemo(
    () => (debouncedFiltersKey ? debouncedFiltersKey.split(",").filter(Boolean) : []),
    [debouncedFiltersKey]
  );
  const debouncedMinPrice = useDebouncedValue(minPrice, 300);
  const debouncedMaxPrice = useDebouncedValue(maxPrice, 300);

  const approvedSkus = useMemo(
    () => Object.entries(decisions).filter(([, s]) => s === "APPROVED").map(([sku]) => sku),
    [decisions]
  );
  const selectedCount = selectedSkus.length;

  const refreshDashboardStats = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/stats", { credentials: "same-origin" });
      const data = await res.json();
      if (data?.ok && data.stats) {
        setDashboardStats(data.stats);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const runUndo = useCallback(async () => {
    if (!undoSnapshots.length) return;
    try {
      const res = await fetch("/api/curation/queue/undo", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshots: undoSnapshots }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setToast({ content: data?.error || "Não foi possível desfazer ação", error: true });
        return;
      }
      setToast({ content: "Ação desfeita com sucesso" });
      setUndoSnapshots([]);
      setListRefreshKey((k) => k + 1);
      refreshDashboardStats();
    } catch {
      setToast({ content: "Falha de rede ao desfazer", error: true });
    }
  }, [undoSnapshots, refreshDashboardStats]);

  useEffect(() => {
    let cancelled = false;

    async function pollCatalog() {
      try {
        // Fetch leve de status
        const statusRes = await fetch("/api/catalog/status", { credentials: "same-origin" });
        const status = await statusRes.json();
        if (cancelled) return;

        setIndexingActive(Boolean(status?.rebuilding));
        if (status?.message && !status?.rebuilding) {
          setCatalogCleanupMessage(status.message);
        }

        // Se NÃO estiver a indexar, atualizamos as stats.
        // Se estiver a indexar, o SSE trata das stats, evitamos sobrecarga.
        // Endpoint super-leve (sem ler a fila de curadoria) — este poll corre a
        // cada 5-15s, por isso faz merge só de totalIndexed/totalSyncError em vez
        // de substituir o estado inteiro (Aprovados/Rejeitados/Pendentes só mudam
        // via refreshDashboardStats, chamado explicitamente após uma ação).
        if (!status?.rebuilding) {
          const statsRes = await fetch("/api/dashboard/poll-stats", { credentials: "same-origin" });
          const statsPayload = await statsRes.json();
          if (!cancelled && statsPayload?.ok && statsPayload.stats) {
            setDashboardStats((prev) => ({
              ...prev,
              totalIndexed: statsPayload.stats.totalIndexed,
              totalSyncError: statsPayload.stats.totalSyncError,
            }));
          }
        }
      } catch {
        /* ignore */
      }
    }

    pollCatalog();
    // During indexing: poll every 15s (SSE provides real-time updates).
    // When idle: poll every 5s for status changes.
    const interval = indexingActive ? 15000 : 5000;
    const timer = setInterval(pollCatalog, interval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetcher.data?.rebuilding, indexingActive]);

  const handleIndexingComplete = useCallback(() => {
    refreshDashboardStats();
    setPage(1);
    setListRefreshKey((k) => k + 1);
  }, [refreshDashboardStats]);

  const wasIndexing = useRef(indexingActive);
  useEffect(() => {
    if (wasIndexing.current && !indexingActive) {
      handleIndexingComplete();
    }
    wasIndexing.current = indexingActive;
  }, [indexingActive, handleIndexingComplete]);

  useEffect(() => {
    if (fetcher.data?.rebuilding) {
      setIndexingActive(true);
    }
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (!indexingActive) return;

    const shopParam = loaderData?.shop ? `?shop=${encodeURIComponent(loaderData.shop)}` : "";
    const es = new EventSource(`/api/indexing-stream${shopParam}`, { withCredentials: true });
    
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "progress" || data.type === "status" || data.type === "done") {
          const currentScanned = data.scanned ?? data.totalLinesRead ?? data.checkpointScanned ?? 0;
          const currentIndexed = data.indexed ?? data.totalImported ?? data.checkpointIndexed ?? data.totalRows ?? 0;
          
          if (currentIndexed > 0 || currentScanned > 0) {
            setStreamStats({ scanned: currentScanned, indexed: currentIndexed });
            setDashboardStats(prev => ({
              ...prev,
              totalIndexed: currentIndexed
            }));
          }
          
          if (data.state === "completed" || data.type === "done") {
            setIndexingActive(false);
          }
        }
      } catch (err) {
        // ignore
      }
    };

    return () => {
      es.close();
    };
  }, [indexingActive, loaderData?.shop]);

  useEffect(() => {
    let cancelled = false;

    async function loadMeta() {
      setMetaLoading(true);
      try {
        const facetsRes = await fetch("/api/catalog/facets", { credentials: "same-origin" });
        const facets = await facetsRes.json();
        if (cancelled) return;
        if (facets?.ok) {
          setFacetLicences(facets.licences || []);
          setFacetBrands(facets.brands || []);
          setFacetProductTypes(facets.productTypes || []);
        }
        console.log("[debug:curation] Facets loaded", {
          licences: facets?.licences?.length ?? 0,
          brands: facets?.brands?.length ?? 0,
          productTypes: facets?.productTypes?.length ?? 0,
        });
      } catch (err) {
        console.error("[debug:curation] UI meta failed", err?.message || err);
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    }

    loadMeta();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSavedFilters = useCallback(async () => {
    try {
      const res = await fetch("/api/saved-filters", { credentials: "same-origin" });
      const data = await res.json();
      if (data?.ok) setSavedFilters(data.filters || []);
    } catch (err) {
      console.error("[debug:curation] loadSavedFilters failed", err?.message || err);
    }
  }, []);

  useEffect(() => {
    loadSavedFilters();
  }, [loadSavedFilters]);

  const handleApplySavedFilter = useCallback(
    (id) => {
      const found = savedFilters.find((f) => f.id === id);
      if (!found) return;
      const f = found.filters || {};
      setSelectedLicenceIds(f.licenceIds || []);
      setSelectedProductTypeIds(f.productTypeIds || []);
      setSelectedBrand(f.brand || null);
      setSearchQuery(f.search || "");
      setSearchScope(f.searchScope || "all");
      setMinPrice(f.minPrice || "");
      setMaxPrice(f.maxPrice || "");
      setInStockOnly(Boolean(f.inStockOnly));
      setCurationStatus(f.curationStatus || "");
      setReasonFilter(f.reason || "");
      setPage(1);
      shopify.toast.show(`Filtro "${found.name}" aplicado`);
    },
    [savedFilters, shopify]
  );

  const handleSaveCurrentFilter = useCallback(
    async (name) => {
      if (!name) return;
      const filters = {
        search: debouncedSearch,
        searchScope,
        licenceIds: selectedLicenceIds,
        productTypeIds: selectedProductTypeIds,
        brand: selectedBrand,
        minPrice,
        maxPrice,
        inStockOnly,
        curationStatus,
        reason: reasonFilter,
      };
      const form = new FormData();
      form.set("intent", "create");
      form.set("name", name);
      form.set("filters", JSON.stringify(filters));
      try {
        const res = await fetch("/api/saved-filters", {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        const data = await res.json();
        if (data?.ok) {
          shopify.toast.show(`Filtro "${name}" guardado`);
          loadSavedFilters();
        } else {
          shopify.toast.show(data?.error || "Erro ao guardar filtro", { isError: true });
        }
      } catch (err) {
        console.error("[debug:curation] saveCurrentFilter failed", err?.message || err);
        shopify.toast.show("Erro ao guardar filtro", { isError: true });
      }
    },
    [
      debouncedSearch,
      searchScope,
      selectedLicenceIds,
      selectedProductTypeIds,
      selectedBrand,
      minPrice,
      maxPrice,
      inStockOnly,
      curationStatus,
      reasonFilter,
      shopify,
      loadSavedFilters,
    ]
  );

  const handleDeleteSavedFilter = useCallback(
    async (id) => {
      const form = new FormData();
      form.set("intent", "delete");
      form.set("id", id);
      try {
        await fetch("/api/saved-filters", { method: "POST", body: form, credentials: "same-origin" });
        setSavedFilters((prev) => prev.filter((f) => f.id !== id));
      } catch (err) {
        console.error("[debug:curation] deleteSavedFilter failed", err?.message || err);
      }
    },
    []
  );

  useEffect(() => {
    if (dashboardStats.totalIndexed === 0 && !indexingActive) {
      setListLoading(false);
      setProducts([]);
      return;
    }

    const ac = new AbortController();
    const gen = ++productsFetchGen.current;

    async function loadPage() {
      setListLoading(true);
      const url = buildProductsApiUrl({
        page,
        limit: PAGE_SIZE,
        brand: debouncedBrand,
        filterIds: debouncedFilterIds,
        search: debouncedSearch,
        searchScope,
        minPrice: debouncedMinPrice,
        maxPrice: debouncedMaxPrice,
        inStockOnly,
        sortBy,
        sortDir,
        curationStatus,
        reasonFilter,
      });

      console.log("[debug:curation] fetch →", url, {
        page,
        filterIds: debouncedFilterIds,
        brand: debouncedBrand,
        search: debouncedSearch,
      });

      try {
        const res = await fetch(url, { credentials: "same-origin", signal: ac.signal });
        let data;
        try {
          data = await res.json();
        } catch (parseErr) {
          console.log("[debug:curation] response (parse failed)", {
            status: res.status,
            statusText: res.statusText,
          });
          throw parseErr;
        }

        console.log("[debug:curation] response", {
          status: res.status,
          ok: res.ok,
          data,
        });

        if (gen !== productsFetchGen.current) return;

        if (!res.ok || !data?.ok) {
          shopify.toast.show(data?.error || `API erro ${res.status}`, { isError: true });
          setProducts([]);
          return;
        }

        setProducts(data.products || []);
        setTotalCount(data.totalCount ?? 0);
        setTotalPages(data.totalPages ?? 1);
      } catch (err) {
        if (gen !== productsFetchGen.current) return;
        if (err?.name !== "AbortError") {
          console.error("[debug:curation] fetch failed", err);
          shopify.toast.show("Erro ao carregar produtos", { isError: true });
        }
      } finally {
        if (gen === productsFetchGen.current) {
          setListLoading(false);
        }
      }
    }

    loadPage();
    return () => ac.abort();
  }, [
    page,
    debouncedSearch,
    searchScope,
    debouncedBrand,
    debouncedFilterIds,
    debouncedMinPrice,
    debouncedMaxPrice,
    inStockOnly,
    sortBy,
    sortDir,
    curationStatus,
    reasonFilter,
    dashboardStats.totalIndexed,
    indexingActive,
    listRefreshKey,
    shopify,
  ]);

  const handleLicenceIdsChange = useCallback((ids) => {
    setSelectedLicenceIds(ids);
    setPage(1);
  }, []);

  const handleProductTypeIdsChange = useCallback((ids) => {
    setSelectedProductTypeIds(ids);
    setPage(1);
  }, []);

  const activeFilterPills = useMemo(() => {
    /** @type {{ id: string, label: string, onRemove: () => void }[]} */
    const pills = [];

    for (const id of selectedLicenceIds) {
      const lic = facetLicences.find((l) => l.id === id);
      pills.push({
        id: `lic-${id}`,
        label: lic?.label || id,
        onRemove: () =>
          setSelectedLicenceIds((prev) => prev.filter((x) => x !== id)),
      });
    }

    for (const id of selectedProductTypeIds) {
      const pt = facetProductTypes.find((p) => p.id === id);
      pills.push({
        id: `pt-${id}`,
        label: pt?.label || id,
        onRemove: () =>
          setSelectedProductTypeIds((prev) => prev.filter((x) => x !== id)),
      });
    }

    if (selectedBrand) {
      const brand = facetBrands.find((b) => b.id === selectedBrand);
      pills.push({
        id: `brand-${selectedBrand}`,
        label: brand?.label || selectedBrand,
        onRemove: () => setSelectedBrand(null),
      });
    }

    if (minPrice) {
      pills.push({
        id: "min-price",
        label: `Min: ${formatEur(Number(minPrice))}`,
        onRemove: () => setMinPrice(""),
      });
    }
    if (maxPrice) {
      pills.push({
        id: "max-price",
        label: `Max: ${formatEur(Number(maxPrice))}`,
        onRemove: () => setMaxPrice(""),
      });
    }

    if (inStockOnly) {
      pills.push({
        id: "in-stock",
        label: "Em stock",
        onRemove: () => setInStockOnly(false),
      });
    }

    if (debouncedSearch) {
      const scopeLabel =
        searchScope === "title" ? " (título)" :
        searchScope === "sku" ? " (SKU)" :
        searchScope === "barcode" ? " (EAN)" :
        searchScope === "vendor" ? " (marca)" : "";
      pills.push({
        id: "search",
        label: `Search: ${debouncedSearch}${scopeLabel}`,
        onRemove: () => setSearchQuery(""),
      });
    }

    if (reasonFilter) {
      pills.push({
        id: "reason",
        label: `Motivo: ${reasonFilter}`,
        onRemove: () => setReasonFilter(""),
      });
    }

    return pills;
  }, [
    selectedLicenceIds,
    selectedProductTypeIds,
    selectedBrand,
    minPrice,
    maxPrice,
    inStockOnly,
    debouncedSearch,
    searchScope,
    reasonFilter,
    facetLicences,
    facetBrands,
    facetProductTypes,
  ]);

  const activeFilterSummary = useMemo(
    () =>
      activeFilterPills.length > 0
        ? activeFilterPills.map((p) => p.label).join(" · ")
        : "Sem filtros activos — isto aplica-se a TODO o catálogo indexado",
    [activeFilterPills]
  );

  const clearAllFilters = useCallback(() => {
    setSelectedLicenceIds([]);
    setSelectedProductTypeIds([]);
    setSelectedBrand(null);
    setMinPrice("");
    setMaxPrice("");
    setInStockOnly(false);
    setSearchQuery("");
    setSearchScope("all");
    setCurationStatus("");
    setReasonFilter("");
    setPage(1);
  }, []);

  const handleApplyCatalogFiltersFromChat = useCallback(
    (filters) => {
      if (!filters) return;
      setSelectedLicenceIds(filters.licenceIds || []);
      setSelectedProductTypeIds(filters.productTypeIds || []);
      setSelectedBrand(filters.brand || null);
      setSearchQuery(filters.search || "");
      setMinPrice(filters.minPrice || "");
      setMaxPrice(filters.maxPrice || "");
      setInStockOnly(Boolean(filters.inStockOnly));
      setPage(1);
      shopify.toast.show("Catalog filters updated from chat");
    },
    [shopify]
  );

  const handleBrandChange = useCallback((brand) => {
    setSelectedBrand(brand);
    setPage(1);
  }, []);

  const handleSearchChange = useCallback((q) => {
    setSearchQuery(q);
    setPage(1);
  }, []);

  const handleSearchScopeChange = useCallback((scope) => {
    setSearchScope(scope);
    setPage(1);
  }, []);

  const handleReasonFilterChange = useCallback((reason) => {
    setReasonFilter(reason);
    setPage(1);
  }, []);

  const handleMinPriceChange = useCallback((v) => {
    setMinPrice(v);
    setPage(1);
  }, []);

  const handleMaxPriceChange = useCallback((v) => {
    setMaxPrice(v);
    setPage(1);
  }, []);

  const handleInStockOnlyChange = useCallback((v) => {
    setInStockOnly(v);
    setPage(1);
  }, []);

  const toggleSelectSku = useCallback((sku, checked) => {
    setSelectedSkus((prev) => {
      if (checked) return [...new Set([...prev, sku])];
      return prev.filter((s) => s !== sku);
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedSkus([]), []);

  const runBulkStatus = useCallback(
    async (actionName) => {
      if (!selectedSkus.length) return;
      const skusSnapshot = [...selectedSkus];
      try {
        const res = await fetch("/api/curation/queue/bulk", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skus: selectedSkus, action: actionName }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
          setToast({ content: data?.error || "Erro em ação em massa", error: true });
          return;
        }
        if (Array.isArray(data.previousSnapshots) && data.previousSnapshots.length) {
          setUndoSnapshots(data.previousSnapshots);
        }
        setDecisions((prev) => {
          const next = { ...prev };
          for (const sku of skusSnapshot) {
            next[sku] = actionName === "approve" ? "APPROVED" : "REJECTED";
          }
          return next;
        });
        setToast({
          content:
            actionName === "approve"
              ? `${data.updated} produto(s) aprovados. Undo disponível.`
              : `${data.updated} produto(s) rejeitados. Undo disponível.`,
        });
        clearSelection();
        setListRefreshKey((k) => k + 1);
        refreshDashboardStats();
      } catch {
        setToast({ content: "Falha de rede na ação em massa", error: true });
      }
    },
    [selectedSkus, clearSelection, refreshDashboardStats]
  );

  const runBulkApproveFiltered = useCallback(
    async (action = "approve_filtered") => {
      try {
        const res = await fetch("/api/curation/queue/bulk", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            filters: {
              brand: debouncedBrand,
              search: debouncedSearch,
              minPrice: debouncedMinPrice,
              maxPrice: debouncedMaxPrice,
              inStockOnly,
              filterIds: debouncedFilterIds,
            },
          }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
          setToast({ content: data?.error || "Erro na ação em massa", error: true });
          return;
        }
        setToast({
          content: `${data.updated} produtos da pesquisa ${action.startsWith("approve") ? "aprovados" : "rejeitados"}!`,
        });
        clearSelection();
        setListRefreshKey((k) => k + 1);
        refreshDashboardStats();
      } catch {
        setToast({ content: "Falha de rede ao processar pesquisa em massa", error: true });
      }
    },
    [
      debouncedBrand,
      debouncedSearch,
      debouncedMinPrice,
      debouncedMaxPrice,
      inStockOnly,
      debouncedFilterIds,
      clearSelection,
      refreshDashboardStats,
    ]
  );

  const confirmMassAction = useCallback(async () => {
    if (!massActionConfirm) return;
    const action = massActionConfirm.action;
    setMassActionConfirm(null);
    await runBulkApproveFiltered(action);
  }, [massActionConfirm, runBulkApproveFiltered]);

  const runBulkMargin = useCallback(async () => {
    if (!selectedSkus.length) return;
    const multiplier = Number(bulkMargin);
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      setToast({ content: "Margem inválida (mínimo 1.0)", error: true });
      return;
    }
    try {
      const res = await fetch("/api/curation/queue/bulk", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skus: selectedSkus,
          action: "margin",
          marginMultiplier: multiplier,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setToast({ content: data?.error || "Erro ao alterar margem", error: true });
        return;
      }
      setToast({ content: `Margem ${data.marginMultiplier} aplicada a ${data.updated} produto(s)` });
      clearSelection();
      setListRefreshKey((k) => k + 1);
    } catch {
      setToast({ content: "Falha de rede ao alterar margem", error: true });
    }
  }, [selectedSkus, bulkMargin, clearSelection]);

  const postCuration = useCallback(
    async (sku, action) => {
      const path =
        action === "approve"
          ? `/api/curation/queue/${encodeURIComponent(sku)}/approve`
          : `/api/curation/queue/${encodeURIComponent(sku)}/reject`;

      try {
        const res = await fetch(path, { method: "POST" });
        const data = await res.json();
        if (!data?.ok) {
          shopify.toast.show(data?.error || "Erro na curadoria", { isError: true });
          return;
        }
        setDecisions((prev) => ({
          ...prev,
          [sku]: action === "approve" ? "APPROVED" : "REJECTED",
        }));
        if (data.previousSnapshot) {
          setUndoSnapshots([data.previousSnapshot]);
        }
        setToast({
          content:
            action === "approve"
              ? "Product approved. Undo disponível."
              : "Product rejected. Undo disponível.",
          error: action !== "approve",
        });
        shopify.toast.show(action === "approve" ? "Aprovado" : "Rejeitado");
      } catch {
        shopify.toast.show("Falha de rede ao guardar curadoria", { isError: true });
      }
    },
    [shopify]
  );

  const openStagingModal = useCallback(async (liveMode = false) => {
    if (approvedSkus.length === 0) {
      shopify.toast.show("Nenhum SKU aprovado para sincronizar", { isError: true });
      return;
    }
    setStagingLiveMode(liveMode);
    setStagingOpen(true);
    setStagingLoading(true);
    setStagingSummary(null);
    try {
      const params = new URLSearchParams({ skus: approvedSkus.join(",") });
      const res = await fetch(`/api/curation/sync-preview?${params}`, {
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data?.ok) setStagingSummary(data.summary);
      else shopify.toast.show(data?.error || "Erro no resumo", { isError: true });
    } catch {
      shopify.toast.show("Falha ao carregar resumo", { isError: true });
    } finally {
      setStagingLoading(false);
    }
  }, [approvedSkus, shopify]);

  const startSyncJob = useCallback(
    (liveMode) => {
      const fd = new FormData();
      fd.set("intent", liveMode ? "import" : "dry-run");
      fd.set("skuAllowlist", approvedSkus.join(","));
      fd.set("syncLimit", String(approvedSkus.length));
      fd.set("productsOnly", "on");
      fd.set("syncPrices", "on");
      fd.set("syncImages", "on");
      if (settings?.autoGlossaryTranslation !== false) {
        fd.set("autoGlossaryTranslation", "on");
      }
      if (inStockOnly || settings?.importInStockOnly) {
        fd.set("inStockOnly", "on");
      }
      importFetcher.submit(fd, { method: "post", action: "/api/import/start" });
    },
    [approvedSkus, importFetcher, settings, inStockOnly]
  );

  const confirmStagingSync = useCallback(
    async (customTags = []) => {
      setStagingOpen(false);
      if (stagingLiveMode) {
        setShopifyPublishBusy(true);
        try {
          const res = await fetch("/api/shopify-sync", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customTags,
              skus: selectedSkus.length > 0 ? selectedSkus : approvedSkus,
            }),
          });
          const data = await res.json();
          if (data?.ok) {
            setShopifyPublishJobId(data.jobId || "current");
            setShopifyPublishOpen(true);
            shopify.toast.show(`Publicação Shopify iniciada (${approvedSkus.length} produtos)`);
          } else {
            shopify.toast.show(data?.error || "Erro ao publicar", { isError: true });
          }
        } catch {
          shopify.toast.show("Falha de rede ao iniciar publicação", { isError: true });
        } finally {
          setShopifyPublishBusy(false);
        }
      } else {
        startSyncJob(false);
        shopify.toast.show(`Simulação iniciada (${approvedSkus.length} SKUs)`);
      }
    },
    [stagingLiveMode, startSyncJob, approvedSkus.length, shopify]
  );

  useEffect(() => {
    if (importFetcher.data?.jobId) {
      setImportJobId(importFetcher.data.jobId);
    }
  }, [importFetcher.data]);

  useImportJobPolling({
    jobId: importJobId,
    jobStatus: importJobStatus,
    setJobStatus: setImportJobStatus,
    onTerminal: (status) => {
      if (status.state === "completed" && status.dryRun && pendingLiveAfterDryRun) {
        setPendingLiveAfterDryRun(false);
        openStagingModal(true);
      }
      if (status.state === "completed") {
        fetch(buildProductsApiUrl({
          page,
          limit: PAGE_SIZE,
          brand: debouncedBrand,
          filterIds: debouncedFilterIds,
          search: debouncedSearch,
          searchScope,
          minPrice: debouncedMinPrice,
          maxPrice: debouncedMaxPrice,
          inStockOnly,
          sortBy,
          sortDir,
          curationStatus,
          reasonFilter,
        }), { credentials: "same-origin" })
          .then((r) => r.json())
          .then((data) => {
            if (data?.ok) {
              setProducts(data.products || []);
            }
          })
          .catch(() => {});
      }
    },
  });

  const retryFailedJob = useCallback(
    (jobId) => {
      const fd = new FormData();
      fd.set("jobId", jobId);
      fd.set("intent", "import");
      fd.set("productsOnly", "on");
      importFetcher.submit(fd, { method: "post", action: "/api/import/retry-failed" });
      shopify.toast.show("Retry de falhas enfileirado");
    },
    [importFetcher, shopify]
  );

  const handleSyncClick = useCallback(() => {
    setPendingLiveAfterDryRun(true);
    openStagingModal(false);
  }, [openStagingModal]);

  const handlePublishShopify = useCallback(async () => {
    if (approvedSkus.length === 0) {
      shopify.toast.show("Nenhum produto aprovado para publicar", { isError: true });
      return;
    }

    setShopifyPublishBusy(true);
    setShopifyPublishBanner(null);

    try {
      const res = await fetch("/api/shopify-sync", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await res.json();

      if (!res.ok || !data?.ok) {
        shopify.toast.show(data?.error || "Não foi possível iniciar a publicação", {
          isError: true,
          duration: 8000,
        });
        if (data?.authError) {
          setShopifyPublishBanner(
            `${data.error} Abre a app pelo menu Apps no Admin Shopify.`
          );
        }
        return;
      }

      setShopifyPublishJobId(data.jobId || data.status?.jobId);
      setShopifyPublishOpen(true);
      shopify.toast.show(data.message || "Publicação Shopify iniciada");
    } catch {
      shopify.toast.show("Falha de rede ao iniciar publicação", { isError: true });
    } finally {
      setShopifyPublishBusy(false);
    }
  }, [approvedSkus.length, shopify]);

  const handleShopifyPublishComplete = useCallback(
    (status) => {
      const published = status?.published ?? 0;
      const failed = status?.failed ?? 0;
      setShopifyPublishBanner(
        `Sincronização concluída: ${published} produto(s) publicado(s) com sucesso, ${failed} falha(s).`
      );
      setDecisions((prev) => {
        const next = { ...prev };
        for (const sku of Object.keys(next)) {
          if (next[sku] === "APPROVED") {
            /* mantém até revalidar — loader actualiza PUBLISHED/SYNC_ERROR */
          }
        }
        return next;
      });
      refreshDashboardStats();
      setListRefreshKey((k) => k + 1);
    },
    [refreshDashboardStats]
  );

  const refreshStarting =
    fetcher.state !== "idle" &&
    (fetcher.formData?.get("intent") === "refresh-catalog" ||
      fetcher.formData?.get("intent") === "force-reindex-catalog");

  const syncBusy =
    importFetcher.state !== "idle" && importFetcher.formMethod === "POST";

  const safePage = Math.min(page, totalPages);

  const handleRefreshCatalog = useCallback(() => {
    fetcher.submit({ intent: "force-reindex-catalog" }, { method: "post" });
  }, [fetcher]);

  const handlePauseIndexing = useCallback(() => {
    fetcher.submit({ intent: "pause-indexing" }, { method: "post" });
    setIndexingActive(false);
  }, [fetcher]);

  return (
    <>
    <div className="alterpop-dashboard">
    <Page
      fullWidth
      title="Alterpop — Painel de Curadoria"
      subtitle={`${dashboardStats.totalIndexed.toLocaleString("pt-PT")} produtos na base de dados (SQLite)`}
    >
      <BlockStack gap="400">
        <DashboardPageToolbar
          onRefreshCatalog={handleRefreshCatalog}
          refreshStarting={refreshStarting}
          indexingActive={indexingActive}
          onSyncApproved={handleSyncClick}
          syncBusy={syncBusy}
          approvedCount={approvedSkus.length}
          onPublishShopify={handlePublishShopify}
          shopifyPublishBusy={shopifyPublishBusy}
        />

        {(dashboardStats.totalSyncError || 0) > 0 && (
          <Banner tone="warning" action={{ content: "Ver Logs de Erro", url: "/app/reports" }}>
            {`${dashboardStats.totalSyncError} produto(s) com erro de sincronização pendente.`}
          </Banner>
        )}

        {shopifyPublishBanner && (
          <Banner
            tone={shopifyPublishBanner.includes("0 falha") ? "success" : "warning"}
            onDismiss={() => setShopifyPublishBanner(null)}
          >
            {shopifyPublishBanner}
          </Banner>
        )}

        <Banner tone="info">
          {`Filtro actual: ${listLoading ? "…" : (totalCount ?? 0).toLocaleString("pt-PT")} produtos mostrados | Aprovados (total): ${(dashboardStats?.totalApproved ?? 0).toLocaleString("pt-PT")} | Rejeitados (total): ${(dashboardStats?.totalRejected ?? 0).toLocaleString("pt-PT")} | Pendentes: ${(dashboardStats?.totalPending ?? 0).toLocaleString("pt-PT")}`}
        </Banner>

        {indexingActive && (
          <Banner tone="info">
            <strong>Indexação em curso...</strong> {streamStats.indexed.toLocaleString("pt-PT")} produtos indexados de {streamStats.scanned.toLocaleString("pt-PT")} linhas lidas.
            A processar em background (demora 1-3 min). O painel continua utilizável.
          </Banner>
        )}

        {!indexingActive && dashboardStats.totalIndexed === 0 && (
          <Banner tone="info">
            Catálogo ainda não indexado. Clique em <strong>Actualizar catálogo</strong> e aguarde
            1–3 minutos (corre em background).
          </Banner>
        )}

        {!indexingActive && loaderData.catalogCanResume && (
          <Banner
            tone="warning"
            action={{
              content: "Retomar indexação",
              onAction: () => fetcher.submit({ intent: "refresh-catalog" }, { method: "post" }),
            }}
            secondaryAction={{
              content: "Recomeçar do zero",
              onAction: () =>
                fetcher.submit({ intent: "force-reindex-catalog" }, { method: "post" }),
            }}
          >
            {`Indexação interrompida (${(loaderData.catalogRebuildStatus?.checkpointIndexed ?? loaderData.catalogRebuildStatus?.totalRows ?? 0).toLocaleString("pt-PT")} produtos na base). Clica «Retomar» para continuar a partir da linha ${Number(loaderData.catalogRebuildStatus?.checkpointScanned ?? loaderData.catalogRebuildStatus?.scanned ?? 0).toLocaleString("pt-PT")} do CSV — sem apagar o que já foi importado.`}
          </Banner>
        )}

        {fetcher.data?.rebuilding && (
          <Banner tone="success">{fetcher.data.message}</Banner>
        )}

        {catalogCleanupMessage && !indexingActive && (
          <Banner tone="success">{catalogCleanupMessage}</Banner>
        )}

        {importJobId && importJobStatus && (
          <Banner
            tone={
              importJobStatus.state === "failed"
                ? "critical"
                : importJobStatus.state === "completed"
                  ? "success"
                  : "info"
            }
          >
            {importJobStatus.state === "running"
              ? `Sincronização: ${Math.round(importJobStatus.progressPercent || 0)}% · ${importJobStatus.processedRows ?? 0}/${importJobStatus.totalRows ?? "?"} · ${importJobStatus.currentSku || "—"}`
              : importJobStatus.state === "completed"
                ? `Job concluído: ${importJobId} · ${importJobStatus.summary?.metrics?.failed ?? 0} falha(s) · lotes: ${importJobStatus.summary?.metrics?.batchesCompleted ?? 0}`
                : importJobStatus.state === "failed"
                  ? `Job falhou: ${importJobStatus.error || importJobId}`
                  : `Job ${importJobId}: ${importJobStatus.state}`}
            {importJobStatus.state === "completed" &&
              (importJobStatus.summary?.metrics?.failed > 0 ||
                importJobStatus.summary?.metrics?.batchesPendingRetry > 0) && (
                <div style={{ marginTop: 8 }}>
                  <Button size="slim" onClick={() => retryFailedJob(importJobId)}>
                    Retry SKUs com falha
                  </Button>
                </div>
              )}
          </Banner>
        )}

        {importFetcher.data?.jobId && !importJobId && (
          <Banner tone="success">
            {`Import em fila: ${importFetcher.data.jobId} (${importFetcher.data.state || "queued"})`}
          </Banner>
        )}

        <SyncStagingModal
          open={stagingOpen}
          onClose={() => setStagingOpen(false)}
          onConfirm={confirmStagingSync}
          loading={stagingLoading}
          confirming={syncBusy}
          summary={stagingSummary}
          liveMode={stagingLiveMode}
        />

        {massActionConfirm && (
          <Modal
            open
            onClose={() => setMassActionConfirm(null)}
            title={
              massActionConfirm.action === "approve_filtered"
                ? `Aprovar ${totalCount.toLocaleString("pt-PT")} produto(s)?`
                : `Rejeitar ${totalCount.toLocaleString("pt-PT")} produto(s)?`
            }
            primaryAction={{
              content:
                massActionConfirm.action === "approve_filtered"
                  ? `Aprovar ${totalCount.toLocaleString("pt-PT")}`
                  : `Rejeitar ${totalCount.toLocaleString("pt-PT")}`,
              destructive: massActionConfirm.action === "reject_filtered",
              onAction: confirmMassAction,
            }}
            secondaryActions={[{ content: "Cancelar", onAction: () => setMassActionConfirm(null) }]}
          >
            <Modal.Section>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  Esta ação aplica-se a <strong>{totalCount.toLocaleString("pt-PT")} produto(s)</strong>,
                  não só à página atual.
                </Text>
                <Text as="p" tone="subdued">
                  Filtro activo: {activeFilterSummary}
                </Text>
              </BlockStack>
            </Modal.Section>
          </Modal>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            {metaLoading ? (
              <Card>
                <BlockStack gap="200">
                  <SkeletonDisplayText size="small" />
                  <SkeletonBodyText lines={6} />
                </BlockStack>
              </Card>
            ) : (
              <FacetedSearchSidebar
                licences={facetLicences}
                brands={facetBrands}
                productTypes={facetProductTypes}
                selectedLicenceIds={selectedLicenceIds}
                onLicenceIdsChange={handleLicenceIdsChange}
                selectedProductTypeIds={selectedProductTypeIds}
                onProductTypeIdsChange={handleProductTypeIdsChange}
                selectedBrand={selectedBrand}
                onBrandChange={handleBrandChange}
                minPrice={minPrice}
                maxPrice={maxPrice}
                onMinPriceChange={handleMinPriceChange}
                onMaxPriceChange={handleMaxPriceChange}
                inStockOnly={inStockOnly}
                onInStockOnlyChange={handleInStockOnlyChange}
                searchQuery={searchQuery}
                onSearchChange={handleSearchChange}
                searchScope={searchScope}
                onSearchScopeChange={handleSearchScopeChange}
                curationStatus={curationStatus}
                onCurationStatusChange={(v) => { setCurationStatus(v); setPage(1); }}
                reasonFilter={reasonFilter}
                onReasonFilterChange={handleReasonFilterChange}
                savedFilters={savedFilters}
                onApplySavedFilter={handleApplySavedFilter}
                onDeleteSavedFilter={handleDeleteSavedFilter}
                onSaveCurrentFilter={handleSaveCurrentFilter}
              />
            )}
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Resultados
                    </Text>
                    {totalCount > 0 && (
                      <Button
                        size="slim"
                        tone="success"
                        onClick={() => setMassActionConfirm({ action: "approve_filtered" })}
                      >
                        {`Aprovar Toda a Pesquisa (${totalCount.toLocaleString("pt-PT")})`}
                      </Button>
                    )}
                    {totalCount > 0 && (
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={() => setMassActionConfirm({ action: "reject_filtered" })}
                      >
                        {`Rejeitar Toda a Pesquisa (${totalCount.toLocaleString("pt-PT")})`}
                      </Button>
                    )}
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center">
                    <select
                      value={sortBy ? `${sortBy}_${sortDir}` : ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!val) { setSortBy(""); setSortDir("desc"); }
                        else {
                          const [field, dir] = val.split("_");
                          setSortBy(field);
                          setSortDir(dir);
                        }
                        setPage(1);
                      }}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--p-color-border-secondary, #ccc)",
                        fontSize: 13,
                        background: "var(--p-color-bg-surface, #fff)",
                        cursor: "pointer",
                      }}
                    >
                      <option value="">Ordenar por…</option>
                      <option value="margin_desc">Margem % ↓ (maior → menor)</option>
                      <option value="margin_asc">Margem % ↑ (menor → maior)</option>
                      <option value="netPrice_asc">Preço ↑ (barato → caro)</option>
                      <option value="netPrice_desc">Preço ↓ (caro → barato)</option>
                      <option value="stock_desc">Stock ↓ (mais stock)</option>
                      <option value="title_asc">Título A → Z</option>
                      <option value="title_desc">Título Z → A</option>
                    </select>
                    <Text as="p" tone="subdued">
                      {listLoading
                        ? "A carregar…"
                        : `Pág. ${safePage}/${totalPages} · ${PAGE_SIZE}/pág.`}
                    </Text>
                  </InlineStack>
                </InlineStack>

                {dashboardStats.totalIndexed === 0 && !indexingActive ? (
                  <EmptyState
                    heading="Bem-vindo! Ainda não há catálogo indexado"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    action={{
                      content: "Configurar CSV URL",
                      onAction: () => {
                        window.location.href = "/app/settings";
                      },
                    }}
                  >
                    <p>
                      Começa por configurar o URL do CSV da OcioStock em Definições.
                    </p>
                  </EmptyState>
                ) : listLoading && products.length === 0 ? (
                  <BlockStack gap="300">
                    <SkeletonDisplayText size="small" />
                    <SkeletonBodyText lines={8} />
                  </BlockStack>
                ) : (
                  <>
                    <ActiveFilterPills
                      pills={activeFilterPills}
                      onClearAll={clearAllFilters}
                    />
                    <ResourceList
                      resourceName={{ singular: "produto", plural: "produtos" }}
                      items={products}
                      emptyState={
                        <EmptyState
                          heading="Sem produtos para este filtro"
                          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                          action={{ content: "Limpar filtros", onAction: clearAllFilters }}
                        >
                          <p>Experimenta remover ou ajustar alguns dos filtros activos.</p>
                        </EmptyState>
                      }
                      renderItem={(item) => {
                        const {
                          sku,
                          title,
                          imageUrl,
                          categoryMain,
                          vendor,
                          stock,
                          netPrice,
                          grossPrice,
                          targetRetailPrice,
                          syncError,
                          salesUnits30d,
                          barcode,
                          franchises,
                        } = item;
                        const status = decisions[sku];
                        const smartAction = smartFlags[sku];
                        const categoryLabel = translateCategoryLabel(categoryMain);
                        const marginPct = grossPrice && netPrice && grossPrice > 0
                          ? Math.round(((grossPrice - netPrice) / grossPrice) * 100)
                          : null;
                        const franchiseList = (() => {
                          try {
                            const parsed = typeof franchises === "string" ? JSON.parse(franchises) : franchises;
                            return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 3) : [];
                          } catch { return []; }
                        })();

                        return (
                          <ResourceItem
                            id={sku}
                            accessibilityLabel={`${title} (${sku})`}
                            media={
                              <CatalogProductThumbnail
                                imageUrl={imageUrl}
                                title={title}
                                size={120}
                              />
                            }
                            verticalAlignment="center"
                          >
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="start">
                                <BlockStack gap="100">
                                  <Text as="h3" variant="bodyMd" fontWeight="semibold">
                                    {title}
                                  </Text>
                                  <Text as="p" tone="subdued">
                                    {`SKU ${sku} · ${categoryLabel} · ${vendor || "—"}${barcode ? ` · EAN ${barcode}` : ""}`}
                                  </Text>
                                  <InlineStack gap="200" blockAlign="center">
                                    <Text as="span" tone="subdued">
                                      {`Custo: ${formatEur(netPrice)}`}
                                    </Text>
                                    {grossPrice > 0 && (
                                      <Text as="span" tone="subdued">
                                        {`MSRP: ${formatEur(grossPrice)}`}
                                      </Text>
                                    )}
                                    <Text as="span" tone="subdued">
                                      {`Retail: ${formatEur(targetRetailPrice)}`}
                                    </Text>
                                    {marginPct !== null && (
                                      <Badge tone={marginPct >= 50 ? "success" : marginPct >= 30 ? "info" : "warning"}>
                                        {`Margem ${marginPct}%`}
                                      </Badge>
                                    )}
                                  </InlineStack>
                                  {franchiseList.length > 0 && (
                                    <InlineStack gap="100">
                                      {franchiseList.map((f) => (
                                        <Badge key={f} tone="info">{f}</Badge>
                                      ))}
                                    </InlineStack>
                                  )}
                                </BlockStack>
                                <InlineStack gap="200" blockAlign="center">
                                  <Checkbox
                                    label=""
                                    checked={selectedSkus.includes(sku)}
                                    onChange={(checked) => toggleSelectSku(sku, checked)}
                                  />
                                  {syncError && (
                                    <Tooltip content={`${syncError.label}: ${syncError.message}`}>
                                      <span
                                        role="img"
                                        aria-label="Erro de sincronização"
                                        style={{
                                          color: "var(--p-color-text-critical)",
                                          fontWeight: 700,
                                          cursor: "help",
                                          fontSize: "1.1rem",
                                        }}
                                      >
                                        !
                                      </span>
                                    </Tooltip>
                                  )}
                                  {salesUnits30d != null && salesUnits30d > 0 && (
                                    <Badge tone="info">{`Vendas: ${salesUnits30d} un.`}</Badge>
                                  )}
                                  {smartAction === "AUTO_APPROVE" && (
                                    <Badge tone="success">Smart-Approved</Badge>
                                  )}
                                  {smartAction === "AI_APPROVE" && (
                                    <Badge tone="success">AI-Approved</Badge>
                                  )}
                                  {smartAction === "AUTO_REJECT" && (
                                    <Badge tone="warning">Smart-Rejected</Badge>
                                  )}
                                  {status === "APPROVED" && !smartAction && (
                                    <Badge tone="success">Aprovado</Badge>
                                  )}
                                  {status === "PUBLISHED" && (
                                    <Badge tone="success">Publicado Shopify</Badge>
                                  )}
                                  {status === "SYNC_ERROR" && (
                                    <Badge tone="critical">Erro sync</Badge>
                                  )}
                                  {status === "REJECTED" && !smartAction && (
                                    <Badge tone="critical">Rejeitado</Badge>
                                  )}
                                  {(() => {
                                     const count = (imageUrl || "").split(/[,;|\n\r]+/).filter((u) => /^https?:\/\//i.test(u.trim())).length;
                                     return count > 1 ? (
                                       <Badge tone="info">{`📷 ${count} Fotos`}</Badge>
                                     ) : null;
                                   })()}
                                  <Badge tone={stock > 0 ? "success" : undefined}>
                                    {stock > 0 ? `Stock ${stock}` : "Sem stock"}
                                  </Badge>
                                </InlineStack>
                              </InlineStack>
                              <InlineStack gap="200">
                                <Button
                                  size="slim"
                                  variant="primary"
                                  onClick={() => postCuration(sku, "approve")}
                                >
                                  Aprovar
                                </Button>
                                <Button
                                  size="slim"
                                  tone="critical"
                                  onClick={() => postCuration(sku, "reject")}
                                >
                                  Rejeitar
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </ResourceItem>
                        );
                      }}
                    />

                    {totalCount > PAGE_SIZE && (
                      <Pagination
                        hasPrevious={safePage > 1}
                        onPrevious={() => setPage((p) => Math.max(1, p - 1))}
                        hasNext={safePage < totalPages}
                        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
                        label={`${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, totalCount)} de ${totalCount}`}
                      />
                    )}
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
    </div>
    <ShopifyPublishModal
      open={shopifyPublishOpen}
      onClose={() => setShopifyPublishOpen(false)}
      jobId={shopifyPublishJobId}
      onComplete={handleShopifyPublishComplete}
    />

    {selectedCount > 0 && (
      <div
        style={{
          position: "fixed",
          left: 24,
          right: 24,
          bottom: 20,
          zIndex: 650,
          background: "#111827",
          color: "#fff",
          borderRadius: 12,
          padding: "12px 16px",
          boxShadow: "0 12px 28px rgba(0,0,0,0.25)",
        }}
      >
        <InlineStack align="space-between" blockAlign="center">
          <span style={{ color: "#fff", fontWeight: 600 }}>
            {selectedCount} selecionado(s)
          </span>
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={() => runBulkStatus("approve")}>Aprovar Selecionados</Button>
            <Button tone="critical" onClick={() => runBulkStatus("reject")}>
              Rejeitar Selecionados
            </Button>
            <div style={{ width: 130 }}>
              <TextField
                label=""
                value={bulkMargin}
                onChange={setBulkMargin}
                autoComplete="off"
                placeholder="Margem ex: 1.50"
              />
            </div>
            <Button onClick={runBulkMargin}>Alterar Margem em Massa</Button>
            <Button onClick={clearSelection}>Fechar</Button>
          </InlineStack>
        </InlineStack>
      </div>
    )}

    <CuratorChatWidget onApplyCatalogFilters={handleApplyCatalogFiltersFromChat} />
    {toast && (
      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: selectedCount > 0 ? 92 : 24,
          zIndex: 700,
          background: toast.error ? "#7f1d1d" : "#111827",
          color: "#fff",
          borderRadius: 10,
          padding: "10px 12px",
          minWidth: 280,
          maxWidth: 420,
          boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
        }}
      >
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <span style={{ fontSize: 13 }}>{toast.content}</span>
          <InlineStack gap="200" blockAlign="center">
            {undoSnapshots.length > 0 && (
              <button
                type="button"
                onClick={runUndo}
                style={{
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "transparent",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "4px 8px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Undo
              </button>
            )}
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
        </InlineStack>
      </div>
    )}
    </>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <Page title="Painel de Curadoria">
      <Layout>
        <Layout.Section>
          <Banner tone="critical" title="Ocorreu um problema ao carregar o painel">
            <BlockStack gap="200">
              <Text as="p">
                {error?.message || "Erro de renderização temporário no navegador."}
              </Text>
              <InlineStack gap="200">
                <Button variant="primary" onClick={() => window.location.reload()}>
                  ⚡ Recarregar Painel
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
