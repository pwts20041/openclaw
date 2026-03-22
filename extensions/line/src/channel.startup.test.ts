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

describe("linePlugin status", () => {
  it("does not report missing token or secret when snapshot came from file-backed config", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "token-from-file",
        channelSecret: "secret-from-file",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([]);
  });

  it("keeps per-field warnings when only one credential is missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "   ",
        channelSecret: "secret-from-file",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
    ]);
  });

  it("keeps per-field warnings when only the channel secret is missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "token-from-file",
        channelSecret: "   ",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });

  it("reports both warnings when both file-backed credentials are missing", async () => {
    const snapshot = await linePlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        channelAccessToken: "   ",
        channelSecret: "   ",
        tokenSource: "file",
        config: {} as ResolvedLineAccount["config"],
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(linePlugin.status?.collectStatusIssues?.([snapshot as never])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });
});
