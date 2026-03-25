import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();

vi.mock("./pi-embedded-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
}));

vi.mock("./pi-embedded-runner/compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => {
    throw new Error("compact should not run in rate-limit retry e2e tests");
  }),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ agentDir: "/tmp", wrote: false })),
}));

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let runWithModelFallback: typeof import("./model-fallback.js").runWithModelFallback;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ runWithModelFallback } = await import("./model-fallback.js"));
});

beforeEach(() => {
  runEmbeddedAttemptMock.mockReset();
});

const baseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: "mock-1",
  usage: baseUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...overrides,
});

const makeAttempt = (overrides: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult => ({
  aborted: false,
  timedOut: false,
  timedOutDuringCompaction: false,
  promptError: null,
  sessionIdUsed: "session:test",
  systemPromptReport: undefined,
  messagesSnapshot: [],
  assistantTexts: [],
  toolMetas: [],
  lastAssistant: undefined,
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  cloudCodeAssistFormatError: false,
  ...overrides,
});

function makeRotationConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          fallbacks: [],
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com/openai",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function makeFallbackConfig(): OpenClawConfig {
  const apiKeyField = ["api", "Key"].join("");
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/mock-1",
          fallbacks: ["groq/mock-2"],
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          [apiKeyField]: "openai-test-key",
          baseUrl: "https://example.com/openai",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
        groq: {
          api: "openai-responses",
          [apiKeyField]: "groq-test-key",
          baseUrl: "https://example.com/groq",
          models: [
            {
              id: "mock-2",
              name: "Mock 2",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
}

async function withAgentWorkspace<T>(
  fn: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rate-limit-retry-"));
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  try {
    return await fn({ agentDir, workspaceDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeRotationAuthStore(agentDir: string) {
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
        "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
      },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      },
    }),
  );
}

async function writeFallbackAuthStore(agentDir: string) {
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "openai:p1": { type: "api_key", provider: "openai", key: "sk-openai" },
        "groq:p1": { type: "api_key", provider: "groq", key: "sk-groq" },
      },
      usageStats: {
        "openai:p1": { lastUsed: 1 },
        "groq:p1": { lastUsed: 2 },
      },
    }),
  );
}

async function readUsageStats(agentDir: string) {
  const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf-8");
  return JSON.parse(raw).usageStats as Record<string, Record<string, unknown> | undefined>;
}

async function runRotationTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
}) {
  return await runEmbeddedPiAgent({
    sessionId: `session:${params.runId}`,
    sessionKey: params.sessionKey,
    sessionFile: path.join(params.workspaceDir, `${params.runId}.jsonl`),
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: makeRotationConfig(),
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    authProfileIdSource: "auto",
    timeoutMs: 5_000,
    runId: params.runId,
  });
}

async function runFallbackTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
}) {
  const cfg = makeFallbackConfig();
  return await runWithModelFallback({
    cfg,
    provider: "openai",
    model: "mock-1",
    runId: params.runId,
    agentDir: params.agentDir,
    run: (provider, model, options) =>
      runEmbeddedPiAgent({
        sessionId: `session:${params.runId}`,
        sessionKey: params.sessionKey,
        sessionFile: path.join(params.workspaceDir, `${params.runId}.jsonl`),
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: "hello",
        provider,
        model,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        timeoutMs: 5_000,
        runId: params.runId,
      }),
  });
}

function mockRotationSuccess() {
  return makeAttempt({
    assistantTexts: ["ok"],
    lastAssistant: buildAssistant({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    }),
  });
}

describe("runEmbeddedPiAgent rate-limit retry fallthrough", () => {
  it("rotates auth profiles after a rate-limit promptError and succeeds on retry", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeRotationAuthStore(agentDir);
      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            promptError: Object.assign(new Error("Too Many Requests"), { status: 429 }),
          }),
        )
        .mockResolvedValueOnce(mockRotationSuccess());

      const result = await runRotationTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:prompt-rate-limit",
        runId: "run:prompt-rate-limit",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    });
  });

  it("rotates auth profiles after a terminal assistant rate limit and succeeds on retry", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeRotationAuthStore(agentDir);
      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            lastAssistant: buildAssistant({
              stopReason: "error",
              errorMessage: "Too many requests for this profile",
            }),
          }),
        )
        .mockResolvedValueOnce(mockRotationSuccess());

      const result = await runRotationTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:assistant-rate-limit",
        runId: "run:assistant-rate-limit",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    });
  });

  it("still rotates immediately when a rate-limit assistant result already escaped side effects", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeRotationAuthStore(agentDir);
      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["partial output already streamed"],
            lastAssistant: buildAssistant({
              stopReason: "error",
              errorMessage: "Too many requests for this profile",
            }),
          }),
        )
        .mockResolvedValueOnce(mockRotationSuccess());

      const result = await runRotationTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:assistant-rate-limit-side-effects",
        runId: "run:assistant-rate-limit-side-effects",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");

      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    });
  });
});

describe("runWithModelFallback rate-limit retry fallthrough", () => {
  it("continues to model fallback after an exhausted rate-limit promptError", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
        const attemptParams = params as { provider: string };
        if (attemptParams.provider === "openai") {
          return makeAttempt({
            promptError: Object.assign(new Error("Too Many Requests"), { status: 429 }),
          });
        }
        if (attemptParams.provider === "groq") {
          return makeAttempt({
            assistantTexts: ["fallback ok"],
            lastAssistant: buildAssistant({
              provider: "groq",
              model: "mock-2",
              stopReason: "stop",
              content: [{ type: "text", text: "fallback ok" }],
            }),
          });
        }
        throw new Error(`Unexpected provider ${attemptParams.provider}`);
      });

      const result = await runFallbackTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:fallback-rate-limit",
        runId: "run:fallback-rate-limit",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(
        (runEmbeddedAttemptMock.mock.calls[0]?.[0] as { provider?: string } | undefined)?.provider,
      ).toBe("openai");
      expect(
        (runEmbeddedAttemptMock.mock.calls[1]?.[0] as { provider?: string } | undefined)?.provider,
      ).toBe("groq");
    });
  });
});
