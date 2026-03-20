import {
  buildFeatherlessModelDefinition,
  FEATHERLESS_BASE_URL,
  FEATHERLESS_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  applyProviderConfigWithModelCatalogPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const FEATHERLESS_DEFAULT_MODEL_REF = "featherless/MiniMaxAI/MiniMax-M2.5";

function applyFeatherlessPreset(cfg: OpenClawConfig, primaryModelRef?: string): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    providerId: "featherless",
    api: "openai-completions",
    baseUrl: FEATHERLESS_BASE_URL,
    catalogModels: FEATHERLESS_MODEL_CATALOG.map(buildFeatherlessModelDefinition),
    aliases: [{ modelRef: FEATHERLESS_DEFAULT_MODEL_REF, alias: "Featherless AI" }],
    primaryModelRef,
  });
}

export function applyFeatherlessProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyFeatherlessPreset(cfg);
}

export function applyFeatherlessConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyFeatherlessPreset(cfg, FEATHERLESS_DEFAULT_MODEL_REF);
}
