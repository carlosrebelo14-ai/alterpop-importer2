import { Banner, BlockStack, Text, TextField } from "@shopify/polaris";

/**
 * Confirmação de ações em massa acima do limiar (50 produtos): diz o número, o âmbito/filtro
 * por extenso e uma amostra de 5 SKUs, e exige escrever o número exato. É o ÚNICO componente
 * de confirmação em massa da app: "aplicar aos publicados" usa-o e o D1 (aprovar, rejeitar e
 * publicar) reutiliza-o, para a regra dos 50 não ter versões diferentes.
 * O servidor verifica o mesmo número (confirmCount) — este componente é só a metade visível.
 */
export const BULK_CONFIRM_THRESHOLD = 50;
export const BULK_SAMPLE_SIZE = 5;

/** true quando a confirmação está cumprida: abaixo do limiar nada a escrever. */
export function isBulkConfirmed(scope, typed, threshold = BULK_CONFIRM_THRESHOLD) {
  return scope <= threshold || String(typed).trim() === String(scope);
}

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
