import type { ChannelThreadingContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, it, expect } from "vitest";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

function createMockContext(
  overrides: Partial<ChannelThreadingContext> = {},
): ChannelThreadingContext {
  return {
    To: "group:-1001234567890",
    ChatType: "group",
    MessageThreadId: 42,
    ...overrides,
  };
}

const mockCfg: OpenClawConfig = {
  channels: {
    telegram: {
      enabled: true,
      accounts: {
        default: {
          enabled: true,
        },
      },
    },
  },
};

describe("buildTelegramThreadingToolContext", () => {
  it("returns toolContext with currentThreadTs when MessageThreadId is present (forum topic)", () => {
    const context = createMockContext({
      MessageThreadId: 42,
      To: "group:-1001234567890",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result).toBeDefined();
    // parseTelegramTarget preserves the "group:" prefix in chatId
    expect(result?.currentChannelId).toBe("group:-1001234567890");
    expect(result?.currentThreadTs).toBe("42");
    expect(result?.hasRepliedRef).toBeUndefined();
  });

  it("returns toolContext WITHOUT currentThreadTs for DMs (no MessageThreadId) - FIXES REGRESSION", () => {
    const context = createMockContext({
      MessageThreadId: undefined,
      To: "123456",
      ChatType: "direct",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // Should NOT return undefined for DMs!
    expect(result).toBeDefined();
    expect(result?.currentChannelId).toBe("123456");
    expect(result?.currentThreadTs).toBeUndefined();
    expect(result?.hasRepliedRef).toBeUndefined();
  });

  it("returns toolContext WITHOUT currentThreadTs for regular groups (no MessageThreadId)", () => {
    const context = createMockContext({
      MessageThreadId: undefined,
      To: "group:-1009876543210",
      ChatType: "group",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // Should NOT return undefined for regular groups!
    expect(result).toBeDefined();
    expect(result?.currentChannelId).toBe("group:-1009876543210");
    expect(result?.currentThreadTs).toBeUndefined();
  });

  it("extracts chat ID correctly from group To field", () => {
    const context = createMockContext({
      MessageThreadId: 100,
      To: "group:-1009876543210",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // parseTelegramTarget preserves the "group:" prefix in chatId
    expect(result?.currentChannelId).toBe("group:-1009876543210");
    expect(result?.currentThreadTs).toBe("100");
  });

  it("extracts chat ID correctly from DM To field", () => {
    const context = createMockContext({
      MessageThreadId: 200,
      To: "123456",
      ChatType: "direct",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result?.currentChannelId).toBe("123456");
    expect(result?.currentThreadTs).toBe("200");
  });

  it("passes hasRepliedRef through when provided", () => {
    const context = createMockContext({
      MessageThreadId: 42,
    });
    const repliedRef = { value: false };

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
      hasRepliedRef: repliedRef,
    });

    expect(result?.hasRepliedRef).toBe(repliedRef);
  });

  it("passes hasRepliedRef through for DMs (no MessageThreadId)", () => {
    const context = createMockContext({
      MessageThreadId: undefined,
      To: "123456",
      ChatType: "direct",
    });
    const repliedRef = { value: true };

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
      hasRepliedRef: repliedRef,
    });

    expect(result).toBeDefined();
    expect(result?.hasRepliedRef).toBe(repliedRef);
    expect(result?.currentThreadTs).toBeUndefined();
  });

  it("handles forum topic with large thread ID", () => {
    const context = createMockContext({
      MessageThreadId: 999999,
      To: "group:-1001111222333",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result?.currentChannelId).toBe("group:-1001111222333");
    expect(result?.currentThreadTs).toBe("999999");
  });
});
