import { useCallback, useMemo, useState } from "react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Collapsible,
  ChoiceList,
  Autocomplete,
  TextField,
  Checkbox,
} from "@shopify/polaris";

/**
 * @param {{
 *   taxonomySections: { id: string, title: string, children: { id: string, label: string }[] }[],
 *   brands: string[],
 *   filterCounts?: Record<string, number>,
 *   selectedFilterIds: string[],
 *   onFilterIdsChange: (ids: string[]) => void,
 *   selectedBrand: string | null,
 *   onBrandChange: (brand: string | null) => void,
 *   minPrice: string,
 *   maxPrice: string,
 *   onMinPriceChange: (v: string) => void,
 *   onMaxPriceChange: (v: string) => void,
 *   searchQuery: string,
 *   onSearchChange: (q: string) => void,
 * }} props
 */
export function CurationSitemapFilters({
  taxonomySections = [],
  brands = [],
  filterCounts = {},
  selectedFilterIds,
  onFilterIdsChange,
  selectedBrand,
  onBrandChange,
  minPrice = "",
  maxPrice = "",
  onMinPriceChange,
  onMaxPriceChange,
  searchQuery,
  onSearchChange,
}) {
  const [openSections, setOpenSections] = useState(() =>
    Object.fromEntries(
      taxonomySections.map((s) => [s.id, s.id === "anime-manga"])
    )
  );
  const [brandQuery, setBrandQuery] = useState(selectedBrand || "");

  const brandOptions = useMemo(() => {
    const q = brandQuery.trim().toLowerCase();
    return brands
      .filter((b) => !q || b.toLowerCase().includes(q))
      .slice(0, 40)
      .map((b) => ({ value: b, label: b }));
  }, [brands, brandQuery]);

  const toggleSection = useCallback((sectionId) => {
    setOpenSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  const handleChildChange = useCallback(
    (sectionChildIds, selected) => {
      const withoutSection = selectedFilterIds.filter(
        (id) => !sectionChildIds.includes(id) && !id.startsWith("section:")
      );
      onFilterIdsChange([...withoutSection, ...selected]);
    },
    [selectedFilterIds, onFilterIdsChange]
  );

  const toggleSectionFilter = useCallback(
    (section) => {
      const childIds = section.children.map((c) => c.id);
      const sectionKey = section.id;
      const hasSection = selectedFilterIds.includes(sectionKey);
      if (hasSection) {
        onFilterIdsChange(
          selectedFilterIds.filter((id) => id !== sectionKey && !childIds.includes(id))
        );
        return;
      }
      onFilterIdsChange([
        ...selectedFilterIds.filter((id) => !childIds.includes(id)),
        sectionKey,
      ]);
    },
    [selectedFilterIds, onFilterIdsChange]
  );

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Taxonomy (English)
        </Text>

        <TextField
          label="Pesquisar produto / SKU"
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Title or SKU…"
          autoComplete="off"
          clearButton
          onClearButtonClick={() => onSearchChange("")}
        />

        <Autocomplete
          options={brandOptions}
          selected={selectedBrand ? [selectedBrand] : []}
          onSelect={(selected) => {
            const value = selected[0] || null;
            onBrandChange(value);
            setBrandQuery(value || "");
          }}
          textField={
            <Autocomplete.TextField
              label="Search by Brand"
              value={brandQuery}
              onChange={(value) => {
                setBrandQuery(value);
                const match = brands.find(
                  (b) => b.toLowerCase() === value.trim().toLowerCase()
                );
                if (match) onBrandChange(match);
                else if (!value.trim()) onBrandChange(null);
              }}
              placeholder="Ex: Funko, Banpresto…"
              autoComplete="off"
              clearButton
              onClearButtonClick={() => {
                setBrandQuery("");
                onBrandChange(null);
              }}
            />
          }
        />

        <Text as="p" variant="bodySm" tone="subdued">
          Net price range (cost)
        </Text>
        <InlineStack gap="200">
          <TextField
            label="Min price (€)"
            type="number"
            value={minPrice}
            onChange={onMinPriceChange}
            placeholder="0"
            autoComplete="off"
            min={0}
          />
          <TextField
            label="Max price (€)"
            type="number"
            value={maxPrice}
            onChange={onMaxPriceChange}
            placeholder="999"
            autoComplete="off"
            min={0}
          />
        </InlineStack>

        {taxonomySections.map((section) => {
          const childIds = section.children.map((c) => c.id);
          const sectionSelected = selectedFilterIds.includes(section.id);
          const sectionChildSelected = selectedFilterIds.filter((id) =>
            childIds.includes(id)
          );
          const open = openSections[section.id];
          const sectionCount = section.children.reduce(
            (sum, c) => sum + (filterCounts[c.id] || 0),
            0
          );

          return (
            <BlockStack key={section.id} gap="200">
              <Button
                fullWidth
                textAlign="left"
                disclosure={open ? "up" : "down"}
                onClick={() => toggleSection(section.id)}
              >
                {`${section.title} (${sectionCount.toLocaleString("pt-PT")})`}
              </Button>
              <Checkbox
                label={`All in ${section.title}`}
                checked={sectionSelected}
                onChange={() => toggleSectionFilter(section)}
              />
              <Collapsible open={open} id={`filter-${section.id}`}>
                <ChoiceList
                  allowMultiple
                  title={section.title}
                  choices={section.children.map((child) => ({
                    label: `${child.label} (${(filterCounts[child.id] || 0).toLocaleString("pt-PT")})`,
                    value: child.id,
                    disabled: sectionSelected,
                  }))}
                  selected={sectionSelected ? childIds : sectionChildSelected}
                  onChange={(selected) => handleChildChange(childIds, selected)}
                />
              </Collapsible>
            </BlockStack>
          );
        })}

        <Button
          variant="plain"
          onClick={() => {
            onFilterIdsChange([]);
            onBrandChange(null);
            onMinPriceChange("");
            onMaxPriceChange("");
            onSearchChange("");
            setBrandQuery("");
          }}
        >
          Clear filters
        </Button>
      </BlockStack>
    </Card>
  );
}
