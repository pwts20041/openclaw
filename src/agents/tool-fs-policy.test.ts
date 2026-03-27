import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEffectiveToolFsWorkspaceOnly,
  resolveToolFsConfig,
  createToolFsPolicy,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("preserves workspaceOnly for sandbox-sensitive callers when roots are also set", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {
          workspaceOnly: true,
          roots: [{ path: "/custom/root", kind: "dir", access: "rw" }],
        },
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });
});

describe("resolveToolFsConfig", () => {
  it("returns roots and preserves workspaceOnly for sandbox callers", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {
          workspaceOnly: true,
          roots: [{ path: "/custom/root", kind: "dir", access: "rw" }],
        },
      },
    };
    const fsConfig = resolveToolFsConfig({ cfg });
    expect(fsConfig.roots).toBeDefined();
    expect(fsConfig.roots).toHaveLength(1);
    expect(fsConfig.workspaceOnly).toBe(true);
  });

  it("falls back to workspaceOnly when no roots", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    const fsConfig = resolveToolFsConfig({ cfg });
    expect(fsConfig.roots).toBeUndefined();
    expect(fsConfig.workspaceOnly).toBe(true);
  });

  it("agent-level roots override global roots", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: {
          roots: [{ path: "/global/root", kind: "dir", access: "rw" }],
        },
      },
      agents: {
        list: [
          {
            id: "test-agent",
            tools: {
              fs: {
                roots: [{ path: "/agent/root", kind: "dir", access: "ro" }],
              },
            },
          },
        ],
      },
    };
    const fsConfig = resolveToolFsConfig({ cfg, agentId: "test-agent" });
    expect(fsConfig.roots).toHaveLength(1);
    expect(fsConfig.roots![0].path).toBe("/agent/root");
  });

  it("returns empty config when nothing set", () => {
    const fsConfig = resolveToolFsConfig({ cfg: {} });
    expect(fsConfig.roots).toBeUndefined();
    expect(fsConfig.workspaceOnly).toBeUndefined();
  });

  it("preserves empty roots array as deny-all policy", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { roots: [] } },
    };
    const fsConfig = resolveToolFsConfig({ cfg });
    expect(fsConfig.roots).toBeDefined();
    expect(fsConfig.roots).toHaveLength(0);
    expect(fsConfig.workspaceOnly).toBeUndefined();
  });
});

describe("createToolFsPolicy", () => {
  it("preserves workspaceOnly when roots also provided (sandbox fallback)", () => {
    const policy = createToolFsPolicy({
      workspaceOnly: true,
      roots: [{ path: "/root", kind: "dir", access: "rw" }],
    });
    // workspaceOnly preserved — in sandbox mode, roots are ignored and
    // workspaceOnly must still be honored as the fallback guard
    expect(policy.workspaceOnly).toBe(true);
    expect(policy.roots).toHaveLength(1);
  });

  it("preserves workspaceOnly when no roots", () => {
    const policy = createToolFsPolicy({ workspaceOnly: true });
    expect(policy.workspaceOnly).toBe(true);
    expect(policy.roots).toBeUndefined();
  });

  it("defaults workspaceOnly to false", () => {
    const policy = createToolFsPolicy({});
    expect(policy.workspaceOnly).toBe(false);
    expect(policy.roots).toBeUndefined();
  });
});
