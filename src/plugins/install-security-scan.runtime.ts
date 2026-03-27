import path from "node:path";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

function buildCriticalDetails(params: {
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
}) {
  return params.findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => `${finding.message} (${finding.file}:${finding.line})`)
    .join("; ");
}

export async function scanBundleInstallSourceRuntime(params: {
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}) {
  let builtinFindings: Array<{
    ruleId: string;
    severity: "info" | "warn" | "critical";
    file: string;
    line: number;
    message: string;
  }> = [];
  try {
    const scanSummary = await scanDirectoryWithSummary(params.sourceDir);
    builtinFindings = scanSummary.findings;
    if (scanSummary.critical > 0) {
      params.logger.warn?.(
        `WARNING: Bundle "${params.pluginId}" contains dangerous code patterns: ${buildCriticalDetails({ findings: scanSummary.findings })}`,
      );
      return;
    }
    if (scanSummary.warn > 0) {
      params.logger.warn?.(
        `Bundle "${params.pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    params.logger.warn?.(
      `Bundle "${params.pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }

  // Run before_skill_install hook so external scanners can audit bundles.
  try {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_skill_install")) {
      const hookResult = await hookRunner.runBeforeSkillInstall(
        {
          skillName: params.pluginId,
          sourceDir: params.sourceDir,
          builtinFindings,
        },
        {},
      );
      if (hookResult?.block) {
        params.logger.warn?.(
          `WARNING: Bundle "${params.pluginId}" installation blocked by plugin hook: ${hookResult.blockReason || "no reason given"}`,
        );
      }
      if (hookResult?.findings) {
        for (const finding of hookResult.findings) {
          if (finding.severity === "critical" || finding.severity === "warn") {
            params.logger.warn?.(
              `Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`,
            );
          }
        }
      }
    }
  } catch {
    // Hook errors are non-fatal.
  }
}

export async function scanPackageInstallSourceRuntime(params: {
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
}) {
  const forcedScanEntries: string[] = [];
  for (const entry of params.extensions) {
    const resolvedEntry = path.resolve(params.packageDir, entry);
    if (!isPathInside(params.packageDir, resolvedEntry)) {
      params.logger.warn?.(
        `extension entry escapes plugin directory and will not be scanned: ${entry}`,
      );
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      params.logger.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }

  let builtinFindings: Array<{
    ruleId: string;
    severity: "info" | "warn" | "critical";
    file: string;
    line: number;
    message: string;
  }> = [];
  try {
    const scanSummary = await scanDirectoryWithSummary(params.packageDir, {
      includeFiles: forcedScanEntries,
    });
    builtinFindings = scanSummary.findings;
    if (scanSummary.critical > 0) {
      params.logger.warn?.(
        `WARNING: Plugin "${params.pluginId}" contains dangerous code patterns: ${buildCriticalDetails({ findings: scanSummary.findings })}`,
      );
      return;
    }
    if (scanSummary.warn > 0) {
      params.logger.warn?.(
        `Plugin "${params.pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    params.logger.warn?.(
      `Plugin "${params.pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }

  // Run before_skill_install hook so external scanners can audit packages.
  try {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_skill_install")) {
      const hookResult = await hookRunner.runBeforeSkillInstall(
        {
          skillName: params.pluginId,
          sourceDir: params.packageDir,
          builtinFindings,
        },
        {},
      );
      if (hookResult?.block) {
        params.logger.warn?.(
          `WARNING: Plugin "${params.pluginId}" installation blocked by plugin hook: ${hookResult.blockReason || "no reason given"}`,
        );
      }
      if (hookResult?.findings) {
        for (const finding of hookResult.findings) {
          if (finding.severity === "critical" || finding.severity === "warn") {
            params.logger.warn?.(
              `Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`,
            );
          }
        }
      }
    }
  } catch {
    // Hook errors are non-fatal.
  }
}
