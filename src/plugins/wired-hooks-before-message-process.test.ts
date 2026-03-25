/**
 * Test: before_message_process hook wiring
 *
 * Verifies runner dispatch, first-claim-wins semantics, and pass-through
 * when no handler intercepts.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("before_message_process hook runner", () => {
  it("returns undefined when no hooks are registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "hello", isGroup: false },
      { channelId: "telegram" },
    );

    expect(result).toBeUndefined();
  });

  it("returns handled:true from first handler that intercepts", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: true, reason: "kefu intercept" });
    const registry = createMockPluginRegistry([{ hookName: "before_message_process", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "help me", isGroup: false },
      { channelId: "telegram", accountId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { from: "user-1", content: "help me", isGroup: false },
      { channelId: "telegram", accountId: "main" },
    );
    expect(result).toEqual({ handled: true, reason: "kefu intercept" });
  });

  it("returns undefined when handler returns handled:false", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: false });
    const registry = createMockPluginRegistry([{ hookName: "before_message_process", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "hello", isGroup: false },
      { channelId: "telegram" },
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined when handler returns void", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([{ hookName: "before_message_process", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "hello", isGroup: false },
      { channelId: "telegram" },
    );

    expect(result).toBeUndefined();
  });

  it("stops at first handler that claims (first-claim-wins)", async () => {
    const handlerA = vi.fn().mockResolvedValue({ handled: true });
    const handlerB = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([
      { hookName: "before_message_process", handler: handlerA },
      { hookName: "before_message_process", handler: handlerB },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "hello", isGroup: false },
      { channelId: "telegram" },
    );

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
    expect(result?.handled).toBe(true);
  });

  it("falls through to second handler when first declines", async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue({ handled: true, reason: "second plugin" });
    const registry = createMockPluginRegistry([
      { hookName: "before_message_process", handler: handlerA },
      { hookName: "before_message_process", handler: handlerB },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeMessageProcess(
      { from: "user-1", content: "hello", isGroup: false },
      { channelId: "telegram" },
    );

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ handled: true, reason: "second plugin" });
  });

  it("passes all event fields to handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const registry = createMockPluginRegistry([{ hookName: "before_message_process", handler }]);
    const runner = createHookRunner(registry);

    await runner.runBeforeMessageProcess(
      {
        from: "telegram:user:42",
        content: "normalized",
        body: "raw body",
        bodyForAgent: "[Audio] Transcript: hi",
        transcript: "hi",
        timestamp: 1710000000000,
        senderId: "uid-42",
        senderName: "Alice",
        isGroup: true,
        messageId: "msg-1",
      },
      { channelId: "telegram", accountId: "main", conversationId: "group:chat1" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "telegram:user:42",
        content: "normalized",
        body: "raw body",
        bodyForAgent: "[Audio] Transcript: hi",
        transcript: "hi",
        timestamp: 1710000000000,
        senderId: "uid-42",
        senderName: "Alice",
        isGroup: true,
        messageId: "msg-1",
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "main",
        conversationId: "group:chat1",
      }),
    );
  });
});
