import { getDefaultConfig } from "../config.js";

/**
 * @param {{ translationProvider?: string, translationApiKey?: string, translateToEnglish?: boolean }} settings
 */
export function resolveTranslationConfig(settings = {}) {
  const cfg = getDefaultConfig();
  const translateToEnglish = settings.translateToEnglish !== false;
  let provider = (settings.translationProvider || cfg.translation.provider || "passthrough").toLowerCase();
  const apiKey = settings.translationApiKey || cfg.translation.apiKey || "";

  if (translateToEnglish && provider === "passthrough" && apiKey) {
    provider = "deepl";
  }

  return { translateToEnglish, provider, apiKey };
}

/**
 * @param {{ translationProvider?: string, translationApiKey?: string, translateToEnglish?: boolean }} settings
 */
export function assertTranslationReady(settings = {}) {
  const { translateToEnglish, provider, apiKey } = resolveTranslationConfig(settings);
  if (!translateToEnglish) return;
  if (provider === "passthrough") {
    throw new Error(
      "English translation is enabled but provider is passthrough. Set DeepL in Settings and add TRANSLATION_API_KEY."
    );
  }
  if (provider === "deepl" && !apiKey) {
    throw new Error("TRANSLATION_API_KEY is required when using DeepL.");
  }
}
