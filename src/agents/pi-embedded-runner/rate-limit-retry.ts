import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { log } from "./logger.js";

const RATE_LIMIT_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

export interface PromptRetryContext {
  prompt: () => Promise<void>;
  classifyTerminalFailure: () => { isRateLimit: boolean; rawError: unknown } | null;
  isReplaySafe: () => boolean;
  rewind: () => void;
  abortSignal?: AbortSignal;
  provider: string;
  modelId: string;
}

function getRetryAfterRaw(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get("retry-after");
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "retry-after" && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const obj = err as Record<string, unknown>;
  const raw =
    getRetryAfterRaw(obj.headers) ??
    getRetryAfterRaw(
      obj.response && typeof obj.response === "object"
        ? (obj.response as Record<string, unknown>).headers
        : undefined,
    );

  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      const delta = date.getTime() - Date.now();
      return delta > 0 ? delta : 0;
    }
  }

  const cause = obj.cause;
  if (cause && typeof cause === "object" && cause !== err) {
    return parseRetryAfterMs(cause);
  }
  return undefined;
}

async function sleepWithAbortReason(delayMs: number, abortSignal?: AbortSignal) {
  try {
    await sleepWithAbort(delayMs, abortSignal);
  } catch (err) {
    if (abortSignal?.aborted) {
      // oxlint-disable-next-line preserve-caught-error -- intentional: propagate signal.reason for yield detection
      throw new Error("aborted", { cause: abortSignal.reason as unknown });
    }
    throw err;
  }
}

export async function retryPromptOnRateLimit(ctx: PromptRetryContext): Promise<void> {
  let retryCount = 0;

  while (true) {
    let didThrow = false;
    let thrownError: unknown;

    try {
      await ctx.prompt();
    } catch (err) {
      didThrow = true;
      thrownError = err;
    }

    const terminalFailure = didThrow ? null : ctx.classifyTerminalFailure();
    const isRateLimit = didThrow
      ? resolveFailoverReasonFromError(thrownError) === "rate_limit"
      : (terminalFailure?.isRateLimit ?? false);

    if (!isRateLimit) {
      if (didThrow) {
        throw thrownError;
      }
      return;
    }

    if (retryCount >= MAX_RETRIES || ctx.abortSignal?.aborted || !ctx.isReplaySafe()) {
      if (retryCount >= MAX_RETRIES && retryCount > 0) {
        log.warn(
          `[rate-limit-retry] exhausted ${retryCount}/${MAX_RETRIES} retries for ${ctx.provider}/${ctx.modelId}`,
        );
      }
      if (didThrow) {
        throw thrownError;
      }
      return;
    }

    retryCount += 1;
    ctx.rewind();

    const retryAfterMs = parseRetryAfterMs(didThrow ? thrownError : terminalFailure?.rawError);
    const backoffMs = computeBackoff(RATE_LIMIT_RETRY_POLICY, retryCount);
    const delayMs = Math.min(Math.max(retryAfterMs ?? 0, backoffMs), MAX_RETRY_AFTER_MS);

    log.warn(
      `[rate-limit-retry] rate-limit from ${ctx.provider}/${ctx.modelId}, retry ${retryCount}/${MAX_RETRIES} in ${delayMs}ms`,
    );
    await sleepWithAbortReason(delayMs, ctx.abortSignal);
  }
}
