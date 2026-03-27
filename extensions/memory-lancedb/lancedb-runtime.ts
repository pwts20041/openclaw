import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveStateDir } from "./api.js";

type LanceDbModule = typeof import("@lancedb/lancedb");

export type LanceDbRuntimeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type RuntimeManifest = {
  name: string;
  private: true;
  type: "module";
  dependencies: Record<string, string>;
};

type LanceDbRuntimeLoaderDeps = {
  env: NodeJS.ProcessEnv;
  resolveStateDir: (env?: NodeJS.ProcessEnv, homedir?: () => string) => string;
  runtimeManifest: RuntimeManifest;
  importBundled: () => Promise<LanceDbModule>;
  importResolved: (resolvedPath: string) => Promise<LanceDbModule>;
  resolveRuntimeEntry: (params: { runtimeDir: string; manifest: RuntimeManifest }) => string | null;
  installRuntime: (params: {
    runtimeDir: string;
    manifest: RuntimeManifest;
    env: NodeJS.ProcessEnv;
    logger?: LanceDbRuntimeLogger;
  }) => Promise<string>;
};

/**
 * Resolve the package.json path for the memory-lancedb plugin.
 * Uses createRequire to handle both development and bundled environments correctly.
 * In bundled mode, import.meta.url may point to a different location than expected.
 */
function resolvePackageJsonPath(): string {
  const pluginRequire = createRequire(import.meta.url);

  // Strategy 1: Try to resolve relative to this module's URL
  // Works in development mode where files are not bundled
  try {
    const relativePath = pluginRequire.resolve("./package.json");
    if (fs.existsSync(relativePath)) {
      return relativePath;
    }
  } catch {
    // Continue to fallback strategies
  }

  // Strategy 2: In bundled mode, look for extensions/memory-lancedb/package.json
  // relative to the dist directory
  try {
    // Get the dist directory by resolving the main openclaw package
    const openclawMain = pluginRequire.resolve("openclaw");
    const distDir = path.dirname(openclawMain);
    const bundledPackageJson = path.join(distDir, "extensions", "memory-lancedb", "package.json");
    if (fs.existsSync(bundledPackageJson)) {
      return bundledPackageJson;
    }
  } catch {
    // Continue to fallback strategies
  }

  // Strategy 3: Try to find it relative to the @lancedb/lancedb package location
  try {
    const lancedbEntry = pluginRequire.resolve("@lancedb/lancedb");
    // Walk up to find the memory-lancedb plugin directory
    let currentDir = path.dirname(lancedbEntry);
    for (let i = 0; i < 15 && currentDir !== "/"; i++) {
      const candidatePath = path.join(currentDir, "package.json");
      if (fs.existsSync(candidatePath)) {
        const content = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as {
          name?: string;
        };
        if (content.name === "@openclaw/memory-lancedb" || content.name === "memory-lancedb") {
          return candidatePath;
        }
      }
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Ignore resolution errors
  }

  // Strategy 4: Walk up from current module location looking for extensions/memory-lancedb
  try {
    let currentDir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10 && currentDir !== "/"; i++) {
      const candidatePath = path.join(currentDir, "extensions", "memory-lancedb", "package.json");
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
      // Also check for direct package.json with the right name
      const directPath = path.join(currentDir, "package.json");
      if (fs.existsSync(directPath)) {
        const content = JSON.parse(fs.readFileSync(directPath, "utf8")) as {
          name?: string;
        };
        if (content.name === "@openclaw/memory-lancedb" || content.name === "memory-lancedb") {
          return directPath;
        }
      }
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Ignore resolution errors
  }

  throw new Error("memory-lancedb: could not resolve package.json path");
}

function buildRuntimeManifest(): RuntimeManifest {
  const packageJsonPath = resolvePackageJsonPath();
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const lanceDbSpec = packageJson.dependencies?.["@lancedb/lancedb"];
  if (!lanceDbSpec) {
    throw new Error('memory-lancedb package.json is missing "@lancedb/lancedb"');
  }
  return {
    name: "openclaw-memory-lancedb-runtime",
    private: true,
    type: "module",
    dependencies: {
      "@lancedb/lancedb": lanceDbSpec,
    },
  };
}

// Lazily compute the manifest to avoid issues during module initialization
let _runtimeManifest: RuntimeManifest | null = null;

function getRuntimeManifest(): RuntimeManifest {
  if (!_runtimeManifest) {
    _runtimeManifest = buildRuntimeManifest();
  }
  return _runtimeManifest;
}

function resolveRuntimeDir(stateDir: string): string {
  return path.join(stateDir, "plugin-runtimes", "memory-lancedb", "lancedb");
}

function readRuntimeManifest(filePath: string): RuntimeManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeManifest;
  } catch {
    return null;
  }
}

function manifestsMatch(actual: RuntimeManifest | null, expected: RuntimeManifest): boolean {
  if (!actual) {
    return false;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function defaultResolveRuntimeEntry(params: {
  runtimeDir: string;
  manifest: RuntimeManifest;
}): string | null {
  const runtimePackagePath = path.join(params.runtimeDir, "package.json");
  if (!manifestsMatch(readRuntimeManifest(runtimePackagePath), params.manifest)) {
    return null;
  }
  try {
    const runtimeRequire = createRequire(runtimePackagePath);
    return runtimeRequire.resolve("@lancedb/lancedb");
  } catch {
    return null;
  }
}

function collectSpawnOutput(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function defaultInstallRuntime(params: {
  runtimeDir: string;
  manifest: RuntimeManifest;
  env: NodeJS.ProcessEnv;
  logger?: LanceDbRuntimeLogger;
}): Promise<string> {
  const runtimePackagePath = path.join(params.runtimeDir, "package.json");
  const currentManifest = readRuntimeManifest(runtimePackagePath);
  if (!manifestsMatch(currentManifest, params.manifest)) {
    await fs.promises.rm(path.join(params.runtimeDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    await fs.promises.rm(path.join(params.runtimeDir, "package-lock.json"), { force: true });
  }

  await fs.promises.mkdir(params.runtimeDir, { recursive: true });
  await fs.promises.writeFile(
    runtimePackagePath,
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf8",
  );

  const install = await collectSpawnOutput({
    command: "npm",
    args: ["install", "--omit=dev", "--silent", "--ignore-scripts", "--package-lock=false"],
    cwd: params.runtimeDir,
    env: params.env,
  });
  if (install.error) {
    const spawnError = install.error as NodeJS.ErrnoException;
    throw new Error(
      spawnError.code === "ENOENT"
        ? "npm is required to install the LanceDB runtime but was not found on PATH"
        : install.error.message,
    );
  }
  if ((install.code ?? 0) !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim();
    throw new Error(detail || `npm exited with code ${install.code ?? "unknown"}`);
  }

  const resolved = defaultResolveRuntimeEntry({
    runtimeDir: params.runtimeDir,
    manifest: params.manifest,
  });
  if (!resolved) {
    throw new Error("installed LanceDB runtime is missing the @lancedb/lancedb entry");
  }
  params.logger?.info?.(`memory-lancedb: installed LanceDB runtime under ${params.runtimeDir}`);
  return resolved;
}

function defaultImportResolved(resolvedPath: string): Promise<LanceDbModule> {
  return import(pathToFileURL(resolvedPath).href);
}

function buildLoadFailureMessage(prefix: string, error: unknown): string {
  return `memory-lancedb: ${prefix}. ${String(error)}`;
}

export function createLanceDbRuntimeLoader(overrides: Partial<LanceDbRuntimeLoaderDeps> = {}): {
  load: (logger?: LanceDbRuntimeLogger) => Promise<LanceDbModule>;
} {
  const deps: LanceDbRuntimeLoaderDeps = {
    env: overrides.env ?? process.env,
    resolveStateDir: overrides.resolveStateDir ?? resolveStateDir,
    runtimeManifest: overrides.runtimeManifest ?? getRuntimeManifest(),
    importBundled: overrides.importBundled ?? (() => import("@lancedb/lancedb")),
    importResolved: overrides.importResolved ?? defaultImportResolved,
    resolveRuntimeEntry: overrides.resolveRuntimeEntry ?? defaultResolveRuntimeEntry,
    installRuntime: overrides.installRuntime ?? defaultInstallRuntime,
  };

  let loadPromise: Promise<LanceDbModule> | null = null;

  return {
    async load(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            return await deps.importBundled();
          } catch (bundledError) {
            const runtimeDir = resolveRuntimeDir(
              deps.resolveStateDir(deps.env, () =>
                deps.env.HOME?.trim() ? deps.env.HOME : os.homedir(),
              ),
            );
            const existingRuntime = deps.resolveRuntimeEntry({
              runtimeDir,
              manifest: deps.runtimeManifest,
            });
            if (existingRuntime) {
              try {
                return await deps.importResolved(existingRuntime);
              } catch {
                // Reinstall below when the cached runtime is incomplete or stale.
              }
            }
            if (deps.env.OPENCLAW_NIX_MODE === "1") {
              throw new Error(
                buildLoadFailureMessage(
                  "failed to load LanceDB and Nix mode disables auto-install",
                  bundledError,
                ),
                { cause: bundledError },
              );
            }
            logger?.warn?.(
              `memory-lancedb: bundled LanceDB runtime unavailable (${String(bundledError)}); installing runtime deps under ${runtimeDir}`,
            );
            const installedEntry = await deps.installRuntime({
              runtimeDir,
              manifest: deps.runtimeManifest,
              env: deps.env,
              logger,
            });
            try {
              return await deps.importResolved(installedEntry);
            } catch (runtimeError) {
              throw new Error(
                buildLoadFailureMessage(
                  "failed to load LanceDB after installing runtime deps",
                  runtimeError,
                ),
                { cause: runtimeError },
              );
            }
          }
        })().catch((error) => {
          loadPromise = null;
          throw error;
        });
      }
      return await loadPromise;
    },
  };
}

const defaultLoader = createLanceDbRuntimeLoader();

export async function loadLanceDbModule(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
  return await defaultLoader.load(logger);
}
