import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import type { MSTeamsSecretCredentials, MSTeamsFederatedCredentials } from "./token.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(
    () => "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----",
  ),
}));

const { mockGetToken } = vi.hoisted(() => {
  const mockGetToken = vi.fn().mockResolvedValue({ token: "mock-managed-token" });
  return { mockGetToken };
});
vi.mock("@azure/identity", () => {
  // Use classes so `new ...Credential()` works after vitest hoisting
  // (function declarations inside vi.mock factories can be transformed
  // into arrow functions during hoisting, which breaks `new`).
  class ManagedIdentityCredential {
    getToken = mockGetToken;
  }
  class DefaultAzureCredential {
    getToken = mockGetToken;
  }
  class ClientCertificateCredential {
    getToken = mockGetToken;
  }
  return { ManagedIdentityCredential, DefaultAzureCredential, ClientCertificateCredential };
});

import * as fs from "node:fs";
import { createMSTeamsApp, createMSTeamsAdapter } from "./sdk.js";

function makeFakeSdk() {
  const appInstances: Record<string, unknown>[] = [];
  const FakeApp = class {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      appInstances.push(opts);
    }
  };
  return { sdk: { App: FakeApp as any, Client: class {} as any }, appInstances, FakeApp };
}

describe("createMSTeamsApp – secret credentials", () => {
  it("passes clientId, clientSecret, tenantId to sdk.App", () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsSecretCredentials = {
      type: "secret",
      appId: "my-app-id",
      appPassword: "my-secret",
      tenantId: "my-tenant",
    };
    const app = createMSTeamsApp(creds, sdk);
    expect(app).toBeDefined();
    expect(appInstances[0]).toEqual({
      clientId: "my-app-id",
      clientSecret: "my-secret",
      tenantId: "my-tenant",
    });
  });
});

describe("createMSTeamsApp – federated certificate credentials", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----",
    );
  });

  it("reads the certificate and creates app with token function", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
      certificatePath: "/certs/bot.pem",
      certificateThumbprint: "AABB1122",
    };
    createMSTeamsApp(creds, sdk);
    expect(fs.readFileSync).toHaveBeenCalledWith("/certs/bot.pem", "utf-8");
    expect(appInstances[0]).toMatchObject({
      clientId: "fed-app-id",
      tenantId: "fed-tenant",
    });
    expect(typeof appInstances[0].token).toBe("function");
    const token = await (appInstances[0].token as (scope: string) => Promise<string>)(
      "https://api.botframework.com/.default",
    );
    expect(token).toBe("mock-managed-token");
  });

  it("wraps readFileSync errors with descriptive message", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const { sdk } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
      certificatePath: "/missing/cert.pem",
    };
    expect(() => createMSTeamsApp(creds, sdk)).toThrow(
      /Failed to read certificate file at '\/missing\/cert\.pem'/,
    );
  });

  it("throws when federated but no certificatePath and no managedIdentity", () => {
    const { sdk } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "fed-app-id",
      tenantId: "fed-tenant",
    };
    expect(() => createMSTeamsApp(creds, sdk)).toThrow(/certificate path or managed identity/i);
  });
});

describe("createMSTeamsApp – federated managed identity", () => {
  it("creates app with token function for user-assigned MI", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
      managedIdentityClientId: "mi-client-id",
    };
    createMSTeamsApp(creds, sdk);
    expect(appInstances[0]).toMatchObject({ clientId: "mi-app-id", tenantId: "mi-tenant" });
    expect(typeof appInstances[0].token).toBe("function");
    const token = await (appInstances[0].token as (scope: string) => Promise<string>)(
      "https://api.botframework.com/.default",
    );
    expect(token).toBe("mock-managed-token");
  });

  it("creates app with token function for system-assigned MI", async () => {
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
    };
    createMSTeamsApp(creds, sdk);
    expect(typeof appInstances[0].token).toBe("function");
    const token = await (appInstances[0].token as (scope: string) => Promise<string>)(
      "https://api.botframework.com/.default",
    );
    expect(token).toBe("mock-managed-token");
  });

  it("throws from token function when token acquisition fails", async () => {
    mockGetToken.mockResolvedValueOnce(null);
    const { sdk, appInstances } = makeFakeSdk();
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "mi-app-id",
      tenantId: "mi-tenant",
      useManagedIdentity: true,
    };
    createMSTeamsApp(creds, sdk);
    const tokenFn = appInstances[0].token as (scope: string) => Promise<string>;
    await expect(tokenFn("https://api.botframework.com/.default")).rejects.toThrow(
      /failed to acquire token/i,
    );
  });
});

// ── createMSTeamsAdapter tests ─────────────────────────────────────────────

function makeFakeApp() {
  return {
    getBotToken: vi.fn().mockResolvedValue({ toString: () => "fake-bot-token" }),
  } as any;
}

function makeFakeApiSdk() {
  const createFn = vi.fn().mockResolvedValue({ id: "new-activity-id" });
  const FakeClient = class {
    conversations = {
      activities: (_convId: string) => ({ create: createFn }),
    };
  };
  return {
    sdk: { App: class {} as any, Client: FakeClient as any },
    createFn,
  };
}

describe("createMSTeamsAdapter – continueConversation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("provides sendActivity via REST API client in logic callback", async () => {
    const { sdk, createFn } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const reference = {
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversation: { id: "conv-123", conversationType: "personal" },
      channelId: "msteams",
    };

    await adapter.continueConversation("app-id", reference, async (ctx) => {
      await ctx.sendActivity("hello from proactive send");
    });

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message", text: "hello from proactive send" }),
    );
  });

  it("provides deleteActivity via REST DELETE in logic callback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const reference = {
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversation: { id: "conv-456", conversationType: "personal" },
      channelId: "msteams",
    };

    await adapter.continueConversation("app-id", reference, async (ctx) => {
      await ctx.deleteActivity("activity-789");
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/v3/conversations/conv-456/activities/activity-789");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers.Authorization).toBe("Bearer fake-bot-token");
  });

  it("throws when serviceUrl is missing", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    await expect(
      adapter.continueConversation("app-id", { conversation: { id: "c" } } as any, async () => {}),
    ).rejects.toThrow(/Missing serviceUrl/);
  });

  it("throws when conversation.id is missing", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    await expect(
      adapter.continueConversation(
        "app-id",
        { serviceUrl: "https://example.com" } as any,
        async () => {},
      ),
    ).rejects.toThrow(/Missing conversation\.id/);
  });
});

describe("createMSTeamsAdapter – process", () => {
  it("sends 200 for normal message activities", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const req = { body: { type: "message", text: "hi" } };
    const sendFn = vi.fn();
    const res = { status: vi.fn(() => ({ send: sendFn })) };

    await adapter.process(req, res, async () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sendFn).toHaveBeenCalled();
  });

  it("sends 200 immediately for invoke activities", async () => {
    const { sdk } = makeFakeApiSdk();
    const adapter = createMSTeamsAdapter(makeFakeApp(), sdk);

    const req = { body: { type: "invoke", name: "adaptiveCard/action" } };
    const sendFn = vi.fn();
    const res = { status: vi.fn(() => ({ send: sendFn })) };

    let statusCalledBeforeLogic = false;
    await adapter.process(req, res, async () => {
      statusCalledBeforeLogic = res.status.mock.calls.length > 0;
    });

    expect(statusCalledBeforeLogic).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
