import { afterEach, describe, expect, it, vi } from "vitest";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let registryRuntimeLoadAttempts = 0;

async function importModuleWithRegistryRuntimeFailure() {
  vi.resetModules();
  gatewayCalls.length = 0;
  registryRuntimeLoadAttempts = 0;

  vi.doMock("../gateway/call.js", () => ({
    callGateway: vi.fn(async (request: GatewayCall) => {
      gatewayCalls.push(request);
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    }),
  }));

  vi.doMock("../config/config.js", () => ({
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    }),
  }));

  vi.doMock("../config/sessions.js", () => ({
    loadSessionStore: vi.fn(() => ({
      "agent:main:main": { sessionId: "sess-main", updatedAt: 1 },
      "agent:main:subagent:worker": { sessionId: "sess-worker", updatedAt: 1 },
    })),
    resolveAgentIdFromSessionKey: () => "main",
    resolveStorePath: () => "/tmp/sessions-main.json",
    resolveMainSessionKey: () => "agent:main:main",
  }));

  vi.doMock("./pi-embedded.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./pi-embedded.js")>();
    return {
      ...actual,
      isEmbeddedPiRunActive: () => false,
      queueEmbeddedPiMessage: () => false,
      waitForEmbeddedPiRunEnd: async () => true,
    };
  });

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: () => 0,
  }));

  vi.doMock("./subagent-registry-runtime.js", () => {
    registryRuntimeLoadAttempts += 1;
    throw new Error("registry runtime load failed");
  });

  return await import("./subagent-announce.js");
}

describe("subagent announce registry runtime fallback", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../gateway/call.js");
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../config/sessions.js");
    vi.doUnmock("./pi-embedded.js");
    vi.doUnmock("./subagent-depth.js");
    vi.doUnmock("./subagent-registry-runtime.js");
    gatewayCalls.length = 0;
    registryRuntimeLoadAttempts = 0;
  });

  it("falls back to best-effort announce and retries runtime load after a failure", async () => {
    const { runSubagentAnnounceFlow } = await importModuleWithRegistryRuntimeFailure();

    const baseParams = {
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1_000,
      cleanup: "keep" as const,
      roundOneReply: "done",
      waitForCompletion: false,
      outcome: { status: "ok" as const },
    };

    await expect(
      runSubagentAnnounceFlow({
        ...baseParams,
        childRunId: "run-registry-load-failure-1",
      }),
    ).resolves.toBe(true);

    await expect(
      runSubagentAnnounceFlow({
        ...baseParams,
        childRunId: "run-registry-load-failure-2",
      }),
    ).resolves.toBe(true);

    const directAgentCalls = gatewayCalls.filter(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCalls).toHaveLength(2);
    expect(directAgentCalls.every((call) => call.params?.sessionKey === "agent:main:main")).toBe(
      true,
    );
    expect(registryRuntimeLoadAttempts).toBe(2);
  });
});
