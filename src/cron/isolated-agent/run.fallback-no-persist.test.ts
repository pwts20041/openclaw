import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runWithModelFallbackMock,
  setSessionRuntimeModelMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fallback model not persisted", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("persists hook-overridden model even though it differs from configured default", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // A before_model_resolve hook redirected to a different provider/model.
    // The run reports isHookOverride=true — this is NOT a fallback.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "hook-routed response" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-opus-4-5",
            isHookOverride: true,
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");

    // setSessionRuntimeModel SHOULD have been called because this is a
    // deliberate hook override, not a fallback.
    expect(setSessionRuntimeModelMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "anthropic", model: "claude-opus-4-5" }),
    );
  });

  it("does not persist fallback CLI session ID when a fallback was used", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // Fallback run with CLI session ID — should NOT be persisted.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "fallback response" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            sessionId: "fallback-cli-session-xyz",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      attempts: [],
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    // The fallback CLI session ID must not appear on the session entry
    const entryStr = JSON.stringify(cronSession.sessionEntry);
    expect(entryStr).not.toContain("fallback-cli-session-xyz");
  });

  it("does not overwrite session model/provider when a fallback was used", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // Simulate fallback: runWithModelFallback returns a different provider/model
    // than the configured primary (openai/gpt-4).
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "fallback response" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");

    // setSessionRuntimeModel should NOT have been called because the run
    // was served by a fallback model, not the configured primary.
    expect(setSessionRuntimeModelMock).not.toHaveBeenCalled();

    // The session entry's model/modelProvider should still reflect the
    // pre-run values (set before runPrompt), not the fallback values.
    // Note: the pre-run persistence writes the configured primary.
    // After the run, the fallback must NOT overwrite it.
    expect(cronSession.sessionEntry.model).not.toBe("claude-sonnet-4-20250514");
    expect(cronSession.sessionEntry.modelProvider).not.toBe("anthropic");
  });
});
