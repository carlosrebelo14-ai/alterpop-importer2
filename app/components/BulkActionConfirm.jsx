import { Banner, BlockStack, Text, TextField } from "@shopify/polaris";
import { BULK_CONFIRM_THRESHOLD, BULK_SAMPLE_SIZE, isBulkConfirmed } from "../../lib/curation/bulkConfirm.js";

/**
 * Confirmação de ações em massa acima do limiar (50 produtos): diz o número, o âmbito/filtro
 * por extenso e uma amostra de 5 SKUs, e exige escrever o número exato. É o ÚNICO componente
 * de confirmação em massa da app: "aplicar aos publicados" usa-o e o D1 (aprovar, rejeitar e
 * publicar) reutiliza-o, para a regra dos 50 não ter versões diferentes.
 * O servidor verifica o mesmo número (confirmCount) — este componente é só a metade visível.
 */
export { BULK_CONFIRM_THRESHOLD, BULK_SAMPLE_SIZE, isBulkConfirmed };

/**
 * @param {{ scope: number, threshold?: number, scopeText: string, sampleSkus: string[],
 *   typed: string, onTyped: (v: string) => void, verb?: string }} props
 */
export function BulkActionConfirm({ scope, threshold = BULK_CONFIRM_THRESHOLD, scopeText, sampleSkus, typed, onTyped, verb = "mexer em" }) {
  if (scope <= threshold) return null;
  return (
    <BlockStack gap="200">
      <Banner tone="warning">
        <BlockStack gap="100">
          <Text as="p">{`Vais ${verb} ${scope} produtos. Âmbito: ${scopeText}.`}</Text>
          <Text as="p" variant="bodySm">{`Amostra: ${sampleSkus.slice(0, BULK_SAMPLE_SIZE).join(", ")}`}</Text>
        </BlockStack>
      </Banner>
      <TextField label={`Escreve ${scope} para confirmar`} value={typed} onChange={onTyped} autoComplete="off" />
    </BlockStack>
  );
}
