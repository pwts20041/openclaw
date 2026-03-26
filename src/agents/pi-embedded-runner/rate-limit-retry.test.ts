import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import type { PromptRetryContext } from "./rate-limit-retry.js";
const computeBackoffMock = vi.fn((_attempt: number) => 1_000);
const sleepWithAbortMock = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);

import { parseRetryAfterMs, retryPromptOnRateLimit } from "./rate-limit-retry.js";

function make429Error(extra?: Record<string, unknown>): Error & { status: number } {
  return Object.assign(new Error("Too Many Requests"), { status: 429, ...extra });
}

function makeContext(overrides?: Partial<PromptRetryContext>): PromptRetryContext {
  return {
    prompt: async () => undefined,
    classifyTerminalFailure: () => null,
    isReplaySafe: () => true,
    rewind: () => undefined,
    provider: "test-provider",
    modelId: "test-model",
    computeBackoff: (attempt: number) => computeBackoffMock(attempt),
    sleepWithAbort: (delayMs: number, abortSignal?: AbortSignal) =>
      sleepWithAbortMock(delayMs, abortSignal),
    ...overrides,
  };
}

describe("retryPromptOnRateLimit", () => {
  beforeEach(() => {
    vi.useRealTimers();
    computeBackoffMock.mockClear();
    computeBackoffMock.mockImplementation((attempt: number) => attempt * 1_000);
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

  it("retries on a thrown rate limit and succeeds on the second prompt call", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error())
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, undefined);
  });

  it("exhausts 3 retries on persistent thrown rate limits and rethrows the original error", async () => {
    const error = make429Error({ headers: { "retry-after": "2" } });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(retryPromptOnRateLimit(makeContext({ prompt }))).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    Object.assign(new Error("Service Unavailable"), { status: 503 }),
    Object.assign(new Error("Unauthorized"), { status: 401 }),
  ])("does not retry non-rate-limit thrown errors", async (error) => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(retryPromptOnRateLimit(makeContext({ prompt }))).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("Resource has been exhausted"), { code: "RESOURCE_EXHAUSTED" }),
    new Error("wrapped abort", {
      cause: Object.assign(new Error("Resource exhausted"), { status: "RESOURCE_EXHAUSTED" }),
    }),
    Object.assign(new Error("Rate exceeded"), { code: "THROTTLING" }),
  ])("uses unified failover detection for wrapped rate-limit errors", async (error) => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("preserves thrown error properties on exhaustion for downstream failover handling", async () => {
    const headers = { "retry-after": "2" };
    const error = make429Error({ headers });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    const thrown = await Promise.resolve(retryPromptOnRateLimit(makeContext({ prompt }))).catch(
      (err: unknown) => err,
    );

    expect(thrown).toBe(error);
    expect((thrown as Error).message).toBe("Too Many Requests");
    expect((thrown as { status: number }).status).toBe(429);
    expect((thrown as { headers: unknown }).headers).toBe(headers);
  });

  it("retries terminal assistant rate limits and rewinds before replay", async () => {
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const rewind = vi.fn();
    const classifyTerminalFailure = vi.fn(() =>
      promptCalls === 1
        ? { isRateLimit: true, rawError: { headers: { "retry-after": "5" } } }
        : null,
    );

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(rewind.mock.invocationCallOrder[0]).toBeLessThan(
      sleepWithAbortMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(sleepWithAbortMock).toHaveBeenCalledWith(5_000, undefined);
  });

  it("calls rewind before each terminal retry", async () => {
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const rewind = vi.fn();
    const classifyTerminalFailure = vi.fn(() =>
      promptCalls <= 2 ? { isRateLimit: true, rawError: new Error("rate limit") } : null,
    );

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind }));

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(rewind).toHaveBeenCalledTimes(2);
  });

  it("does not retry terminal non-rate-limit errors", async () => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockResolvedValue(undefined);
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: false,
      rawError: new Error("bad request"),
    }));

    await expect(
      retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure })),
    ).resolves.toBeUndefined();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("returns normally when a terminal rate limit is not replay-safe", async () => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockResolvedValue(undefined);
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: true,
      rawError: new Error("rate limit"),
    }));
    const isReplaySafe = vi.fn(() => false);
    const rewind = vi.fn();

    await expect(
      retryPromptOnRateLimit(
        makeContext({ prompt, classifyTerminalFailure, isReplaySafe, rewind }),
      ),
    ).resolves.toBeUndefined();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(isReplaySafe).toHaveBeenCalledTimes(1);
    expect(rewind).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("evaluates replay safety fresh on each retry attempt", async () => {
    const firstError = make429Error();
    const secondError = make429Error();
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError);
    const isReplaySafe = vi
      .fn(() => true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(retryPromptOnRateLimit(makeContext({ prompt, isReplaySafe }))).rejects.toBe(
      secondError,
    );

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(isReplaySafe).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After over computed backoff", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error({ headers: { "retry-after": "6" } }))
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(sleepWithAbortMock).toHaveBeenCalledWith(6_000, undefined);
  });

  it("caps Retry-After delays at 30 seconds", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error({ headers: { "retry-after": "86400" } }))
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(sleepWithAbortMock).toHaveBeenCalledWith(30_000, undefined);
  });

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error())
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(computeBackoffMock).toHaveBeenCalledWith(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, undefined);
  });

  it("does not retry when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const error = make429Error();
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(
      retryPromptOnRateLimit(makeContext({ prompt, abortSignal: controller.signal })),
    ).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("preserves abort reason when retry sleep is interrupted", async () => {
    const controller = new AbortController();
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(make429Error());
    sleepWithAbortMock.mockImplementationOnce(async () => {
      controller.abort("sessions_yield");
      throw new Error("aborted", { cause: new DOMException("signal is aborted", "AbortError") });
    });

    const thrown = await Promise.resolve(
      retryPromptOnRateLimit(makeContext({ prompt, abortSignal: controller.signal })),
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe("sessions_yield");
  });
});

describe("exhausted error → downstream failover classification bridge", () => {
  beforeEach(() => {
    computeBackoffMock.mockClear();
    computeBackoffMock.mockImplementation((attempt: number) => attempt * 1_000);
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

  it("exhausted thrown 429 is classified as rate_limit by resolveFailoverReasonFromError", async () => {
    const error = make429Error({ headers: { "retry-after": "1" } });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    const thrown = await retryPromptOnRateLimit(makeContext({ prompt })).catch(
      (err: unknown) => err,
    );

    // The exact error reference passes through to the run loop
    expect(thrown).toBe(error);
    // The run loop uses resolveFailoverReasonFromError for profile rotation
    expect(resolveFailoverReasonFromError(thrown)).toBe("rate_limit");
  });

  it("exhausted terminal assistant errorMessage is classified as rate_limit by classifyFailoverReason", async () => {
    const errorMessage = "Too many requests";
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: true,
      rawError: { errorMessage },
    }));

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind: vi.fn() }));

    // The run loop uses classifyFailoverReason on the assistant's errorMessage
    expect(classifyFailoverReason(errorMessage)).toBe("rate_limit");
  });
});

describe("parseRetryAfterMs", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [{ headers: { "retry-after": "5" } }, 5_000],
    [{ headers: { "Retry-After": "6" } }, 6_000],
    [{ headers: { "RETRY-AFTER": "4" } }, 4_000],
    [{ response: { headers: { "retry-after": "7" } } }, 7_000],
    [{ cause: { headers: { "retry-after": "3" } } }, 3_000],
    [{ error: { headers: { "retry-after": "11" } } }, 11_000],
    [{ cause: { error: { headers: { "retry-after": "9" } } } }, 9_000],
  ])("parses delta-seconds from common header shapes", (error, expected) => {
    expect(parseRetryAfterMs(error)).toBe(expected);
  });

  it("parses HTTP-date values", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-03-25T10:00:00.000Z");
      vi.setSystemTime(now);

      expect(
        parseRetryAfterMs({
          headers: { "retry-after": new Date("2026-03-25T10:00:10.000Z").toUTCString() },
        }),
      ).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Retry-After from Headers instances", () => {
    const headers = new Headers();
    headers.set("retry-after", "8");

    expect(parseRetryAfterMs({ headers })).toBe(8_000);
  });
});
