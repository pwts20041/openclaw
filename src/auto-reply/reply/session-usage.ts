import { setCliSessionId } from "../../agents/cli-session.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

function applyCliSessionIdToSessionPatch(
  params: {
    providerUsed?: string;
    cliSessionId?: string;
  },
  entry: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (params.cliSessionId && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  return patch;
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function estimateSessionRunCostUsd(params: {
  cfg: OpenClawConfig;
  usage?: NormalizedUsage;
  providerUsed?: string;
  modelUsed?: string;
}): number | undefined {
  if (!hasNonzeroUsage(params.usage)) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.providerUsed,
    model: params.modelUsed,
    config: params.cfg,
  });
  return resolveNonNegativeNumber(estimateUsageCost({ usage: params.usage, cost }));
}

export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). When provided,
   * this is used for `totalTokens` instead of the accumulated `usage` so that
   * context-window utilization reflects the actual current context size rather
   * than the sum of input tokens across all API calls in the run.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  promptTokens?: number;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  logLabel?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const cfg = params.cfg ?? loadConfig();
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasFreshContextSnapshot =
    hasNonzeroUsage(params.lastCallUsage) ||
    (typeof params.promptTokens === "number" && params.promptTokens > 0);
  if (
    hasUsage ||
    hasFreshContextSnapshot ||
    (typeof params.promptTokens === "number" && params.promptTokens >= 0)
  ) {
    try {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async (entry) => {
          const resolvedContextTokens = params.contextTokensUsed ?? entry.contextTokens;
          // Use last-call usage for totalTokens when available. The accumulated
          // `usage.input` sums input tokens from every API call in the run
          // (tool-use loops, compaction retries), overstating actual context.
          // `lastCallUsage` reflects only the final API call — the true context.
          const usageForContext = params.lastCallUsage ?? (hasUsage ? params.usage : undefined);
          const totalTokens = hasFreshContextSnapshot
            ? deriveSessionTotalTokens({
                usage: usageForContext,
                contextTokens: resolvedContextTokens,
                promptTokens: params.promptTokens,
              })
            : undefined;
          const runEstimatedCostUsd = estimateSessionRunCostUsd({
            cfg,
            usage: params.usage,
            providerUsed: params.providerUsed ?? entry.modelProvider,
            modelUsed: params.modelUsed ?? entry.model,
          });
          const existingEstimatedCostUsd = resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0;

          const modelUsed = params.modelUsed ?? entry.model;
          const providerUsed = params.providerUsed ?? entry.modelProvider;
          const modelChanged =
            (entry.model !== undefined && entry.model !== modelUsed) ||
            (entry.modelProvider !== undefined && entry.modelProvider !== providerUsed);

          const patch: Partial<SessionEntry> = {
            modelProvider: providerUsed,
            model: modelUsed,
            contextTokens: resolvedContextTokens,
            systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
            updatedAt: Date.now(),
          };

          const prevEstimate = entry.totalTokensEstimate;
          const prevTotal = entry.totalTokens;
          const prevWasZero = prevEstimate === 0 || (prevEstimate === undefined && prevTotal === 0);

          if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens >= 0) {
            patch.totalTokens = totalTokens;
            patch.totalTokensFresh = totalTokens > 0 || hasFreshContextSnapshot || prevWasZero;

            if (modelChanged) {
              patch.totalTokensEstimate = undefined;
            } else {
              if (totalTokens > 0 || (totalTokens === 0 && patch.totalTokensFresh)) {
                patch.totalTokensEstimate = totalTokens;
              }
              if (totalTokens === 0 && !patch.totalTokensFresh) {
                const fallback = prevEstimate ?? prevTotal;
                if (fallback !== undefined && fallback > 0) {
                  patch.totalTokensEstimate = fallback;
                }
              }
            }
          } else {
            patch.totalTokens = undefined;
            patch.totalTokensFresh = false;
          }

          const hasCurrentUsage =
            hasUsage ||
            Boolean(params.lastCallUsage) ||
            (typeof params.promptTokens === "number" && params.promptTokens >= 0);

          if (hasCurrentUsage || hasFreshContextSnapshot) {
            patch.inputTokens = params.usage?.input;
            patch.outputTokens = params.usage?.output;
            // Cache counters should reflect the latest context snapshot when
            // available, not accumulated per-call totals across a whole run.
            const cacheUsage = params.lastCallUsage ?? params.usage;
            patch.cacheRead = cacheUsage?.cacheRead;
            patch.cacheWrite = cacheUsage?.cacheWrite;
          }
          if (runEstimatedCostUsd !== undefined) {
            patch.estimatedCostUsd = existingEstimatedCostUsd + runEstimatedCostUsd;
          } else if (entry.estimatedCostUsd !== undefined) {
            patch.estimatedCostUsd = entry.estimatedCostUsd;
          }

          return applyCliSessionIdToSessionPatch(params, entry, patch);
        },
      });
    } catch (err) {
      logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
    }
    return;
  }

  if (!params.modelUsed && !params.contextTokensUsed) {
    return;
  }

  // A run completed with model/context info but no usage data at all (e.g.
  // because the provider failed or the run was aborted before any API calls
  // were made). Clear usage but preserve model/context if provided.
  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        const modelUsed = params.modelUsed ?? entry.model;
        const providerUsed = params.providerUsed ?? entry.modelProvider;
        const modelChanged =
          (entry.model !== undefined && entry.model !== modelUsed) ||
          (entry.modelProvider !== undefined && entry.modelProvider !== providerUsed);

        const patch: Partial<SessionEntry> = {
          modelProvider: providerUsed,
          model: modelUsed,
          contextTokens: params.contextTokensUsed ?? entry.contextTokens,
          systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          totalTokensFresh: false,
          cacheRead: undefined,
          cacheWrite: undefined,
          updatedAt: Date.now(),
        };

        if (modelChanged) {
          patch.totalTokensEstimate = undefined;
        } else if (entry.totalTokensEstimate !== undefined) {
          patch.totalTokensEstimate = entry.totalTokensEstimate;
        } else if (entry.totalTokens !== undefined && entry.totalTokensFresh !== false) {
          // Refresh or backfill estimate baseline from the last known fresh total.
          patch.totalTokensEstimate = entry.totalTokens;
        }

        return applyCliSessionIdToSessionPatch(params, entry, patch);
      },
    });
  } catch (err) {
    logVerbose(`failed to clear ${label}usage update: ${String(err)}`);
  }
}
