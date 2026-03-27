import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const authProviderCtorMock = vi.hoisted(() => vi.fn());
const listModelsMock = vi.hoisted(() => vi.fn());
const closeClientMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/agent-runtime");
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
  };
});

vi.mock("oci-common", () => ({
  ConfigFileAuthenticationDetailsProvider: class {
    constructor(configFile: string, profile: string) {
      authProviderCtorMock({ configFile, profile });
    }

    getTenantId() {
      return "ocid1.tenancy.oc1..tenant";
    }
  },
}));

vi.mock("oci-generativeai", () => ({
  GenerativeAiClient: class {
    async listModels(input: unknown) {
      return await listModelsMock(input);
    }

    close() {
      closeClientMock();
    }
  },
}));

let prepareOracleRuntimeAuth: typeof import("./provider.js").prepareOracleRuntimeAuth;
let resolveOracleCatalogProvider: typeof import("./provider.js").resolveOracleCatalogProvider;
let parseOracleRuntimeAuthToken: typeof import("./oci-auth.js").parseOracleRuntimeAuthToken;
let tempDir: string;
let configFile: string;

function setStoredOracleProfile(metadata: Record<string, string>) {
  ensureAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      "oracle:default": {
        type: "api_key",
        provider: "oracle",
        key: configFile,
        metadata,
      },
    },
  });
}

describe("oracle provider auth preparation", () => {
  beforeEach(async () => {
    vi.resetModules();
    ensureAuthProfileStoreMock.mockReset();
    authProviderCtorMock.mockReset();
    listModelsMock.mockReset();
    closeClientMock.mockReset();
    ({ prepareOracleRuntimeAuth, resolveOracleCatalogProvider } = await import("./provider.js"));
    ({ parseOracleRuntimeAuthToken } = await import("./oci-auth.js"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oracle-provider-"));
    configFile = path.join(tempDir, "config");
    fs.writeFileSync(configFile, "[DEFAULT]\ntenancy=ocid1.tenancy.oc1..tenant\n", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("honors env profile and compartment when runtime auth is env-backed", async () => {
    setStoredOracleProfile({
      profile: "STORED_PROFILE",
      compartmentId: "ocid1.compartment.oc1..stored",
    });

    const result = await prepareOracleRuntimeAuth({
      agentDir: tempDir,
      env: {
        OCI_PROFILE: "ENV_PROFILE",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..env",
      } as NodeJS.ProcessEnv,
      provider: "oracle",
      modelId: "oracle/test-model",
      model: {} as never,
      apiKey: configFile,
      authMode: "api_key",
    });

    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(authProviderCtorMock).toHaveBeenCalledWith({
      configFile,
      profile: "ENV_PROFILE",
    });
    expect(parseOracleRuntimeAuthToken(result.apiKey)).toMatchObject({
      configFile,
      profile: "ENV_PROFILE",
      compartmentId: "ocid1.compartment.oc1..env",
      tenancyId: "ocid1.tenancy.oc1..tenant",
    });
  });

  it("keeps stored profile metadata for profile-backed runtime auth", async () => {
    setStoredOracleProfile({
      profile: "STORED_PROFILE",
      compartmentId: "ocid1.compartment.oc1..stored",
    });

    const result = await prepareOracleRuntimeAuth({
      agentDir: tempDir,
      env: {
        OCI_PROFILE: "ENV_PROFILE",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..env",
      } as NodeJS.ProcessEnv,
      provider: "oracle",
      modelId: "oracle/test-model",
      model: {} as never,
      apiKey: configFile,
      authMode: "api_key",
      profileId: "oracle:default",
    });

    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(tempDir, {
      allowKeychainPrompt: false,
    });
    expect(authProviderCtorMock).toHaveBeenCalledWith({
      configFile,
      profile: "STORED_PROFILE",
    });
    expect(parseOracleRuntimeAuthToken(result.apiKey)).toMatchObject({
      configFile,
      profile: "STORED_PROFILE",
      compartmentId: "ocid1.compartment.oc1..stored",
    });
  });

  it("ignores stored metadata during env-backed catalog discovery", async () => {
    setStoredOracleProfile({
      profile: "STORED_PROFILE",
      compartmentId: "ocid1.compartment.oc1..stored",
    });
    listModelsMock.mockResolvedValue({
      modelCollection: {
        items: [
          {
            id: "ocid1.generativeaimodel.oc1..model",
            displayName: "command-r",
            vendor: "cohere",
            lifecycleState: "ACTIVE",
            type: "BASE",
            capabilities: ["CHAT"],
          },
        ],
      },
    });

    const result = await resolveOracleCatalogProvider({
      config: {} as never,
      agentDir: tempDir,
      workspaceDir: tempDir,
      env: {
        OCI_PROFILE: "ENV_PROFILE",
        OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..env",
      } as NodeJS.ProcessEnv,
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: "OCI_CONFIG_FILE",
        discoveryApiKey: configFile,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
    expect(authProviderCtorMock).toHaveBeenCalledWith({
      configFile,
      profile: "ENV_PROFILE",
    });
    expect(listModelsMock).toHaveBeenCalledWith({
      compartmentId: "ocid1.compartment.oc1..env",
    });
    expect(result).toMatchObject({
      provider: {
        baseUrl: "oci://generative-ai",
        api: "openai-completions",
        apiKey: configFile,
        models: [
          expect.objectContaining({
            id: "ocid1.generativeaimodel.oc1..model",
            name: "command-r",
          }),
        ],
      },
    });
  });
});
