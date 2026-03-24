import {
  DEEPINFRA_BASE_URL,
  discoverDeepInfraModels,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-models";

export async function buildDeepInfraProvider(): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}
