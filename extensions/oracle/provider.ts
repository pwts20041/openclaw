import { ConfigFileAuthenticationDetailsProvider } from "oci-common";
import { GenerativeAiClient } from "oci-generativeai";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ProviderCatalogContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-models";
import {
  buildOracleRuntimeAuthToken,
  ORACLE_PROFILE_ID,
  ORACLE_PROVIDER_ID,
  resolveOracleAuth,
} from "./oci-auth.js";

const ORACLE_BASE_URL = "oci://generative-ai";

type OracleModelSummary = {
  id?: string;
  displayName?: string;
  vendor?: string;
  version?: string;
  lifecycleState?: string;
  type?: string;
  capabilities?: string[];
};

type OracleListModelsResponse = {
  modelCollection?: {
    items?: OracleModelSummary[];
  };
};

type OracleCatalogProvider = {
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  models: ModelDefinitionConfig[];
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOracleVendorToken(vendor: unknown): string | undefined {
  const trimmed = trimToUndefined(vendor);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function isOracleFriendlyModelRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim());
}

function appendOracleModelVersion(name: string, version: string | undefined): string {
  const trimmedVersion = trimToUndefined(version);
  if (!trimmedVersion) {
    return name;
  }
  return name.toLowerCase().includes(trimmedVersion.toLowerCase())
    ? name
    : `${name} ${trimmedVersion}`;
}

export function buildOracleCatalogModelId(model: OracleModelSummary): string {
  const rawId = trimToUndefined(model.id);
  if (!rawId) {
    return "";
  }

  const displayName = trimToUndefined(model.displayName);
  if (!displayName || !isOracleFriendlyModelRef(displayName)) {
    return rawId;
  }

  const normalizedDisplayName = displayName.toLowerCase();
  const vendorToken = normalizeOracleVendorToken(model.vendor);
  if (!vendorToken) {
    return normalizedDisplayName;
  }
  if (
    normalizedDisplayName.startsWith(`${vendorToken}.`) ||
    normalizedDisplayName.startsWith(`${vendorToken}-`)
  ) {
    return normalizedDisplayName;
  }
  if (normalizedDisplayName.includes(".")) {
    return normalizedDisplayName;
  }
  return `${vendorToken}.${normalizedDisplayName}`;
}

function buildOracleModelName(model: OracleModelSummary): string {
  const catalogModelId = buildOracleCatalogModelId(model);
  const rawId = trimToUndefined(model.id);
  if (catalogModelId && catalogModelId !== rawId) {
    return appendOracleModelVersion(catalogModelId, model.version);
  }

  const displayName = trimToUndefined(model.displayName);
  if (displayName) {
    return appendOracleModelVersion(displayName, model.version);
  }
  const fallback = [
    trimToUndefined(model.vendor),
    trimToUndefined(model.version),
    trimToUndefined(model.id),
  ]
    .filter(Boolean)
    .join(" ");
  return fallback || "Oracle model";
}

export function buildOracleModelDefinition(modelId: string, name = modelId): ModelDefinitionConfig {
  return {
    id: modelId,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

function buildOracleRuntimeModel(modelId: string, name = modelId): ProviderRuntimeModel {
  const definition = buildOracleModelDefinition(modelId, name);
  return normalizeModelCompat({
    ...definition,
    api: "openai-completions",
    provider: ORACLE_PROVIDER_ID,
    baseUrl: ORACLE_BASE_URL,
  } as ProviderRuntimeModel);
}

export function buildOracleCatalogModelDefinition(
  model: OracleModelSummary,
): ModelDefinitionConfig {
  return buildOracleModelDefinition(buildOracleCatalogModelId(model), buildOracleModelName(model));
}

function isOracleChatBaseModel(model: OracleModelSummary): boolean {
  return (
    trimToUndefined(model.id) !== undefined &&
    model.lifecycleState === "ACTIVE" &&
    model.type === "BASE" &&
    Array.isArray(model.capabilities) &&
    model.capabilities.includes("CHAT")
  );
}

function loadOracleProfileMetadata(
  agentDir?: string,
  profileId = ORACLE_PROFILE_ID,
): Record<string, string> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const profile = store.profiles[profileId];
  return profile?.type === "api_key" ? (profile.metadata ?? {}) : {};
}

async function listOracleModels(configFile: string, profile: string, compartmentId: string) {
  const authenticationDetailsProvider = new ConfigFileAuthenticationDetailsProvider(
    configFile,
    profile,
  );
  const client = new GenerativeAiClient({ authenticationDetailsProvider });
  try {
    const response = (await client.listModels({
      compartmentId,
    })) as OracleListModelsResponse;
    return response.modelCollection?.items ?? [];
  } finally {
    try {
      client.close();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export async function resolveOracleCatalogProvider(
  ctx: ProviderCatalogContext,
): Promise<{ provider: OracleCatalogProvider } | null> {
  const resolvedAuth = ctx.resolveProviderAuth(ORACLE_PROVIDER_ID);
  const storedMetadata = loadOracleProfileMetadata(
    ctx.agentDir,
    resolvedAuth.profileId ?? ORACLE_PROFILE_ID,
  );
  const configFile = resolvedAuth.apiKey ?? trimToUndefined(ctx.env.OCI_CONFIG_FILE);
  if (!configFile) {
    return null;
  }

  const auth = resolveOracleAuth({
    agentDir: ctx.agentDir,
    env: ctx.env,
    configFile,
    profile: storedMetadata.profile,
    compartmentId: storedMetadata.compartmentId,
    profileId: resolvedAuth.profileId ?? ORACLE_PROFILE_ID,
  });

  const models = (await listOracleModels(auth.configFile, auth.profile, auth.compartmentId))
    .filter((model) => isOracleChatBaseModel(model))
    .map((model) => buildOracleCatalogModelDefinition(model))
    .toSorted((left, right) => left.name.localeCompare(right.name));

  if (models.length === 0) {
    return null;
  }

  return {
    provider: {
      baseUrl: ORACLE_BASE_URL,
      api: "openai-completions",
      apiKey: auth.configFile,
      models,
    },
  };
}

export function resolveOracleDynamicModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const modelId = ctx.modelId.trim();
  return modelId ? buildOracleRuntimeModel(modelId) : undefined;
}

export async function prepareOracleRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext) {
  const storedMetadata = loadOracleProfileMetadata(
    ctx.agentDir,
    ctx.profileId ?? ORACLE_PROFILE_ID,
  );
  const auth = resolveOracleAuth({
    agentDir: ctx.agentDir,
    env: ctx.env,
    configFile: ctx.apiKey,
    profile: storedMetadata.profile,
    compartmentId: storedMetadata.compartmentId,
    profileId: ctx.profileId ?? ORACLE_PROFILE_ID,
  });

  return {
    apiKey: buildOracleRuntimeAuthToken(auth),
  };
}
