import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      onBlockReplyFlush,
      onAgentEvent: undefined,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      toolSummaryById: new Set<string>(),
      consecutiveToolErrors: null,
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush };
}

describe("handleToolExecutionStart read path checks", () => {
  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { file_path: "/tmp/example.txt" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await handleToolExecutionStart(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
  });

  it("awaits onBlockReplyFlush before continuing tool start processing", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    let releaseFlush: (() => void) | undefined;
    onBlockReplyFlush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-await-flush",
      args: { command: "echo hi" },
    };

    const pending = handleToolExecutionStart(ctx, evt);
    // Let the async function reach the awaited flush Promise.
    await Promise.resolve();

    // If flush isn't awaited, tool metadata would already be recorded here.
    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(false);
    expect(releaseFlush).toBeTypeOf("function");

    releaseFlush?.();
    await pending;

    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(true);
  });
});

describe("handleToolExecutionEnd cron.add commitment tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        isError: false,
        result: { details: { status: "ok" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        isError: true,
        result: { details: { status: "error" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(0);
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta stale",
          new_string: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        isError: true,
        result: { error: "Could not find the exact text in /tmp/demo.txt" },
      } as never,
    );

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        args: {
          file: "/tmp/demo.txt",
          oldText: "beta",
          newText: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        isError: false,
        result: { ok: true },
      } as never,
    );

    expect(ctx.state.lastToolError).toBeUndefined();
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-approval",
        isError: false,
        result: {
          details: {
            status: "approval-pending",
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
            warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("```txt\n/approve 12345678 allow-once\n```"),
        channelData: {
          execApproval: {
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-unavailable",
        isError: false,
        result: {
          details: {
            status: "approval-unavailable",
            reason: "initiating-platform-disabled",
            channelLabel: "Discord",
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("chat exec approvals are not enabled on Discord"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("/approve"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Pending command:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Host:"),
      }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("CWD:"),
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits the shared approver-DM notice when another approval client received the request", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-unavailable-dm-redirect",
        isError: false,
        result: {
          details: {
            status: "approval-unavailable",
            reason: "initiating-platform-disabled",
            channelLabel: "Telegram",
            sentApproverDms: true,
          },
        },
      } as never,
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Approval required. I sent the allowed approvers DMs.",
      }),
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("does not suppress assistant output when deterministic prompt delivery rejects", async () => {
    const { ctx } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-approval-reject",
        isError: false,
        result: {
          details: {
            status: "approval-pending",
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            expiresAtMs: 1_800_000_000_000,
            host: "gateway",
            command: "npm view diver name version description",
            cwd: "/tmp/work",
          },
        },
      } as never,
    );

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });
});

describe("messaging tool media URL tracking", () => {
  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m1",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2",
      isError: false,
      result: { ok: true },
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toContain("file:///img.jpg");
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m2")).toBe(false);
  });

  it("commits mediaUrls from tool result payload", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2b",
      args: { action: "send", to: "channel:123", content: "hi" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2b",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "file:///img-a.jpg",
      "file:///img-b.jpg",
    ]);
  });

  it("trims messagingToolSentMediaUrls to 200 on commit (FIFO)", async () => {
    const { ctx } = createTestContext();

    // Replace mock with a real trim that replicates production cap logic.
    const MAX = 200;
    ctx.trimMessagingToolSent = () => {
      if (ctx.state.messagingToolSentTexts.length > MAX) {
        const overflow = ctx.state.messagingToolSentTexts.length - MAX;
        ctx.state.messagingToolSentTexts.splice(0, overflow);
        ctx.state.messagingToolSentTextsNormalized.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentTargets.length > MAX) {
        const overflow = ctx.state.messagingToolSentTargets.length - MAX;
        ctx.state.messagingToolSentTargets.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentMediaUrls.length > MAX) {
        const overflow = ctx.state.messagingToolSentMediaUrls.length - MAX;
        ctx.state.messagingToolSentMediaUrls.splice(0, overflow);
      }
    };

    // Pre-fill with 200 URLs (url-0 .. url-199)
    for (let i = 0; i < 200; i++) {
      ctx.state.messagingToolSentMediaUrls.push(`file:///img-${i}.jpg`);
    }
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);

    // Commit one more via start → end
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-cap",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img-new.jpg" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-cap",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m3",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m3",
      isError: true,
      result: "Error: failed",
    };

    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(0);
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m3")).toBe(false);
  });
});

describe("circuit breaker arg signature for messaging tools", () => {
  async function runMessage(ctx: ToolHandlerContext, to: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: id,
      args: { action: "send", to, content: "hello" },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: delivery failed" } : { ok: true },
    });
  }

  it("does not trip circuit when successive failures target different recipients", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Three failures, each to a different recipient — should NOT trip the breaker
    await runMessage(ctx, "channel:111", true, "m1");
    await runMessage(ctx, "channel:222", true, "m2");
    await runMessage(ctx, "channel:333", true, "m3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when successive failures target the same recipient", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runMessage(ctx, "channel:999", true, "m1");
    await runMessage(ctx, "channel:999", true, "m2");
    await runMessage(ctx, "channel:999", true, "m3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for file_path alias", () => {
  async function runRead(ctx: ToolHandlerContext, file_path: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: id,
      args: { file_path },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: not found" } : { ok: true },
    });
  }

  it("does not trip circuit when read failures target different file_path values", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runRead(ctx, "/tmp/a.txt", true, "r1");
    await runRead(ctx, "/tmp/b.txt", true, "r2");
    await runRead(ctx, "/tmp/c.txt", true, "r3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when read failures repeatedly target the same file_path", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runRead(ctx, "/tmp/same.txt", true, "r1");
    await runRead(ctx, "/tmp/same.txt", true, "r2");
    await runRead(ctx, "/tmp/same.txt", true, "r3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for sessionId and jobId selectors", () => {
  async function runCron(ctx: ToolHandlerContext, jobId: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "cron",
      toolCallId: id,
      args: { action: "remove", jobId },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "cron",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: job not found" } : { ok: true },
    });
  }

  it("does not trip circuit when cron failures target different jobIds", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runCron(ctx, "job-1", true, "c1");
    await runCron(ctx, "job-2", true, "c2");
    await runCron(ctx, "job-3", true, "c3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when cron failures repeatedly target the same jobId", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runCron(ctx, "job-x", true, "c1");
    await runCron(ctx, "job-x", true, "c2");
    await runCron(ctx, "job-x", true, "c3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for browser targetId selector", () => {
  async function runFocus(ctx: ToolHandlerContext, targetId: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: id,
      args: { action: "focus", targetId },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: tab not found" } : { ok: true },
    });
  }

  it("does not trip circuit when focus failures target different tab ids", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runFocus(ctx, "tab-1", true, "f1");
    await runFocus(ctx, "tab-2", true, "f2");
    await runFocus(ctx, "tab-3", true, "f3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when focus failures repeatedly target the same tab id", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runFocus(ctx, "tab-x", true, "f1");
    await runFocus(ctx, "tab-x", true, "f2");
    await runFocus(ctx, "tab-x", true, "f3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for nodes tool selectors", () => {
  async function runNodes(ctx: ToolHandlerContext, node: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "nodes",
      toolCallId: id,
      args: { action: "status", node },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "nodes",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: node unreachable" } : { ok: true },
    });
  }

  it("does not trip circuit when failures target different nodes", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runNodes(ctx, "node-a", true, "n1");
    await runNodes(ctx, "node-b", true, "n2");
    await runNodes(ctx, "node-c", true, "n3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when failures repeatedly target the same node", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runNodes(ctx, "node-x", true, "n1");
    await runNodes(ctx, "node-x", true, "n2");
    await runNodes(ctx, "node-x", true, "n3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for file alias", () => {
  async function runEdit(ctx: ToolHandlerContext, file: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: id,
      args: { file, old_string: "foo", new_string: "bar" },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "edit",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: not found" } : { ok: true },
    });
  }

  it("does not trip circuit when edit failures target different file values", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runEdit(ctx, "/tmp/a.txt", true, "e1");
    await runEdit(ctx, "/tmp/b.txt", true, "e2");
    await runEdit(ctx, "/tmp/c.txt", true, "e3");

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("circuit breaker arg signature for action-based tools with url/path args", () => {
  async function runBrowser(ctx: ToolHandlerContext, url: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: id,
      // target="current" is a window selector; url must win over it in the signature.
      args: { action: "open", target: "current", url },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: navigation failed" } : { ok: true },
    });
  }

  it("does not trip circuit when browser URLs differ only beyond 200 chars", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    const base = "https://example.com/" + "x".repeat(190);
    const urlA = base + "A";
    const urlB = base + "B";
    const urlC = base + "C";
    expect(urlA.slice(0, 200)).toBe(urlB.slice(0, 200)); // confirm shared prefix

    await runBrowser(ctx, urlA, true, "b-long-1");
    await runBrowser(ctx, urlB, true, "b-long-2");
    await runBrowser(ctx, urlC, true, "b-long-3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not trip circuit when action-based calls have different URLs", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowser(ctx, "https://example.com/a", true, "b1");
    await runBrowser(ctx, "https://example.com/b", true, "b2");
    await runBrowser(ctx, "https://example.com/c", true, "b3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when action-based calls repeatedly use the same URL", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runBrowser(ctx, "https://example.com/same", true, "b1");
    await runBrowser(ctx, "https://example.com/same", true, "b2");
    await runBrowser(ctx, "https://example.com/same", true, "b3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for sessions_send label routing", () => {
  async function runSessionsSend(
    ctx: ToolHandlerContext,
    label: string,
    isError: boolean,
    id: string,
  ) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "sessions_send",
      toolCallId: id,
      args: { label, message: "hello" },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "sessions_send",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: session not visible" } : { ok: true },
    });
  }

  it("does not trip circuit when failures target different session labels", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runSessionsSend(ctx, "agent-a", true, "s1");
    await runSessionsSend(ctx, "agent-b", true, "s2");
    await runSessionsSend(ctx, "agent-c", true, "s3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when failures repeatedly target the same session label", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runSessionsSend(ctx, "agent-x", true, "s1");
    await runSessionsSend(ctx, "agent-x", true, "s2");
    await runSessionsSend(ctx, "agent-x", true, "s3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker probe-reset prevention", () => {
  async function runExec(ctx: ToolHandlerContext, command: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: id,
      args: { command },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: id,
      isError,
      result: isError
        ? { type: "text", text: "Error: permission denied" }
        : { type: "text", text: "ok" },
    });
  }

  it("does not reset circuit after probe command when already tripped", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip the circuit with 3 failures of the same command
    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Model probes with a trivial echo command — should NOT reset circuit
    await runExec(ctx, "echo test", false, "t4");
    expect(ctx.state.consecutiveToolErrors).not.toBeNull();
    expect(ctx.state.consecutiveToolErrors?.tripped).toBe(true);

    // Original failing command recurs — should re-fire steer
    await runExec(ctx, "ls /restricted", true, "t5");
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire steer on plain consecutive failures after threshold (no probe)", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip at count 3
    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Further failures with no probe in between — must NOT re-fire
    await runExec(ctx, "ls /restricted", true, "t4");
    await runExec(ctx, "ls /restricted", true, "t5");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not trip circuit when long commands differ only beyond 100 chars", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Build two commands that share the first 100 chars but differ afterward.
    const prefix = 'node -e \'require("fs").writeFileSync("/tmp/out.txt", ' + "x".repeat(50);
    const cmdA = prefix + "A'.repeat(1))'\n";
    const cmdB = prefix + "B'.repeat(1))'\n";
    expect(cmdA.slice(0, 100)).toBe(cmdB.slice(0, 100)); // confirm shared prefix
    expect(cmdA).not.toBe(cmdB);

    // Three failures alternating between the two long commands — should NOT trip breaker
    await runExec(ctx, cmdA, true, "t1");
    await runExec(ctx, cmdB, true, "t2");
    await runExec(ctx, cmdA, true, "t3");
    expect(onError).not.toHaveBeenCalled();
  });

  it("resets circuit when exact same pipe-containing command succeeds after trip", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Trip with a command that contains "|"
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t1");
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t2");
    await runExec(ctx, "cat /etc/hosts | grep foo", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // Exact same command now succeeds — problem resolved, circuit should reset
    await runExec(ctx, "cat /etc/hosts | grep foo", false, "t4");
    expect(ctx.state.consecutiveToolErrors).toBeNull();
  });

  it("resets circuit when a different tool succeeds after trip", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runExec(ctx, "ls /restricted", true, "t1");
    await runExec(ctx, "ls /restricted", true, "t2");
    await runExec(ctx, "ls /restricted", true, "t3");
    expect(onError).toHaveBeenCalledTimes(1);

    // A different tool succeeds — agent found a real alternative
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "write",
      toolCallId: "t4",
      args: { path: "/tmp/out.txt", content: "hello" },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "write",
      toolCallId: "t4",
      isError: false,
      result: { type: "text", text: "ok" },
    });
    expect(ctx.state.consecutiveToolErrors).toBeNull();
  });
});

describe("circuit breaker arg signature for fallback url key (e.g. web_fetch)", () => {
  async function runWebFetch(ctx: ToolHandlerContext, url: string, isError: boolean, id: string) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "web_fetch",
      toolCallId: id,
      args: { url },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "web_fetch",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: fetch failed" } : { ok: true },
    });
  }

  it("does not trip circuit when web_fetch URLs share a 100-char prefix but differ after it", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    // Build URLs that share the first 100 chars but differ afterward
    const base = "https://example.com/search?q=" + "x".repeat(72);
    const urlA = base + "A";
    const urlB = base + "B";
    const urlC = base + "C";
    expect(urlA.slice(0, 100)).toBe(urlB.slice(0, 100)); // confirm shared prefix at 100

    await runWebFetch(ctx, urlA, true, "wf1");
    await runWebFetch(ctx, urlB, true, "wf2");
    await runWebFetch(ctx, urlC, true, "wf3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when web_fetch repeatedly fetches the same URL", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runWebFetch(ctx, "https://example.com/api/data", true, "wf1");
    await runWebFetch(ctx, "https://example.com/api/data", true, "wf2");
    await runWebFetch(ctx, "https://example.com/api/data", true, "wf3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker arg signature for action-based content fields (canvas eval / image-generate)", () => {
  async function runCanvas(
    ctx: ToolHandlerContext,
    javaScript: string,
    isError: boolean,
    id: string,
  ) {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "canvas",
      toolCallId: id,
      args: { action: "eval", javaScript },
    });
    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "canvas",
      toolCallId: id,
      isError,
      result: isError ? { type: "text", text: "Error: eval failed" } : { ok: true },
    });
  }

  it("does not trip circuit when canvas eval failures use different scripts", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runCanvas(ctx, "document.title", true, "c1");
    await runCanvas(ctx, "window.location.href", true, "c2");
    await runCanvas(ctx, "document.body.innerText", true, "c3");

    expect(onError).not.toHaveBeenCalled();
  });

  it("trips circuit when canvas eval repeatedly runs the same script", async () => {
    const { ctx } = createTestContext();
    const onError = vi.fn();
    ctx.params.onConsecutiveToolError = onError;

    await runCanvas(ctx, "document.querySelector('#btn').click()", true, "c1");
    await runCanvas(ctx, "document.querySelector('#btn').click()", true, "c2");
    await runCanvas(ctx, "document.querySelector('#btn').click()", true, "c3");

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
