---
summary: "Health check steps for channel connectivity and HTTP endpoints"
read_when:
  - Diagnosing WhatsApp channel health
  - Setting up uptime monitoring
  - Configuring load balancer health checks
title: "Health Checks"
---

# Health Checks

## HTTP Health Endpoint

### `GET /health`

The gateway exposes a lightweight health check endpoint for uptime monitoring and load balancer probes.

**Request:**
```bash
curl http://localhost:5000/health
```

**Response:**
```json
{
  "ok": true,
  "status": "live"
}
```

**Benefits:**
- **Zero overhead**: No session creation, no LLM calls, instant response
- **Lightweight**: Minimal CPU and memory usage
- **Accurate**: Returns `ok: true` only when the gateway is fully operational
- **No bloat**: Doesn't create agent sessions or accumulate state

### ⚠️ Do NOT Use `/v1/chat/completions` for Health Checks

The `/v1/chat/completions` endpoint creates a **full agent session** for each request, including:
- Session initialization
- Skill snapshot loading
- Context assembly
- LLM API calls

Using this endpoint for monitoring causes:

| Impact | Details |
|--------|---------|
| **Session bloat** | 96 pings/day × ~22KB = 2MB/day of useless sessions |
| **API costs** | Each ping triggers a real LLM call |
| **Context overflow** | Accumulated sessions can cause agent failures |
| **False positives** | May succeed even when core functionality is broken |

### Monitoring Service Configuration

#### BetterStack / UptimeRobot / Pingdom

```
URL: https://your-openclaw-instance.com/health
Method: GET
Expected Status: 200
Expected Response: {"ok":true,"status":"live"}
```

#### Kubernetes Liveness/Readiness Probes

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 5000
  initialDelaySeconds: 10
  periodSeconds: 30
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health
    port: 5000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
```

#### Docker Compose

```yaml
services:
  openclaw:
    image: openclaw/openclaw:latest
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

#### Nginx Load Balancer

```nginx
upstream openclaw {
  server openclaw1:5000;
  server openclaw2:5000;
}

server {
  location /health {
    proxy_pass http://openclaw/health;
    access_log off;  # Don't log health checks
  }
}
```

---

# Health Checks (CLI)

Short guide to verify channel connectivity without guessing.

## Quick checks

- `openclaw status` — local summary: gateway reachability/mode, update hint, linked channel auth age, sessions + recent activity.
- `openclaw status --all` — full local diagnosis (read-only, color, safe to paste for debugging).
- `openclaw status --deep` — also probes the running Gateway (per-channel probes when supported).
- `openclaw health --json` — asks the running Gateway for a full health snapshot (WS-only; no direct Baileys socket).
- Send `/status` as a standalone message in WhatsApp/WebChat to get a status reply without invoking the agent.
- Logs: tail `/tmp/openclaw/openclaw-*.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Deep diagnostics

- Creds on disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` when status codes 409–515 or `loggedOut` appear in logs. (Note: the QR login flow auto-restarts once for status 515 after pairing.)

## Health monitor config

- `gateway.channelHealthCheckMinutes`: how often the gateway checks channel health. Default: `5`. Set `0` to disable health-monitor restarts globally.
- `gateway.channelStaleEventThresholdMinutes`: how long a connected channel can stay idle before the health monitor treats it as stale and restarts it. Default: `30`. Keep this greater than or equal to `gateway.channelHealthCheckMinutes`.
- `gateway.channelMaxRestartsPerHour`: rolling one-hour cap for health-monitor restarts per channel/account. Default: `10`.
- `channels.<provider>.healthMonitor.enabled`: disable health-monitor restarts for a specific channel while leaving global monitoring enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: multi-account override that wins over the channel-level setting.
- These per-channel overrides apply to the built-in channel monitors that expose them today: Discord, Google Chat, iMessage, Microsoft Teams, Signal, Slack, Telegram, and WhatsApp.

## When something fails

- `logged out` or status 409–515 → relink with `openclaw channels logout` then `openclaw channels login`.
- Gateway unreachable → start it: `openclaw gateway --port 18789` (use `--force` if the port is busy).
- No inbound messages → confirm linked phone is online and the sender is allowed (`channels.whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedicated "health" command

`openclaw health --json` asks the running Gateway for its health snapshot (no direct channel sockets from the CLI). It reports linked creds/auth age when available, per-channel probe summaries, session-store summary, and a probe duration. It exits non-zero if the Gateway is unreachable or the probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.

---

## Summary

| Endpoint | Use Case | Overhead |
|----------|----------|----------|
| `GET /health` | Uptime monitoring, load balancer probes | Zero |
| `openclaw health --json` | Detailed gateway status | Minimal |
| `POST /v1/chat/completions` | Actual chat requests | Full session |

**Best Practice:** Always use `GET /health` for monitoring. Never use `/v1/chat/completions` for health checks.
