import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContextMock,
  registerPluginHttpRouteMock,
  resolveLegacyWebhookNameToChatUserIdMock,
  resolveAgentRouteMock,
  sendFileUrlMock,
  sendMessageMock,
} from "./channel.test-mocks.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";

type RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const { createSynologyChatPlugin } = await import("./channel.js");
const actualGatewayRuntime = await import("./gateway-runtime.js");
const { createWebhookHandler } = await import("./webhook-handler.js");
const activeRouteUnregisters = new Map<string, () => void>();

function createHandlerLogAdapter(log?: {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}) {
  if (!log) {
    return undefined;
  }
  return {
    info: (...args: unknown[]) => log.info?.(String(args[0] ?? "")),
    warn: (...args: unknown[]) => log.warn?.(String(args[0] ?? "")),
    error: (...args: unknown[]) => log.error?.(String(args[0] ?? "")),
  };
}

function createGatewayRuntimeOverride() {
  return {
    collectSynologyGatewayRoutingWarnings:
      actualGatewayRuntime.collectSynologyGatewayRoutingWarnings,
    validateSynologyGatewayAccountStartup:
      actualGatewayRuntime.validateSynologyGatewayAccountStartup,
    registerSynologyWebhookRoute: ({
      account,
      log,
    }: {
      account: {
        accountId: string;
        webhookPath: string;
        incomingUrl: string;
        allowInsecureSsl: boolean;
      };
      accountId: string;
      log?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
        error?: (message: string) => void;
      };
    }) => {
      const routeKey = `${account.accountId}:${account.webhookPath}`;
      const previous = activeRouteUnregisters.get(routeKey);
      if (previous) {
        log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
        previous();
        activeRouteUnregisters.delete(routeKey);
      }
      const handler = createWebhookHandler({
        account: account as never,
        client: {
          sendMessage: sendMessageMock,
          resolveLegacyWebhookNameToChatUserId: resolveLegacyWebhookNameToChatUserIdMock,
        },
        deliver: async (msg) => {
          const route = resolveAgentRouteMock({ accountId: account.accountId });
          finalizeInboundContextMock({
            AccountId: account.accountId,
            SessionKey: `agent:${route.agentId}:synology-chat:${account.accountId}:direct:${msg.from}`,
          });
          await dispatchReplyWithBufferedBlockDispatcher();
          return null;
        },
        log: createHandlerLogAdapter(log),
      });
      const unregister = registerPluginHttpRouteMock({
        path: account.webhookPath,
        accountId: account.accountId,
        handler,
      });
      activeRouteUnregisters.set(routeKey, unregister);
      return () => {
        unregister();
        activeRouteUnregisters.delete(routeKey);
      };
    },
  };
}

function createTestPlugin() {
  return createSynologyChatPlugin({
    client: {
      sendMessage: sendMessageMock,
      sendFileUrl: sendFileUrlMock,
    },
    gatewayRuntime: createGatewayRuntimeOverride(),
  });
}

describe("Synology channel wiring integration", () => {
  beforeEach(() => {
    activeRouteUnregisters.clear();
    registerPluginHttpRouteMock.mockReset();
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    finalizeInboundContextMock.mockClear();
    resolveAgentRouteMock.mockClear();
    resolveLegacyWebhookNameToChatUserIdMock.mockClear();
    sendMessageMock.mockClear();
    sendFileUrlMock.mockClear();
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = createTestPlugin();
    const abortController = new AbortController();
    const ctx = {
      cfg: {
        channels: {
          "synology-chat": {
            enabled: true,
            accounts: {
              alerts: {
                enabled: true,
                token: "valid-token",
                incomingUrl: "https://nas.example.com/incoming",
                webhookPath: "/webhook/synology-alerts",
                dmPolicy: "allowlist",
                allowedUserIds: ["456"],
              },
            },
          },
        },
      },
      accountId: "alerts",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: abortController.signal,
    };

    const started = plugin.gateway.startAccount(ctx);
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);

    const firstCall = registerPluginHttpRouteMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    if (!firstCall) throw new Error("Expected registerPluginHttpRoute to be called");
    const registered = firstCall[0];
    expect(registered.path).toBe("/webhook/synology-alerts");
    expect(registered.accountId).toBe("alerts");

    const req = makeReq(
      "POST",
      makeFormBody({
        token: "valid-token",
        user_id: "123",
        username: "unauthorized-user",
        text: "Hello",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(403);
    expect(res._body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    abortController.abort();
    await started;
  });

  it("isolates same user_id across different accounts", async () => {
    const plugin = createTestPlugin();
    const alphaAbortController = new AbortController();
    const betaAbortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alpha: {
              enabled: true,
              token: "token-alpha",
              incomingUrl: "https://nas.example.com/incoming-alpha",
              webhookPath: "/webhook/synology-alpha",
              dmPolicy: "open",
            },
            beta: {
              enabled: true,
              token: "token-beta",
              incomingUrl: "https://nas.example.com/incoming-beta",
              webhookPath: "/webhook/synology-beta",
              dmPolicy: "open",
            },
          },
        },
      },
      session: {
        dmScope: "main" as const,
      },
    };

    const alphaStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "alpha",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: alphaAbortController.signal,
    });
    const betaStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "beta",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: betaAbortController.signal,
    });

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);
    const alphaRoute = registerPluginHttpRouteMock.mock.calls[0]?.[0];
    const betaRoute = registerPluginHttpRouteMock.mock.calls[1]?.[0];
    if (!alphaRoute || !betaRoute) {
      throw new Error("Expected both Synology Chat routes to register");
    }

    const alphaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-alpha",
        user_id: "123",
        username: "alice",
        text: "alpha secret",
      }),
    );
    const alphaRes = makeRes();
    await alphaRoute.handler(alphaReq, alphaRes);

    const betaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-beta",
        user_id: "123",
        username: "bob",
        text: "beta secret",
      }),
    );
    const betaRes = makeRes();
    await betaRoute.handler(betaReq, betaRes);

    expect(alphaRes._status).toBe(204);
    expect(betaRes._status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);

    const alphaCtx = finalizeInboundContextMock.mock.calls[0]?.[0];
    const betaCtx = finalizeInboundContextMock.mock.calls[1]?.[0];
    expect(alphaCtx).toMatchObject({
      AccountId: "alpha",
      SessionKey: "agent:agent-alpha:synology-chat:alpha:direct:123",
    });
    expect(betaCtx).toMatchObject({
      AccountId: "beta",
      SessionKey: "agent:agent-beta:synology-chat:beta:direct:123",
    });

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });
});
