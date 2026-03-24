import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("deepinfra-models");

/** DeepInfra OpenAI-compatible API base URL. */
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai/";

export const DEEPINFRA_DEFAULT_MODEL_ID = "zai-org/GLM-5";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

/** Default context window and max tokens for discovered models. */
const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

/**
 * Static catalog of popular DeepInfra models.
 * Used as a fallback when discovery is unavailable.
 */
export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "zai-org/GLM-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 202752,
    cost: {
      input: 0.8,
      output: 2.56,
      cacheRead: 0.16,
      cacheWrite: 0,
    },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 196608,
    cost: {
      input: 0.27,
      output: 0.95,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "gpt-oss-120b",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 131072,
    cost: {
      input: 0.039,
      output: 0.19,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: {
      input: 0.45,
      output: 2.25,
      cacheRead: 0.07,
      cacheWrite: 0,
    },
  },
];

export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}models`;

const DISCOVERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// API response types (DeepInfra OpenAI-compatible /models schema)
// ---------------------------------------------------------------------------

interface DeepInfraModelPricing {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface DeepInfraModelMetadata {
  description?: string;
  context_length?: number;
  max_tokens?: number;
  pricing?: DeepInfraModelPricing;
  /** e.g. ["vision", "reasoning_effort", "prompt_cache", "reasoning"] */
  tags?: string[];
}

interface DeepInfraModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  metadata: DeepInfraModelMetadata | null;
}

interface DeepInfraModelsResponse {
  data: DeepInfraModelEntry[];
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModality(metadata: DeepInfraModelMetadata): Array<"text" | "image"> {
  const hasVision = metadata.tags?.includes("vision") ?? false;
  return hasVision ? ["text", "image"] : ["text"];
}

function parseReasoning(metadata: DeepInfraModelMetadata): boolean {
  return (
    (metadata.tags?.includes("reasoning_effort") || metadata.tags?.includes("reasoning")) ?? false
  );
}

function toModelDefinition(entry: DeepInfraModelEntry): ModelDefinitionConfig {
  const meta = entry.metadata!;
  return {
    id: entry.id,
    name: entry.id,
    reasoning: parseReasoning(meta),
    input: parseModality(meta),
    cost: {
      input: meta.pricing?.input_tokens ?? 0,
      output: meta.pricing?.output_tokens ?? 0,
      cacheRead: meta.pricing?.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
    contextWindow: meta.context_length ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: meta.max_tokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from the DeepInfra API with fallback to static catalog.
 * Skips models with null metadata (embeddings, image-gen, etc.).
 *
 * When discovery succeeds, only discovered models are returned (no merge
 * with the static catalog). The API is the single source of truth.
 */
export async function discoverDeepInfraModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return [...DEEPINFRA_MODEL_CATALOG];
  }

  try {
    const response = await fetch(DEEPINFRA_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return [...DEEPINFRA_MODEL_CATALOG];
    }

    const data = (await response.json()) as DeepInfraModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from DeepInfra API, using static catalog");
      return [...DEEPINFRA_MODEL_CATALOG];
    }

    const models: ModelDefinitionConfig[] = [];
    const discoveredIds = new Set<string>();

    for (const entry of data.data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id || discoveredIds.has(id)) {
        continue;
      }
      // Skip non-completion models (embeddings, image-gen, etc.)
      if (!entry.metadata) {
        continue;
      }
      try {
        models.push(toModelDefinition(entry));
        discoveredIds.add(id);
      } catch (e) {
        log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
      }
    }

    return models.length > 0 ? models : [...DEEPINFRA_MODEL_CATALOG];
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return [...DEEPINFRA_MODEL_CATALOG];
  }
}
