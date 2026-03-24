import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock sleepWithAbort so tests don't wait real delays, and log.warn for observability checks.
const { sleepWithAbortMock, logWarnMock, resolveFailoverReasonMock } = vi.hoisted(() => ({
  sleepWithAbortMock: vi.fn(async (_ms: number, _signal?: AbortSignal) => {}),
  logWarnMock: vi.fn(),
  resolveFailoverReasonMock: vi.fn((err: unknown): string | null => {
    if (!err || typeof err !== "object") {
      return null;
    }
    const obj = err as Record<string, unknown>;
    // Simulate real resolveFailoverReasonFromError behavior for test error shapes.
    if (obj.status === 429 || obj.statusCode === 429 || obj.statusCode === "429") {
      return "rate_limit";
    }
    if (
      obj.response &&
      typeof obj.response === "object" &&
      (obj.response as Record<string, unknown>).status === 429
    ) {
      return "rate_limit";
    }
    if (obj.status === 503) {
      return "overloaded";
    }
    if (obj.status === 401) {
      return "auth";
    }
    if (obj.status === 500) {
      return null;
    }
    // Symbolic codes (check both .code and non-numeric .status, matching readDirectErrorCode)
    const rawCode =
      typeof obj.code === "string"
        ? obj.code
        : typeof obj.status === "string" && !/^\d+$/.test(obj.status)
          ? obj.status
          : "";
    const code = rawCode.toUpperCase();
    if (["RESOURCE_EXHAUSTED", "THROTTLING", "THROTTLINGEXCEPTION"].includes(code)) {
      return "rate_limit";
    }
    // Cause chain
    const cause = obj.cause;
    if (cause && typeof cause === "object" && cause !== err) {
      return resolveFailoverReasonMock(cause);
    }
    // Message heuristic
    const msg = obj.message ?? (err instanceof Error ? err.message : "");
    if (typeof msg === "string" && /too many requests|rate.limit/i.test(msg)) {
      return "rate_limit";
    }
    return null;
  }),
}));
vi.mock("./logger.js", () => ({
  log: { warn: (...args: unknown[]) => logWarnMock(...args) },
}));
vi.mock("../../infra/backoff.js", () => ({
  computeBackoff: (
    policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
    attempt: number,
  ) => {
    const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
    const jitter = base * policy.jitter * Math.random();
    return Math.min(policy.maxMs, Math.round(base + jitter));
  },
  sleepWithAbort: (ms: number, signal?: AbortSignal) => sleepWithAbortMock(ms, signal),
}));
vi.mock("../failover-error.js", () => ({
  resolveFailoverReasonFromError: (err: unknown) => resolveFailoverReasonMock(err),
}));

import { createRateLimitRetryStreamWrapper } from "./rate-limit-retry-stream-wrapper.js";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
} as Model<"openai-completions">;

const context: Context = { messages: [] };

function make429Error(extra?: Record<string, unknown>): Error & { status: number } {
  return Object.assign(new Error("Too Many Requests"), { status: 429, ...extra });
}

function makeStreamFn(results: Array<() => ReturnType<StreamFn>>): StreamFn {
  let call = 0;
  return vi.fn(() => results[call++]()) as StreamFn;
}

describe("createRateLimitRetryStreamWrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sleepWithAbortMock.mockClear();
    logWarnMock.mockClear();
    resolveFailoverReasonMock.mockClear();
  });

  it("passes through on success without retrying", async () => {
    const inner = makeStreamFn([() => createAssistantMessageEventStream()]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    const inner = makeStreamFn([
      () => Promise.reject(make429Error()) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("retries up to 3 times then throws", async () => {
    const error = make429Error();
    const reject = () => Promise.reject(error) as unknown as ReturnType<StreamFn>;
    const inner = makeStreamFn([reject, reject, reject, reject]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    // 1 initial + 3 retries = 4 calls
    expect(inner).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
  });

  it("retries when 429 is nested at err.response.status", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      response: { status: 429 },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("retries when 429 is provided as string statusCode", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      statusCode: "429",
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    const error = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("honors delta-seconds Retry-After header over backoff", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "retry-after": "5" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(5_000, undefined);
  });

  it("honors HTTP-date Retry-After header over backoff", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-11T15:00:00.000Z");
    vi.setSystemTime(now);
    const retryAt = new Date("2026-03-11T15:00:10.000Z"); // 10s in the future
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: { "retry-after": retryAt.toUTCString() },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(10_000, undefined);
    vi.useRealTimers();
  });

  it("reads Retry-After from err.response.headers (Axios-style)", async () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      response: { status: 429, headers: { "retry-after": "7" } },
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(7_000, undefined);
  });

  it("reads Retry-After from Headers instance", async () => {
    const headers = new Headers();
    headers.set("retry-after", "3");
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers,
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(3_000, undefined);
  });

  it("caps excessively large Retry-After at MAX_RETRY_AFTER_MS", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "retry-after": "86400" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(30_000, undefined);
  });

  it("preserves error properties needed by run-loop failover classification", async () => {
    const headers = { "retry-after": "2" };
    const error = make429Error({ headers });
    const reject = () => Promise.reject(error) as unknown as ReturnType<StreamFn>;
    const inner = makeStreamFn([reject, reject, reject, reject]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    const thrown = await Promise.resolve(wrapped(model, context, {})).catch((e: unknown) => e);
    // Exact reference preserved — no wrapping or mutation
    expect(thrown).toBe(error);
    // Run loop classifies via message text (ERROR_PATTERNS.rateLimit = /too many requests/)
    // and HTTP status (classifyFailoverReasonFromHttpStatus(429) → "rate_limit")
    expect((thrown as Error).message).toBe("Too Many Requests");
    expect((thrown as { status: number }).status).toBe(429);
    expect((thrown as { headers: unknown }).headers).toBe(headers);
  });

  it("preserves abort reason when sleep is interrupted (sessions_yield)", async () => {
    const controller = new AbortController();
    const error = make429Error();
    // Simulate: sleep starts, then abort fires mid-sleep
    sleepWithAbortMock.mockImplementationOnce(async () => {
      controller.abort("sessions_yield");
      throw new Error("aborted", { cause: new DOMException("signal is aborted", "AbortError") });
    });
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner, controller.signal);
    const thrown = await Promise.resolve(wrapped(model, context, {})).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    // The run loop checks err.cause === "sessions_yield" for yield detection
    expect((thrown as Error).cause).toBe("sessions_yield");
  });

  it("reads Retry-After from Title-Case plain object key", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "Retry-After": "6" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(6_000, undefined);
  });

  it("reads Retry-After from uppercase plain object key", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "RETRY-AFTER": "4" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(sleepWithAbortMock).toHaveBeenCalledWith(4_000, undefined);
  });

  it("floors Retry-After: 0 at backoffMs to avoid tight retry loops", async () => {
    const inner = makeStreamFn([
      () =>
        Promise.reject(
          make429Error({ headers: { "retry-after": "0" } }),
        ) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    // backoffMs for attempt 1 = initialMs * factor^0 = 1000 (plus jitter, but min is 1000)
    const [delayMs] = sleepWithAbortMock.mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThanOrEqual(1_000);
  });

  it("logs a warning on each retry and on exhaustion", async () => {
    const error = make429Error();
    const reject = () => Promise.reject(error) as unknown as ReturnType<StreamFn>;
    const inner = makeStreamFn([reject, reject, reject, reject]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    // 3 retry warnings + 1 exhaustion warning
    expect(logWarnMock).toHaveBeenCalledTimes(4);
    expect(logWarnMock.mock.calls[0][0]).toMatch(/rate-limit from.*retry 1\/3/);
    expect(logWarnMock.mock.calls[3][0]).toMatch(/exhausted 3\/3/);
  });

  it("does not retry when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = make429Error();
    const inner = makeStreamFn([() => Promise.reject(error) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner, controller.signal);
    await expect(wrapped(model, context, {})).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  // --- Unified detection: symbolic codes, cause chains, message heuristics ---

  it("retries on RESOURCE_EXHAUSTED symbolic code (Gemini)", async () => {
    const err = Object.assign(new Error("Resource has been exhausted"), {
      code: "RESOURCE_EXHAUSTED",
    });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("retries on RESOURCE_EXHAUSTED wrapped in AbortError (Gemini cause chain)", async () => {
    const cause = Object.assign(new Error("Resource has been exhausted"), {
      status: "RESOURCE_EXHAUSTED",
    });
    const err = new DOMException("signal is aborted", "AbortError");
    Object.defineProperty(err, "cause", { value: cause, writable: false });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("retries on THROTTLING symbolic code (AWS Bedrock)", async () => {
    const err = Object.assign(new Error("Rate exceeded"), { code: "THROTTLING" });
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("retries on message-based rate limit without 429 status", async () => {
    const err = new Error("too many requests, please slow down");
    const inner = makeStreamFn([
      () => Promise.reject(err) as unknown as ReturnType<StreamFn>,
      () => createAssistantMessageEventStream(),
    ]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await wrapped(model, context, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 503 overloaded errors", async () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const inner = makeStreamFn([() => Promise.reject(err) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(err);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401 auth errors", async () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    const inner = makeStreamFn([() => Promise.reject(err) as unknown as ReturnType<StreamFn>]);
    const wrapped = createRateLimitRetryStreamWrapper(inner);
    await expect(wrapped(model, context, {})).rejects.toBe(err);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
