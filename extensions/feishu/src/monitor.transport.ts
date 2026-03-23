import * as http from "http";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  readJsonBodyWithLimit,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk/feishu";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/infra-runtime";
import { createFeishuWSClient } from "./client.js";
import {
  botNames,
  botOpenIds,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
};

function isFeishuWebhookPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildFeishuWebhookEnvelope(
  req: http.IncomingMessage,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create({ headers: req.headers }), payload) as Record<string, unknown>;
}

function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  payload: Record<string, unknown>;
  encryptKey?: string;
}): boolean {
  const encryptKey = params.encryptKey?.trim();
  if (!encryptKey) {
    return true;
  }

  const timestampHeader = params.headers["x-lark-request-timestamp"];
  const nonceHeader = params.headers["x-lark-request-nonce"];
  const signatureHeader = params.headers["x-lark-signature"];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(params.payload))
    .digest("hex");
  return computedSignature === signature;
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/**
 * How long to wait after detecting that the Lark SDK has gone silent (no
 * reconnect activity) before we declare it dead and start a new cycle.
 * The Lark SDK's own reconnect intervals can be up to ~60 s, so we give it
 * extra headroom before we step in.
 */
const FEISHU_WS_STALL_DETECT_MS = 90_000;

/**
 * How often we poll the SDK's reconnect-info to decide if it has stalled.
 */
const FEISHU_WS_STALL_POLL_MS = 10_000;

/**
 * Backoff policy for the OpenClaw-level supervisor loop.  Each cycle
 * represents the Lark SDK exhausting all of its own server-configured
 * reconnect attempts.
 */
const FEISHU_WS_SUPERVISOR_RECONNECT_POLICY = {
  initialMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.25,
} as const;

/**
 * Start the Lark WSClient and return a promise that resolves once the
 * client has gone silent (SDK retry budget exhausted or stall detected).
 * Rejects only on abort.
 */
function runFeishuWSClientUntilDead(params: {
  wsClient: Lark.WSClient;
  eventDispatcher: Lark.EventDispatcher;
  accountId: string;
  log: (msg: string) => void;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { wsClient, eventDispatcher, accountId, log, abortSignal } = params;

  return new Promise<void>((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }

    wsClient.start({ eventDispatcher });
    log(`feishu[${accountId}]: WebSocket client started`);

    // Poll for stall: if the SDK hasn't attempted a (re)connect within
    // FEISHU_WS_STALL_DETECT_MS, we treat it as having given up.
    let lastSeenConnectTime = wsClient.getReconnectInfo().lastConnectTime;
    let lastActivityAt = Date.now();

    const handleAbort = () => {
      clearInterval(stallPoller);
      resolve();
    };

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    const stallPoller = setInterval(() => {
      if (abortSignal?.aborted) {
        clearInterval(stallPoller);
        return;
      }
      const info = wsClient.getReconnectInfo();
      if (info.lastConnectTime !== lastSeenConnectTime) {
        // SDK is still actively (re)connecting — reset the stall clock.
        lastSeenConnectTime = info.lastConnectTime;
        lastActivityAt = Date.now();
        return;
      }
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= FEISHU_WS_STALL_DETECT_MS) {
        log(
          `feishu[${accountId}]: WebSocket stall detected (no reconnect activity for ${Math.round(idleMs / 1000)}s); will restart supervisor cycle`,
        );
        clearInterval(stallPoller);
        abortSignal?.removeEventListener("abort", handleAbort);
        resolve();
      }
    }, FEISHU_WS_STALL_POLL_MS);
  });
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const cleanup = () => {
    wsClients.delete(accountId);
    botOpenIds.delete(accountId);
    botNames.delete(accountId);
  };

  if (abortSignal?.aborted) {
    cleanup();
    return;
  }

  let supervisorAttempt = 0;

  // Supervisor loop: each iteration creates a new WSClient and runs it until
  // either (a) abort is requested or (b) the SDK's internal retry budget is
  // exhausted.  We then back off and start a fresh cycle.
  while (!abortSignal?.aborted) {
    log(
      `feishu[${accountId}]: starting WebSocket connection... (supervisor cycle ${supervisorAttempt + 1})`,
    );

    let wsClient: Lark.WSClient;
    try {
      wsClient = createFeishuWSClient(account);
    } catch (err) {
      // Non-recoverable config error (missing credentials etc.).
      cleanup();
      throw err;
    }

    wsClients.set(accountId, wsClient);

    try {
      await runFeishuWSClientUntilDead({
        wsClient,
        eventDispatcher,
        accountId,
        log,
        abortSignal,
      });
    } finally {
      // Always close the stale SDK client before creating a fresh one.
      try {
        wsClient.close({ force: true });
      } catch {
        // Ignore close errors; the important thing is the new client starts clean.
      }
    }

    if (abortSignal?.aborted) {
      break;
    }

    supervisorAttempt += 1;
    const delayMs = computeBackoff(FEISHU_WS_SUPERVISOR_RECONNECT_POLICY, supervisorAttempt);
    error(
      `feishu[${accountId}]: WebSocket supervisor restarting (attempt ${supervisorAttempt}) in ${Math.round(delayMs / 1000)}s`,
    );

    try {
      await sleepWithAbort(delayMs, abortSignal);
    } catch {
      // Abort during sleep — exit loop.
      break;
    }
  }

  cleanup();
}

export async function monitorWebhook({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";
  const host = account.config.webhookHost ?? "127.0.0.1";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  const server = http.createServer();

  server.on("request", (req, res) => {
    res.on("finish", () => {
      recordWebhookStatus(runtime, accountId, path, res.statusCode);
    });

    const rateLimitKey = `${accountId}:${path}:${req.socket.remoteAddress ?? "unknown"}`;
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter: feishuWebhookRateLimiter,
        rateLimitKey,
        nowMs: Date.now(),
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }

    void (async () => {
      try {
        const bodyResult = await readJsonBodyWithLimit(req, {
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
        });
        if (guard.isTripped() || res.writableEnded) {
          return;
        }
        if (!bodyResult.ok) {
          if (bodyResult.code === "INVALID_JSON") {
            respondText(res, 400, "Invalid JSON");
          }
          return;
        }
        if (!isFeishuWebhookPayload(bodyResult.value)) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        // Lark's default adapter drops invalid signatures as an empty 200. Reject here instead.
        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            payload: bodyResult.value,
            encryptKey: account.encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(bodyResult.value, {
          encryptKey: account.encryptKey ?? "",
        });
        if (isChallenge) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(challenge));
          return;
        }

        const value = await eventDispatcher.invoke(
          buildFeishuWebhookEnvelope(req, bodyResult.value),
          { needCheck: false },
        );
        if (!res.headersSent) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(value));
        }
      } catch (err) {
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
          if (!res.headersSent) {
            respondText(res, 500, "Internal Server Error");
          }
        }
      } finally {
        guard.dispose();
      }
    })();
  });

  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
