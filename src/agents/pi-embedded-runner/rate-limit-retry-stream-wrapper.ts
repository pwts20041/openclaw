import type { StreamFn } from "@mariozechner/pi-agent-core";
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

/**
 * Extract the raw `retry-after` string from a headers-like object.
 *
 * Handles plain objects (`{ "retry-after": "5" }`) and `Headers` instances
 * (which require `.get("retry-after")`). Plain-object keys are matched
 * case-insensitively so Title-Case ("Retry-After") and uppercase
 * ("RETRY-AFTER") variants from Axios and other SDKs are also found.
 */
function getRetryAfterRaw(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  // Headers instance (Fetch API / SDK wrappers) — .get() normalizes case.
  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get(name: string): string | null }).get("retry-after");
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  // Plain record — iterate entries to match case-insensitively.
  for (const [key, val] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === "retry-after" && typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * Parse the `Retry-After` header value from an error, if present.
 *
 * Checks `err.headers` (Anthropic/OpenAI SDK) and `err.response.headers`
 * (Axios-style wrappers). Supports both delta-seconds (`Retry-After: 5`)
 * and HTTP-date (`Retry-After: Sun, 09 Mar 2026 15:00:10 GMT`) per
 * RFC 7231 §7.1.3.
 *
 * Returns the delay in milliseconds, or `undefined` if absent/unparseable.
 */
function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const obj = err as Record<string, unknown>;
  // Try err.headers first, then err.response.headers (Axios-style).
  const raw =
    getRetryAfterRaw(obj.headers) ??
    getRetryAfterRaw(
      obj.response && typeof obj.response === "object"
        ? (obj.response as Record<string, unknown>).headers
        : undefined,
    );
  if (raw) {
    // Try delta-seconds first (most common).
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    // Try HTTP-date.
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      const delta = date.getTime() - Date.now();
      return delta > 0 ? delta : 0;
    }
  }
  // Walk cause chain for wrapped errors (e.g. AbortError wrapping a 429).
  const cause = obj.cause;
  if (cause && typeof cause === "object" && cause !== err) {
    return parseRetryAfterMs(cause);
  }
  return undefined;
}

/**
 * Wrap a `StreamFn` to transparently retry on rate-limit errors thrown during
 * stream establishment.
 *
 * Rate-limit detection delegates to `resolveFailoverReasonFromError` from
 * `failover-error.ts`, so the retry boundary recognizes the same error shapes
 * as the run-loop failover path: HTTP 429, symbolic codes (RESOURCE_EXHAUSTED,
 * THROTTLING, etc.), message-based heuristics, and nested cause chains.
 *
 * Applied to **all** providers at the stream-call boundary in `attempt.ts`.
 * Retries up to `MAX_RETRIES` times with exponential backoff, honoring the
 * `Retry-After` header when present.
 *
 * Known limitation: rate-limit errors that arrive mid-stream (as errors during
 * EventStream iteration, after the initial connection succeeds) are not caught
 * here — those are consumed by the agent loop in pi-agent-core.
 */
export function createRateLimitRetryStreamWrapper(
  baseStreamFn: StreamFn,
  abortSignal?: AbortSignal,
): StreamFn {
  return (model, context, options) => {
    const attempt = async (retryCount: number): Promise<Awaited<ReturnType<StreamFn>>> => {
      try {
        const result = baseStreamFn(model, context, options);
        // StreamFn can return either sync (EventStream) or async (Promise<EventStream>).
        return await result;
      } catch (err) {
        if (resolveFailoverReasonFromError(err) !== "rate_limit" || retryCount >= MAX_RETRIES) {
          if (retryCount > 0) {
            log.warn(
              `[rate-limit-retry] exhausted ${retryCount}/${MAX_RETRIES} retries for ${model.provider}/${model.id}`,
            );
          }
          throw err;
        }
        if (abortSignal?.aborted) {
          throw err;
        }
        const retryAfterMs = parseRetryAfterMs(err);
        const backoffMs = computeBackoff(RATE_LIMIT_RETRY_POLICY, retryCount + 1);
        // Use server-provided Retry-After when present, floored at backoffMs to
        // avoid zero-delay tight loops when the server sends Retry-After: 0.
        // Cap at MAX_RETRY_AFTER_MS to prevent unbounded blocking.
        const delayMs =
          retryAfterMs != null
            ? Math.min(Math.max(retryAfterMs, backoffMs), MAX_RETRY_AFTER_MS)
            : backoffMs;
        log.warn(
          `[rate-limit-retry] rate-limit from ${model.provider}/${model.id}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delayMs}ms`,
        );
        try {
          await sleepWithAbort(delayMs, abortSignal);
        } catch (sleepErr) {
          // Preserve the abort reason (e.g. "sessions_yield") so the run loop
          // can detect yield aborts via `err.cause === "sessions_yield"`.
          // sleepWithAbort wraps the AbortError, losing signal.reason as cause.
          if (abortSignal?.aborted) {
            // oxlint-disable-next-line preserve-caught-error -- intentional: propagate signal.reason, not sleepErr
            throw new Error("aborted", { cause: abortSignal.reason as unknown });
          }
          throw sleepErr;
        }
        return attempt(retryCount + 1);
      }
    };
    return attempt(0);
  };
}
