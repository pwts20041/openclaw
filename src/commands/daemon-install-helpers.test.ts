import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

let stateDirForTest: string | undefined;

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.OPENCLAW_STATE_DIR;
  if (stateDirForTest) {
    fs.rmSync(stateDirForTest, { recursive: true, force: true });
    stateDirForTest = undefined;
  }
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

function mockNodeGatewayPlanFixture(
  params: {
    workingDirectory?: string;
    version?: string;
    supported?: boolean;
    warning?: string;
    serviceEnvironment?: Record<string, string>;
  } = {},
) {
  const {
    workingDirectory = "/Users/me",
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory,
  });
  mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node",
    version,
    supported,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
}

describe("buildGatewayInstallPlan", () => {
  // Prevent tests from reading the developer's real ~/.openclaw/.env when
  // passing `env: {}` (which falls back to os.homedir for state-dir resolution).
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HOME: isolatedHome },
        port: 3000,
        extraPathDirs: ["/custom"],
      }),
    );
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mockNodeGatewayPlanFixture();

    await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "node",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        extraPathDirs: undefined,
      }),
    );
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      version: "18.0.0",
      supported: false,
      warning: "Node too old",
      serviceEnvironment: {},
    });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });

  it("does not merge env-backed auth-profile refs into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    stateDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDirForTest;
    fs.writeFileSync(
      path.join(stateDirForTest, ".env"),
      "OPENAI_API_KEY=openai-test-value\nANTHROPIC_TOKEN=anthropic-test-value\n",
      "utf8",
    );
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENCLAW_STATE_DIR: stateDirForTest,
        OPENAI_API_KEY: "openai-test-value",
        ANTHROPIC_TOKEN: "anthropic-test-value",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBeUndefined();
    expect(plan.environment.ANTHROPIC_TOKEN).toBeUndefined();
  });

  it("blocks dangerous auth-profile env refs from the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "node:default": {
          type: "token",
          provider: "node",
          tokenRef: { source: "env", provider: "default", id: "NODE_OPTIONS" },
        },
        "git:default": {
          type: "token",
          provider: "git",
          tokenRef: { source: "env", provider: "default", id: "GIT_ASKPASS" },
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const warn = vi.fn();
    const plan = await buildGatewayInstallPlan({
      env: {
        NODE_OPTIONS: "--require ./pwn.js",
        GIT_ASKPASS: "/tmp/askpass.sh",
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
      },
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GIT_ASKPASS).toBeUndefined();
    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NODE_OPTIONS"), "Auth profile");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GIT_ASKPASS"), "Auth profile");
  });

  it("skips non-portable auth-profile env ref keys", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "broken:default": {
          type: "token",
          provider: "broken",
          tokenRef: { source: "env", provider: "default", id: "BAD KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        "BAD KEY": "should-not-pass",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment["BAD KEY"]).toBeUndefined();
  });

  it("keeps shell-only env-backed auth-profile refs in the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    stateDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDirForTest;
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENCLAW_STATE_DIR: stateDirForTest,
        OPENAI_API_KEY: "openai-test-value",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("openai-test-value");
  });

  it("does not suppress shell value when durable .env has empty placeholder", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });
    stateDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDirForTest;
    // Write an empty placeholder — should NOT block shell injection.
    fs.writeFileSync(path.join(stateDirForTest, ".env"), "OPENAI_API_KEY=\n", "utf8");
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { OPENCLAW_STATE_DIR: stateDirForTest, OPENAI_API_KEY: "shell-value" },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("shell-value");
  });

  it("does not suppress shell value when durable .env has unresolved placeholder", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });
    stateDirForTest = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDirForTest;
    // dotenv stores $-expressions literally — should NOT be treated as usable durable values.
    // Covers ${VAR}, $VAR, ${VAR:-fallback}, ${VAR-default}, etc.
    fs.writeFileSync(
      path.join(stateDirForTest, ".env"),
      "OPENAI_API_KEY=${OPENAI_API_KEY:-fallback}\n",
      "utf8",
    );
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { OPENCLAW_STATE_DIR: stateDirForTest, OPENAI_API_KEY: "shell-value" },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("shell-value");
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Startup-folder login item");
    expect(gatewayInstallErrorHint("win32")).toContain("elevated PowerShell");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
