/* eslint-disable react/prop-types */
import { useMemo, useState } from "react";
import { Filters, TextField, ChoiceList, InlineStack, Select, Checkbox } from "@shopify/polaris";
import { REASON_OPTIONS, reasonLabel } from "../utils/curationReasonLabels.js";

/**
 * Redesign da Curadoria (2026-08-13) — barra de filtros horizontal (Polaris `Filters`,
 * o mesmo componente usado pelo IndexFilters oficial) em vez da sidebar lateral
 * (FacetedSearchSidebar, removida). Mesmos handlers/estado do componente anterior —
 * só muda onde os controlos vivem, para libertar largura para a tabela.
 */
const CURATION_STATUS_CHOICES = [
  { label: "Sem decisão", value: "NO_DECISION" },
  { label: "Aprovados", value: "APPROVED" },
  { label: "Rejeitados", value: "REJECTED" },
  { label: "Pendentes", value: "PENDING" },
  { label: "Publicados Shopify", value: "PUBLISHED" },
  { label: "Erro de sync", value: "SYNC_ERROR" },
];

const SEARCH_SCOPE_OPTIONS = [
  { label: "Título + SKU", value: "all" },
  { label: "Só título", value: "title" },
  { label: "Só SKU", value: "sku" },
  { label: "Só EAN", value: "barcode" },
  { label: "Só marca", value: "vendor" },
];

export function CurationFiltersBar({
  licences = [],
  brands = [],
  productTypes = [],
  selectedLicenceIds = [],
  onLicenceIdsChange,
  selectedProductTypeIds = [],
  onProductTypeIdsChange,
  selectedBrand,
  onBrandChange,
  minPrice = "",
  maxPrice = "",
  onMinPriceChange,
  onMaxPriceChange,
  inStockOnly = false,
  onInStockOnlyChange,
  searchQuery = "",
  onSearchChange,
  searchScope = "all",
  onSearchScopeChange,
  curationStatus = "",
  onCurationStatusChange,
  reasonFilter = "",
  onReasonFilterChange,
  onClearAll,
}) {
  const [brandQuery, setBrandQuery] = useState("");
  const [licenceQuery, setLicenceQuery] = useState("");
  const [categoryQuery, setCategoryQuery] = useState("");

  const filteredBrands = useMemo(() => {
    const q = brandQuery.trim().toLowerCase();
    return q ? brands.filter((b) => b.label.toLowerCase().includes(q)) : brands;
  }, [brands, brandQuery]);
  const filteredLicences = useMemo(() => {
    const q = licenceQuery.trim().toLowerCase();
    return q ? licences.filter((l) => l.label.toLowerCase().includes(q)) : licences;
  }, [licences, licenceQuery]);
  const filteredProductTypes = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    return q ? productTypes.filter((p) => p.label.toLowerCase().includes(q)) : productTypes;
  }, [productTypes, categoryQuery]);

  const filters = [
    {
      key: "brand",
      label: "Marca",
      filter: (
        <div style={{ minWidth: 220 }}>
          <TextField
            label="Procurar marca"
            labelHidden
            placeholder="Procurar marca…"
            value={brandQuery}
            onChange={setBrandQuery}
            autoComplete="off"
          />
          <ChoiceList
            title="Marca"
            titleHidden
            choices={filteredBrands.map((b) => ({ label: `${b.label} (${b.count.toLocaleString("pt-PT")})`, value: b.id }))}
            selected={selectedBrand ? [selectedBrand] : []}
            onChange={(sel) => onBrandChange(sel[0] || null)}
          />
        </div>
      ),
    },
    {
      key: "franchise",
      label: "Franquia",
      filter: (
        <div style={{ minWidth: 220 }}>
          <TextField
            label="Procurar franquia"
            labelHidden
            placeholder="Procurar franquia…"
            value={licenceQuery}
            onChange={setLicenceQuery}
            autoComplete="off"
          />
          <ChoiceList
            title="Franquia"
            titleHidden
            allowMultiple
            choices={filteredLicences.map((l) => ({ label: `${l.label} (${l.count.toLocaleString("pt-PT")})`, value: l.id }))}
            selected={selectedLicenceIds}
            onChange={onLicenceIdsChange}
          />
        </div>
      ),
    },
    {
      key: "category",
      label: "Categoria",
      filter: (
        <div style={{ minWidth: 220 }}>
          <TextField
            label="Procurar categoria"
            labelHidden
            placeholder="Procurar categoria…"
            value={categoryQuery}
            onChange={setCategoryQuery}
            autoComplete="off"
          />
          <ChoiceList
            title="Categoria"
            titleHidden
            allowMultiple
            choices={filteredProductTypes.map((p) => ({ label: `${p.label} (${p.count.toLocaleString("pt-PT")})`, value: p.id }))}
            selected={selectedProductTypeIds}
            onChange={onProductTypeIdsChange}
          />
        </div>
      ),
    },
    {
      key: "price",
      label: "Preço",
      filter: (
        <InlineStack gap="200">
          <TextField label="Mín (€)" type="number" min={0} value={minPrice} onChange={onMinPriceChange} autoComplete="off" />
          <TextField label="Máx (€)" type="number" min={0} value={maxPrice} onChange={onMaxPriceChange} autoComplete="off" />
        </InlineStack>
      ),
    },
    {
      key: "status",
      label: "Estado",
      filter: (
        <ChoiceList
          title="Estado"
          titleHidden
          choices={CURATION_STATUS_CHOICES}
          selected={curationStatus ? [curationStatus] : []}
          onChange={(sel) => onCurationStatusChange?.(sel[0] || "")}
        />
      ),
    },
    {
      key: "reason",
      label: "Motivo",
      filter: (
        <ChoiceList
          title="Motivo"
          titleHidden
          choices={REASON_OPTIONS.filter((o) => o.value)}
          selected={reasonFilter ? [reasonFilter] : []}
          onChange={(sel) => onReasonFilterChange?.(sel[0] || "")}
        />
      ),
    },
  ];

  const appliedFilters = [];
  if (selectedBrand) {
    const b = brands.find((x) => x.id === selectedBrand);
    appliedFilters.push({ key: "brand", label: `Marca: ${b?.label || selectedBrand}`, onRemove: () => onBrandChange(null) });
  }
  for (const id of selectedLicenceIds) {
    const l = licences.find((x) => x.id === id);
    appliedFilters.push({
      key: `franchise-${id}`,
      label: `Franquia: ${l?.label || id}`,
      onRemove: () => onLicenceIdsChange(selectedLicenceIds.filter((x) => x !== id)),
    });
  }
  for (const id of selectedProductTypeIds) {
    const p = productTypes.find((x) => x.id === id);
    appliedFilters.push({
      key: `category-${id}`,
      label: `Categoria: ${p?.label || id}`,
      onRemove: () => onProductTypeIdsChange(selectedProductTypeIds.filter((x) => x !== id)),
    });
  }
  if (minPrice || maxPrice) {
    appliedFilters.push({
      key: "price",
      label: `Preço: ${minPrice || "0"}–${maxPrice || "∞"}€`,
      onRemove: () => {
        onMinPriceChange("");
        onMaxPriceChange("");
      },
    });
  }
  if (curationStatus) {
    appliedFilters.push({
      key: "status",
      label: `Estado: ${CURATION_STATUS_CHOICES.find((o) => o.value === curationStatus)?.label || curationStatus}`,
      onRemove: () => onCurationStatusChange?.(""),
    });
  }
  if (reasonFilter) {
    appliedFilters.push({
      key: "reason",
      label: `Motivo: ${reasonLabel(reasonFilter)}`,
      onRemove: () => onReasonFilterChange?.(""),
    });
  }

  return (
    <Filters
      queryValue={searchQuery}
      queryPlaceholder="Pesquisar produtos…"
      onQueryChange={onSearchChange}
      onQueryClear={() => onSearchChange("")}
      onClearAll={onClearAll}
      filters={filters}
      appliedFilters={appliedFilters}
    >
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <div style={{ minWidth: 150 }}>
          <Select
            label="Âmbito da pesquisa"
            labelHidden
            options={SEARCH_SCOPE_OPTIONS}
            value={searchScope}
            onChange={onSearchScopeChange}
          />
        </div>
        <Checkbox
          label="Em stock"
          checked={inStockOnly}
          onChange={(checked) => onInStockOnlyChange?.(checked)}
        />
      </InlineStack>
    </Filters>
  );
}
