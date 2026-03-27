import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  createDeepInfraSystemCacheWrapper,
  createDeepInfraWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { applyDeepInfraConfig, DEEPINFRA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDeepInfraProvider } from "./provider-catalog.js";

const PROVIDER_ID = "deepinfra";

const DEEPINFRA_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
  "zai-org/",
] as const;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  provider: {
    label: "DeepInfra",
    docsPath: "/providers/deepinfra",
    auth: [
      {
        methodId: "api-key",
        label: "DeepInfra API key",
        hint: "Unified API for open source models",
        optionKey: "deepinfraApiKey",
        flagName: "--deepinfra-api-key",
        envVar: "DEEPINFRA_API_KEY",
        promptMessage: "Enter DeepInfra API key",
        defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDeepInfraConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildDeepInfraProvider,
    },
    capabilities: {
      openAiCompatTurnValidation: false,
      geminiThoughtSignatureSanitization: true,
      geminiThoughtSignatureModelHints: ["gemini"],
      dropThinkingBlockModelHints: ["claude"],
    },
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      let streamFn = createDeepInfraWrapper(ctx.streamFn, thinkingLevel);
      streamFn = createDeepInfraSystemCacheWrapper(streamFn);
      return streamFn;
    },
    isCacheTtlEligible: (ctx) =>
      DEEPINFRA_CACHE_TTL_MODEL_PREFIXES.some((p) => ctx.modelId.startsWith(p)),
  },
});
