/* eslint-disable react/prop-types */
import { useCallback, useMemo, useState } from "react";
import { Card, TextField } from "@shopify/polaris";
import "../styles/faceted-search.css";

/**
 * Motivos reais gerados por evaluateCurationRules() (lib/importer/curation/
 * visibilityGatekeeper.js) — o gate que corre em cada produto indexado; ordem e
 * volumes confirmados contra a fila de curadoria em produção (2026-08-12,
 * 29.601 itens): brand_not_allowed 16.651, approved 9.097, elite_brand_not_premium
 * 2.100, blocked_category 1.224, priority_franchise_exception 433. Os "structured_*"
 * vêm de evaluateStructuredCatalogFilter() (caminho legado/paralelo, muito menos
 * usado hoje — ~100 itens no total) mas mantidos porque ainda aparecem. A
 * comparação ignora o sufixo ":valor" dos motivos parametrizados.
 */
const REASON_OPTIONS = [
  { value: "", label: "Todos" },
  { value: "brand_not_allowed", label: "Marca não permitida" },
  { value: "approved", label: "Aprovado automaticamente (gate)" },
  { value: "elite_brand_not_premium", label: "Marca elite, mas não premium" },
  { value: "blocked_category", label: "Categoria bloqueada" },
  { value: "priority_franchise_exception", label: "Exceção por franquia prioritária" },
  { value: "pending_review", label: "Pendente de revisão" },
  { value: "manual_dashboard", label: "Decisão manual" },
  { value: "manual_dashboard_bulk", label: "Decisão manual em massa" },
  { value: "structured_no_brand_no_stock", label: "(legado) Sem marca e sem stock" },
  { value: "structured_min_price", label: "(legado) Abaixo do preço mínimo" },
  { value: "structured_junk_category", label: "(legado) Categoria excluída" },
];

/**
 * @param {{
 *   licences: { id: string, label: string, count: number }[],
 *   brands: { id: string, label: string, count: number }[],
 *   productTypes: { id: string, label: string, count: number }[],
 *   selectedLicenceIds: string[],
 *   onLicenceIdsChange: (ids: string[]) => void,
 *   selectedProductTypeIds: string[],
 *   onProductTypeIdsChange: (ids: string[]) => void,
 *   selectedBrand: string | null,
 *   onBrandChange: (brand: string | null) => void,
 *   minPrice: string,
 *   maxPrice: string,
 *   onMinPriceChange: (v: string) => void,
 *   onMaxPriceChange: (v: string) => void,
 *   inStockOnly: boolean,
 *   onInStockOnlyChange: (v: boolean) => void,
 *   searchQuery: string,
 *   onSearchChange: (q: string) => void,
 *   searchScope: string,
 *   onSearchScopeChange: (scope: string) => void,
 *   reasonFilter: string,
 *   onReasonFilterChange: (reason: string) => void,
 *   savedFilters: { id: string, name: string }[],
 *   onApplySavedFilter: (id: string) => void,
 *   onDeleteSavedFilter: (id: string) => void,
 *   onSaveCurrentFilter: (name: string) => void,
 * }} props
 */
export function FacetedSearchSidebar({
  licences = [],
  brands = [],
  productTypes = [],
  selectedLicenceIds,
  onLicenceIdsChange,
  selectedProductTypeIds,
  onProductTypeIdsChange,
  selectedBrand,
  onBrandChange,
  minPrice = "",
  maxPrice = "",
  onMinPriceChange,
  onMaxPriceChange,
  inStockOnly = false,
  onInStockOnlyChange,
  searchQuery,
  onSearchChange,
  searchScope = "all",
  onSearchScopeChange,
  curationStatus = "",
  onCurationStatusChange,
  reasonFilter = "",
  onReasonFilterChange,
  savedFilters = [],
  onApplySavedFilter,
  onDeleteSavedFilter,
  onSaveCurrentFilter,
}) {
  const [open, setOpen] = useState({
    savedFilters: false,
    curationStatus: true,
    reason: false,
    licences: true,
    brands: false,
    productTypes: false,
    price: false,
  });
  const [saveFilterName, setSaveFilterName] = useState("");
  const [licenceQuery, setLicenceQuery] = useState("");
  const [brandQuery, setBrandQuery] = useState("");

  const toggleOpen = useCallback((key) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleId = useCallback((list, id, onChange) => {
    if (list.includes(id)) onChange(list.filter((x) => x !== id));
    else onChange([...list, id]);
  }, []);

  const filteredLicences = useMemo(() => {
    const q = licenceQuery.trim().toLowerCase();
    if (!q) return licences;
    return licences.filter((l) => l.label.toLowerCase().includes(q));
  }, [licences, licenceQuery]);

  const filteredBrands = useMemo(() => {
    const q = brandQuery.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter((b) => b.label.toLowerCase().includes(q));
  }, [brands, brandQuery]);

  const clearAll = useCallback(() => {
    onLicenceIdsChange([]);
    onProductTypeIdsChange([]);
    onBrandChange(null);
    onMinPriceChange("");
    onMaxPriceChange("");
    onInStockOnlyChange?.(false);
    onSearchChange("");
    onSearchScopeChange?.("all");
    onReasonFilterChange?.("");
    setLicenceQuery("");
    setBrandQuery("");
  }, [
    onLicenceIdsChange,
    onProductTypeIdsChange,
    onBrandChange,
    onMinPriceChange,
    onMaxPriceChange,
    onInStockOnlyChange,
    onSearchChange,
    onSearchScopeChange,
    onReasonFilterChange,
    onCurationStatusChange,
  ]);

  return (
    <Card>
      <div className="faceted-search">
        <h2 className="faceted-search__title">Filters</h2>

        <div className="faceted-search__search-product">
          <TextField
            label="Search product / SKU"
            value={searchQuery}
            onChange={onSearchChange}
            placeholder="Title or SKU…"
            autoComplete="off"
            clearButton
            onClearButtonClick={() => onSearchChange("")}
          />
          <label style={{ display: "block", marginTop: 6 }}>
            <span style={{ fontSize: 12, color: "#6d7175" }}>Procurar em</span>
            <select
              value={searchScope}
              onChange={(e) => onSearchScopeChange?.(e.target.value)}
              style={{ width: "100%", marginTop: 2 }}
              aria-label="Âmbito da pesquisa"
            >
              <option value="all">Título + SKU (padrão)</option>
              <option value="title">Só título</option>
              <option value="sku">Só SKU</option>
              <option value="barcode">Só EAN / código de barras</option>
              <option value="vendor">Só marca</option>
            </select>
          </label>
        </div>

        <label className={`faceted-search__stock-toggle ${inStockOnly ? "faceted-search__stock-toggle--active" : ""}`}>
          <input
            type="checkbox"
            checked={inStockOnly}
            onChange={(e) => onInStockOnlyChange?.(e.target.checked)}
          />
          <span>Mostrar apenas artigos em stock</span>
          <span className="faceted-search__stock-hint">Filtrar produtos com stock &gt; 0</span>
        </label>

        <div className="faceted-search__accordion">
          <FacetSection
            title="Filtros guardados"
            count={savedFilters.length}
            open={open.savedFilters}
            onToggle={() => toggleOpen("savedFilters")}
          >
            {savedFilters.length === 0 ? (
              <p style={{ fontSize: 12, color: "#6d7175", margin: "0 0 8px" }}>
                Nenhum filtro guardado ainda.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {savedFilters.map((f) => (
                  <div
                    key={f.id}
                    style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}
                  >
                    <button
                      type="button"
                      onClick={() => onApplySavedFilter?.(f.id)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "none",
                        border: "none",
                        padding: "2px 0",
                        cursor: "pointer",
                        color: "#2c6ecb",
                        fontSize: 13,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {f.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSavedFilter?.(f.id)}
                      aria-label={`Apagar filtro ${f.name}`}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#8c9196", fontSize: 12 }}
                    >
                      Apagar
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="Nome do filtro atual…"
                value={saveFilterName}
                onChange={(e) => setSaveFilterName(e.target.value)}
                style={{ flex: 1 }}
                aria-label="Nome do novo filtro guardado"
              />
              <button
                type="button"
                disabled={!saveFilterName.trim()}
                onClick={() => {
                  onSaveCurrentFilter?.(saveFilterName.trim());
                  setSaveFilterName("");
                }}
                style={{ whiteSpace: "nowrap" }}
              >
                Guardar
              </button>
            </div>
          </FacetSection>

          <FacetSection
            title="Estado de Curadoria"
            count={curationStatus ? 1 : 0}
            open={open.curationStatus}
            onToggle={() => toggleOpen("curationStatus")}
          >
            <div className="faceted-search__options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { value: "", label: "Todos" },
                { value: "NO_DECISION", label: "Sem decisão" },
                { value: "APPROVED", label: "Aprovados" },
                { value: "REJECTED", label: "Rejeitados" },
                { value: "PENDING", label: "Pendentes" },
                { value: "PUBLISHED", label: "Publicados Shopify" },
                { value: "SYNC_ERROR", label: "Erro de sync" },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className="faceted-search__option"
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="curation-status"
                    checked={curationStatus === opt.value}
                    onChange={() => onCurationStatusChange?.(opt.value)}
                  />
                  <span className="faceted-search__option-label">{opt.label}</span>
                </label>
              ))}
            </div>
          </FacetSection>

          <FacetSection
            title="Motivo de Curadoria"
            count={reasonFilter ? 1 : 0}
            open={open.reason}
            onToggle={() => toggleOpen("reason")}
          >
            <div className="faceted-search__options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {REASON_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="faceted-search__option"
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name="curation-reason"
                    checked={reasonFilter === opt.value}
                    onChange={() => onReasonFilterChange?.(opt.value)}
                  />
                  <span className="faceted-search__option-label">{opt.label}</span>
                </label>
              ))}
            </div>
          </FacetSection>

          <FacetSection
            title="Licences / Franchises"
            count={selectedLicenceIds.length || licences.length}
            open={open.licences}
            onToggle={() => toggleOpen("licences")}
          >
            <div className="faceted-search__mini-search">
              <input
                type="search"
                placeholder="Search licence…"
                value={licenceQuery}
                onChange={(e) => setLicenceQuery(e.target.value)}
                aria-label="Search licence"
              />
            </div>
            <CheckboxList
              options={filteredLicences}
              selected={selectedLicenceIds}
              onToggle={(id) => toggleId(selectedLicenceIds, id, onLicenceIdsChange)}
            />
          </FacetSection>

          <FacetSection
            title="Brands"
            count={selectedBrand ? 1 : brands.length}
            open={open.brands}
            onToggle={() => toggleOpen("brands")}
          >
            <div className="faceted-search__mini-search">
              <input
                type="search"
                placeholder="Search brand…"
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                aria-label="Search brand"
              />
            </div>
            <CheckboxList
              options={filteredBrands}
              selected={selectedBrand ? [selectedBrand] : []}
              singleSelect
              onToggle={(id) => onBrandChange(selectedBrand === id ? null : id)}
            />
          </FacetSection>

          <FacetSection
            title="Product Type"
            count={selectedProductTypeIds.length || productTypes.length}
            open={open.productTypes}
            onToggle={() => toggleOpen("productTypes")}
          >
            <CheckboxList
              options={productTypes}
              selected={selectedProductTypeIds}
              onToggle={(id) =>
                toggleId(selectedProductTypeIds, id, onProductTypeIdsChange)
              }
            />
          </FacetSection>

          <FacetSection
            title="Price Range"
            count={minPrice || maxPrice ? 1 : 0}
            open={open.price}
            onToggle={() => toggleOpen("price")}
          >
            <p style={{ fontSize: 12, color: "#6d7175", margin: "0 0 8px" }}>
              Net cost (€)
            </p>
            <div className="faceted-search__price-row">
              <input
                type="number"
                min={0}
                placeholder="Min"
                value={minPrice}
                onChange={(e) => onMinPriceChange(e.target.value)}
                aria-label="Minimum price"
              />
              <input
                type="number"
                min={0}
                placeholder="Max"
                value={maxPrice}
                onChange={(e) => onMaxPriceChange(e.target.value)}
                aria-label="Maximum price"
              />
            </div>
          </FacetSection>
        </div>

        <button type="button" className="faceted-search__clear" onClick={clearAll}>
          Clear all filters
        </button>
      </div>
    </Card>
  );
}

function FacetSection({ title, open, onToggle, children }) {
  return (
    <div className="faceted-search__section">
      <button
        type="button"
        className="faceted-search__section-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="faceted-search__section-count">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="faceted-search__section-body">{children}</div>}
    </div>
  );
}

/**
 * @param {{
 *   options: { id: string, label: string, count: number }[],
 *   selected: string[],
 *   onToggle: (id: string) => void,
 *   singleSelect?: boolean,
 * }} props
 */
function CheckboxList({ options, selected, onToggle, singleSelect = false }) {
  if (!options.length) {
    return <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>No options</p>;
  }

  return (
    <div className="faceted-search__options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {options.map((opt) => {
        const safeCount = Number.isFinite(Number(opt?.count)) ? Number(opt.count) : 0;
        return (
        <label
          key={opt.id}
          className="faceted-search__option"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            width: "100%",
            cursor: "pointer",
            lineHeight: 1.35,
          }}
        >
          <input
            type={singleSelect ? "radio" : "checkbox"}
            name={singleSelect ? "facet-single" : undefined}
            checked={selected.includes(opt.id)}
            onChange={() => onToggle(opt.id)}
          />
          <span
            className="faceted-search__option-label"
            style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
          >
            {String(opt?.label || "")}
          </span>
          <span className="faceted-search__option-count" style={{ whiteSpace: "nowrap", color: "#6d7175" }}>
            {safeCount.toLocaleString("pt-PT")}
          </span>
        </label>
      );})}
    </div>
  );
}
