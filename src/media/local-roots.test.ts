import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalMediaRoot } from "./local-media-access.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
  getDefaultMediaLocalRoots,
} from "./local-roots.js";

function normalizeHostPath(value: string): string {
  return path.normalize(path.resolve(value));
}

function normalizeMediaRootPath(root: LocalMediaRoot): string {
  return normalizeHostPath(typeof root === "string" ? root : root.path);
}

function asMediaRoots(roots: readonly string[]): readonly LocalMediaRoot[] {
  return roots as unknown as readonly LocalMediaRoot[];
}

describe("local media roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps temp, media cache, and workspace roots by default", () => {
    const stateDir = path.join("/tmp", "openclaw-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getDefaultMediaLocalRoots();
    const normalizedRoots = roots.map(normalizeHostPath);

    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "media")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "sandboxes")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(path.join(stateDir, "agents")));
    expect(roots.length).toBeGreaterThanOrEqual(3);
  });

  it("adds the active agent workspace without re-opening broad agent state roots", () => {
    const stateDir = path.join("/tmp", "openclaw-agent-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const roots = getAgentScopedMediaLocalRoots({}, "ops");
    const normalizedRoots = roots.map(normalizeHostPath);

    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "workspace-ops")));
    expect(normalizedRoots).toContain(normalizeHostPath(path.join(stateDir, "sandboxes")));
    expect(normalizedRoots).not.toContain(normalizeHostPath(path.join(stateDir, "agents")));
  });

  it("adds concrete parent roots for local media sources without widening to filesystem root", () => {
    const picturesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Pictures" : "/Users/peter/Pictures";
    const moviesDir =
      process.platform === "win32" ? "C:\\Users\\peter\\Movies" : "/Users/peter/Movies";

    const roots = appendLocalMediaParentRoots(
      ["/tmp/base"],
      [
        path.join(picturesDir, "photo.png"),
        pathToFileURL(path.join(moviesDir, "clip.mp4")).href,
        "https://example.com/remote.png",
        "/top-level-file.png",
      ],
    );

    expect(roots.map(normalizeHostPath)).toEqual(
      expect.arrayContaining([
        normalizeHostPath("/tmp/base"),
        normalizeHostPath(picturesDir),
        normalizeHostPath(moviesDir),
      ]),
    );
    expect(roots.map(normalizeHostPath)).not.toContain(normalizeHostPath("/"));
  });

  it("widens agent media roots for concrete local sources only when workspaceOnly is disabled", () => {
    const stateDir = path.join("/tmp", "openclaw-flexible-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const flexibleRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: {},
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
    expect(flexibleRoots.map(normalizeHostPath)).toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );

    const strictRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: { tools: { fs: { workspaceOnly: true } } },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
    expect(strictRoots.map(normalizeHostPath)).not.toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );
  });

  it("keeps media roots strict when workspaceOnly and roots are both set", () => {
    const stateDir = path.join("/tmp", "openclaw-mixed-media-roots-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const strictRoots = getAgentScopedMediaLocalRootsForSources({
      cfg: {
        tools: {
          fs: {
            workspaceOnly: true,
            roots: [{ path: "/packs/shared", kind: "dir", access: "ro" }],
          },
        },
      },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(asMediaRoots(strictRoots).map(normalizeMediaRootPath)).not.toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );
  });

  it("uses configured fs roots for outbound media sources instead of widening by source parent", () => {
    const roots = getAgentScopedMediaLocalRootsForSources({
      cfg: {
        tools: {
          fs: {
            roots: [{ path: "/packs/shared/file.txt", kind: "file", access: "ro" }],
          },
        },
      },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(asMediaRoots(roots)).toEqual([
      {
        path: normalizeHostPath("/packs/shared/file.txt"),
        kind: "file",
        access: "ro",
      },
    ]);
    expect(asMediaRoots(roots).map(normalizeMediaRootPath)).not.toContain(
      normalizeHostPath("/Users/peter/Pictures"),
    );
  });

  it("preserves empty fs roots as deny-all for outbound media sources", () => {
    const roots = getAgentScopedMediaLocalRootsForSources({
      cfg: {
        tools: {
          fs: {
            roots: [],
          },
        },
      },
      agentId: "ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(roots).toEqual([]);
  });
});
