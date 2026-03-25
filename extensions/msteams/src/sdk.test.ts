import { describe, it, expect, vi, beforeEach } from "vitest";
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
  // Use function constructors so `new ...Credential()` works
  function ManagedIdentityCredential() {
    return { getToken: mockGetToken };
  }
  function DefaultAzureCredential() {
    return { getToken: mockGetToken };
  }
  function ClientCertificateCredential() {
    return { getToken: mockGetToken };
  }
  return { ManagedIdentityCredential, DefaultAzureCredential, ClientCertificateCredential };
});

import * as fs from "node:fs";
import { createMSTeamsApp } from "./sdk.js";

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
