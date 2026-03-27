import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { DEEPINFRA_DEFAULT_MODEL_REF };

const deepinfraPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: DEEPINFRA_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "deepinfra",
    api: "openai-completions",
    baseUrl: DEEPINFRA_BASE_URL,
    catalogModels: [...DEEPINFRA_MODEL_CATALOG],
    aliases: [{ modelRef: DEEPINFRA_DEFAULT_MODEL_REF, alias: "DeepInfra" }],
  }),
});

export function applyDeepInfraConfig(cfg: OpenClawConfig): OpenClawConfig {
  return deepinfraPresetAppliers.applyConfig(cfg);
}
