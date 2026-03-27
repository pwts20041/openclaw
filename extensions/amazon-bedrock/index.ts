import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "openclaw/plugin-sdk/provider-stream";

const PROVIDER_ID = "amazon-bedrock";
const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;

/** Extract the AWS region from a bedrock-runtime baseUrl, e.g. "https://bedrock-runtime.eu-west-1.amazonaws.com". */
function extractRegionFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const match = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/.exec(baseUrl);
  return match?.[1];
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Amazon Bedrock Provider",
  description: "Bundled Amazon Bedrock provider policy plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Amazon Bedrock",
      docsPath: "/providers/models",
      auth: [],
      wrapStreamFn: ({ modelId, config, streamFn }) => {
        // Look up model name and region from provider config.
        // Use normalized key matching so aliases like "bedrock" / "aws-bedrock" are found.
        let modelName: string | undefined;
        let providerBaseUrl: string | undefined;
        const providers = config?.models?.providers;
        if (providers) {
          for (const [key, value] of Object.entries(providers)) {
            if (normalizeProviderId(key) !== PROVIDER_ID) {
              continue;
            }
            const typedValue = value as {
              baseUrl?: string;
              models?: Array<{ id?: string; name?: string }>;
            };
            if (!providerBaseUrl && typedValue.baseUrl) {
              providerBaseUrl = typedValue.baseUrl;
            }
            const modelDef = typedValue.models?.find((m) => m.id === modelId);
            if (modelDef?.name) {
              modelName = modelDef.name;
              break;
            }
          }
        }

        // Extract region from provider baseUrl or bedrockDiscovery config so the
        // pi-ai BedrockRuntimeClient uses the correct endpoint. Without this, the
        // gateway process (which may not inherit AWS_REGION) falls back to us-east-1
        // and rejects cross-region inference profile IDs like "eu.anthropic.claude-*".
        const region =
          config?.models?.bedrockDiscovery?.region ?? extractRegionFromBaseUrl(providerBaseUrl);

        const baseFn = isAnthropicBedrockModel(modelId, modelName)
          ? streamFn
          : createBedrockNoCacheWrapper(streamFn);

        if (!region) {
          return baseFn;
        }

        // Wrap to inject the region into every stream call.
        const underlying = baseFn ?? streamFn;
        if (!underlying) {
          return baseFn;
        }
        return (model, context, options) => {
          // pi-ai's bedrock provider reads `options.region` at runtime but the
          // StreamFn type does not declare it. Merge via Object.assign to avoid
          // an unsafe type assertion.
          const merged = Object.assign({}, options, { region });
          return underlying(model, context, merged);
        };
      },
      resolveDefaultThinkingLevel: ({ modelId }) =>
        CLAUDE_46_MODEL_RE.test(modelId.trim()) ? "adaptive" : undefined,
    });
  },
});
