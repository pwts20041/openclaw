import {
  buildFeatherlessModelDefinition,
  type ModelProviderConfig,
  FEATHERLESS_BASE_URL,
  FEATHERLESS_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export function buildFeatherlessProvider(): ModelProviderConfig {
  return {
    baseUrl: FEATHERLESS_BASE_URL,
    api: "openai-completions",
    models: FEATHERLESS_MODEL_CATALOG.map(buildFeatherlessModelDefinition),
  };
}
