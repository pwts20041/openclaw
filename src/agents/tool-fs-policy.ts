import type { OpenClawConfig } from "../config/config.js";
import type { FsRoot } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  roots?: FsRoot[];
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  roots?: FsRoot[];
}): ToolFsPolicy {
  if (params.roots && params.workspaceOnly) {
    console.warn(
      "[tools.fs] Both workspaceOnly and roots are set. roots takes precedence — remove workspaceOnly to avoid ambiguity.",
    );
  }
  return {
    // Preserve workspaceOnly even when roots is set — in sandbox mode, roots are
    // ignored and workspaceOnly must still be honored as the fallback guard.
    // In host mode, pi-tools.ts uses roots (not workspaceOnly) when both exist.
    workspaceOnly: params.workspaceOnly === true,
    roots: params.roots,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  roots?: FsRoot[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  const workspaceOnly = agentFs?.workspaceOnly ?? globalFs?.workspaceOnly;

  // Agent-level roots take full precedence
  const roots = agentFs?.roots ?? globalFs?.roots;
  // Empty roots array is a valid deny-all policy — don't fall through to unrestricted
  if (roots) {
    return { roots, workspaceOnly };
  }

  return {
    workspaceOnly,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const config = resolveToolFsConfig(params);
  // Preserve workspaceOnly even when roots is set — in sandbox mode, roots are
  // ignored and workspaceOnly must still be honored (e.g., prompt-image auto-load).
  // In host mode, pi-tools.ts uses roots instead of workspaceOnly when both exist.
  return config.workspaceOnly === true;
}
