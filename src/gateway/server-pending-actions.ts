/**
 * Recover deferred sessions_manage actions that were persisted before a gateway restart.
 *
 * When sessions_manage schedules a deferred compact or reset, it writes pendingAction
 * to the session store and sets up an in-memory callback via waitForEmbeddedPiRunEnd().
 * If the gateway restarts, the callback is lost but the pendingAction persists.
 *
 * This module scans session stores on startup and:
 * - Clears stale pendingAction entries (older than MAX_AGE_MS)
 * - Executes recent pendingAction entries (compact or reset)
 *
 * Called from server-startup.ts after the gateway is ready.
 */

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { compactEmbeddedPiSession } from "../agents/pi-embedded-runner/compact.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

/** Discard pendingAction entries older than 30 minutes (likely stale from a crash). */
const MAX_AGE_MS = 30 * 60 * 1000;

export async function recoverPendingActions(params: {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const { log } = params;
  const cfg = loadConfig();

  try {
    const combined = loadCombinedSessionStoreForGateway(cfg);
    let found = 0;
    let recovered = 0;
    let cleared = 0;

    for (const [key, entry] of Object.entries(combined.store)) {
      if (!entry?.pendingAction) {
        continue;
      }
      found++;

      const { type, scheduledAt, instructions } = entry.pendingAction;
      const ageMs = Date.now() - (scheduledAt ?? 0);

      if (ageMs > MAX_AGE_MS) {
        // Too old — clear it silently
        log.info(
          `pending-actions: clearing stale ${type} action on ${key} (age: ${Math.round(ageMs / 60000)}m)`,
        );
        const target = resolveGatewaySessionStoreTarget({ cfg, key });
        await updateSessionStore(target.storePath, (store) => {
          const e = store[key];
          if (e?.pendingAction) {
            delete e.pendingAction;
          }
        });
        cleared++;
        continue;
      }

      // Recent — try to execute it
      log.info(
        `pending-actions: recovering ${type} action on ${key} (age: ${Math.round(ageMs / 60000)}m)`,
      );

      try {
        if (type === "reset") {
          await performGatewaySessionReset({
            key,
            reason: "reset",
            commandSource: "gateway:pending-action-recovery",
          });
          recovered++;
        } else if (type === "compact") {
          const agentId = resolveAgentIdFromSessionKey(key) ?? resolveDefaultAgentId(cfg);
          const target = resolveGatewaySessionStoreTarget({ cfg, key });
          const sessionFile = resolveSessionFilePath(
            entry.sessionId,
            entry,
            resolveSessionFilePathOptions({ agentId, storePath: target.storePath }),
          );
          const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

          await compactEmbeddedPiSession({
            sessionId: entry.sessionId,
            sessionKey: key,
            sessionFile,
            workspaceDir,
            config: cfg,
            trigger: "manual",
            customInstructions: instructions,
            allowGatewaySubagentBinding: true,
          });
          recovered++;
        }
      } catch (err) {
        log.warn(`pending-actions: failed to recover ${type} on ${key}: ${String(err)}`);
      }

      // Clear the pendingAction regardless of success/failure
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      await updateSessionStore(target.storePath, (store) => {
        const e = store[key];
        if (e?.pendingAction) {
          delete e.pendingAction;
        }
      });
    }

    if (found > 0) {
      log.info(
        `pending-actions: ${found} found, ${recovered} recovered, ${cleared} cleared (stale)`,
      );
    }
  } catch (err) {
    log.warn(`pending-actions: recovery scan failed: ${String(err)}`);
  }
}
