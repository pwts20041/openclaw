import { describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import type { PluginRuntime, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

function createRuntime() {
  const monitorLineProvider = vi.fn(async () => ({
    account: { accountId: "default" },
    handleWebhook: async () => {},
    stop: () => {},
  }));

  const runtime = {
    channel: {
      line: {
        monitorLineProvider,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  return { runtime, monitorLineProvider };
}

function createAccount(params: { token: string; secret: string }): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: params.token,
    channelSecret: params.secret,
    tokenSource: "config",
    config: {} as ResolvedLineAccount["config"],
  };
}

function startLineAccount(params: { account: ResolvedLineAccount; abortSignal?: AbortSignal }) {
  const { runtime, monitorLineProvider } = createRuntime();
  setLineRuntime(runtime);
  return {
    monitorLineProvider,
    task: linePlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: params.account,
        abortSignal: params.abortSignal,
      }),
    ),
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "   " }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel secret for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("fails startup when channel access token is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "   ", secret: "secret" }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel access token for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("starts provider when token and secret are present", async () => {
    const abort = new AbortController();
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "secret" }),
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => {
      expect(monitorLineProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccessToken: "token",
          channelSecret: "secret",
          accountId: "default",
        }),
      );
    });

    abort.abort();
    await task;
  });
});

describe("linePlugin status.collectStatusIssues", () => {
  it("reports no issues when snapshot is configured", () => {
    const collect = linePlugin.status!.collectStatusIssues!;
    const issues = collect([{ accountId: "default", configured: true, enabled: true }]);
    expect(issues).toHaveLength(0);
  });

  it("reports one issue when snapshot is not configured", () => {
    const collect = linePlugin.status!.collectStatusIssues!;
    const issues = collect([{ accountId: "default", configured: false, enabled: true }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("LINE channel not configured");
    expect(issues[0].channel).toBe("line");
  });

  it("uses snapshot.configured only (no token/secret in snapshot)", () => {
    const collect = linePlugin.status!.collectStatusIssues!;
    const issues = collect([{ accountId: "default", configured: true } as ChannelAccountSnapshot]);
    expect(issues).toHaveLength(0);
  });
});
