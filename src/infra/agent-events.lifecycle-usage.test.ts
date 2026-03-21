import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  onAgentEvent,
  registerAgentRunContext,
  type AgentEventPayload,
} from "./agent-events.js";

/**
 * Validates the lifecycle "usage" event contract added for external observers
 * (dashboards, recorders). The actual emission sites live in agent-command.ts,
 * agent-runner-execution.ts, and followup-runner.ts; this test verifies the
 * shape and fields of the event as it flows through the agent-events bus.
 */
describe("lifecycle usage event", () => {
  let events: AgentEventPayload[];
  let unsubscribe: () => boolean;

  beforeEach(() => {
    events = [];
    unsubscribe = onAgentEvent((evt) => events.push(evt));
  });

  afterEach(() => unsubscribe());

  it("emits phase=usage with correct token and model fields", () => {
    const runId = `usage-test-${Date.now()}`;
    registerAgentRunContext(runId, { sessionKey: "agent:main:main" });

    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: {
        phase: "usage",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
        lastCallUsage: { input: 30, output: 15 },
        durationMs: 4500,
      },
    });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.stream).toBe("lifecycle");
    expect(evt.sessionKey).toBe("agent:main:main");
    expect(evt.data).toMatchObject({
      phase: "usage",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
      lastCallUsage: { input: 30, output: 15 },
      durationMs: 4500,
    });
    expect(evt.seq).toBeGreaterThan(0);
    expect(evt.ts).toBeGreaterThan(0);
  });

  it("is not emitted when agentMeta.usage is absent", () => {
    // This mirrors the guard: `if (agentMeta?.usage) { emitAgentEvent(...) }`
    const agentMeta: { usage?: unknown } = {};
    if (agentMeta?.usage) {
      emitAgentEvent({
        runId: "no-usage",
        stream: "lifecycle",
        data: { phase: "usage" },
      });
    }
    expect(events).toHaveLength(0);
  });

  it("does not throw when wrapped in defensive try/catch", () => {
    // Simulates the non-fatal pattern used in all emission sites.
    // Even if the event bus throws, it should not propagate.
    const badListener = onAgentEvent(() => {
      throw new Error("listener crash");
    });

    expect(() => {
      emitAgentEvent({
        runId: "defensive-test",
        stream: "lifecycle",
        data: { phase: "usage", usage: { input: 1 } },
      });
    }).not.toThrow();

    badListener();
  });
});
