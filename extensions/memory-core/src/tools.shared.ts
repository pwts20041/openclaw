import { Type } from "@sinclair/typebox";
import {
  extractUserIdFromSessionKey,
  parseAgentSessionKey,
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

const VALID_PLATFORMS = new Set([
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "slack",
  "msteams",
  "webchat",
  "line",
  "kakaotalk",
  "zalo",
  "matrix",
  "mattermost",
  "irc",
  "feishu",
  "googlechat",
  "nextcloud-talk",
  "nostr",
  "synology-chat",
  "tlon",
  "twitch",
  "imessage",
]);

function extractPlatformFromSessionKey(sessionKey: string | undefined | null): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) return null;
  const tokens = parsed.rest.split(":").filter(Boolean);
  const firstToken = tokens[0];
  if (!firstToken) return null;
  const baseName = firstToken.replace(/-dev$/, "");
  if (VALID_PLATFORMS.has(baseName)) return firstToken;
  return null;
}

function addPlatformPrefixToSenderId(params: {
  senderId: string | undefined | null;
  sessionKey: string | undefined | null;
}): string | undefined {
  const { senderId, sessionKey } = params;
  if (!senderId) return undefined;
  const prefixMatch = senderId.match(/^([a-z0-9-]+):(.+)$/i);
  if (prefixMatch) {
    const [, prefix, id] = prefixMatch;
    const baseName = prefix.replace(/-dev$/, "");
    if (VALID_PLATFORMS.has(baseName.toLowerCase())) return senderId;
    return id ? `${prefix.toLowerCase()}:${id}` : senderId;
  }
  const platform = extractPlatformFromSessionKey(sessionKey);
  if (platform) return `${platform}:${senderId}`;
  return senderId;
}

type MemoryToolRuntime = typeof import("./tools.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

export async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./tools.runtime.js");
  return await memoryToolRuntimePromise;
}

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function resolveMemoryToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  senderId?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  const rawUserId = extractUserIdFromSessionKey(options.agentSessionKey);
  const userId = rawUserId
    ? addPlatformPrefixToSenderId({
        senderId: rawUserId,
        sessionKey: options.agentSessionKey,
      })
    : options.senderId
      ? addPlatformPrefixToSenderId({
          senderId: options.senderId,
          sessionKey: options.agentSessionKey,
        })
      : undefined;
  return { cfg, agentId, userId };
}

export async function getMemoryManagerContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userId?: string;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  return await getMemoryManagerContextWithPurpose({ ...params, purpose: undefined });
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userId?: string;
  purpose?: "default" | "status";
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    userId: params.userId,
    purpose: params.purpose,
  });
  return manager ? { manager } : { error };
}

export function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    senderId?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: {
    cfg: OpenClawConfig;
    agentId: string;
    userId?: string;
  }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

export function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}
