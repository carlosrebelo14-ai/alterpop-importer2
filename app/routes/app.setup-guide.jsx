/* eslint-disable react/prop-types */
import { useState } from "react";
import { BlockStack, Card, Collapsible, Layout, Page, Text, Button } from "@shopify/polaris";

function GuideSection({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <BlockStack gap="200">
        <Button onClick={() => setOpen((v) => !v)}>{open ? `Hide — ${title}` : `Show — ${title}`}</Button>
        <Collapsible open={open} id={`guide-${title.replace(/\s+/g, "-").toLowerCase()}`}>
          <div style={{ paddingTop: 8 }}>{children}</div>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}

export default function SetupGuidePage() {
  return (
    <div className="alterpop-dashboard alterpop-page-shell">
      <Page
        fullWidth
        title="Setup Guide"
        subtitle="Onboarding manual for launching your first market integration."
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <GuideSection title="Step 1: Shopify Connection">
                <Text as="p">
                  Generate an Admin API access token in your Shopify app settings, then configure your shop URL and launch the embedded app from Shopify Admin.
                </Text>
                <Text as="p" tone="subdued">
                  Recommendation: keep write scopes minimal and validate connection with a dry-run sync first.
                </Text>
              </GuideSection>

              <GuideSection title="Step 2: Catalog Mapping">
                <Text as="p">
                  Upload your supplier CSV in Settings and use the visual Data Mapping Wizard to map SKU, Price, and Brand columns.
                </Text>
                <Text as="p" tone="subdued">
                  Review preview rows before saving to avoid SKU mismatches and broken imports.
                </Text>
              </GuideSection>

              <GuideSection title="Step 3: Customizing Market Rules">
                <Text as="p">
                  Open Market Configuration and define VIP Brands, VIP Categories, and Blocked Terms that match your vertical (fashion, perfumes, pop culture, etc.).
                </Text>
                <Text as="p" tone="subdued">
                  These rules drive fast-track filtering and can be changed anytime without redeploying.
                </Text>
              </GuideSection>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </div>
  );
}

