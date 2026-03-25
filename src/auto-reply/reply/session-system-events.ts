import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { drainSystemEventEntries } from "../../infra/system-events.js";

/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
export async function drainFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  isHeartbeat?: boolean;
  isEventDrivenHeartbeat?: boolean;
}): Promise<string | undefined> {
  const compactSystemEvent = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    const lower = trimmed.toLowerCase();
    if (lower.includes("reason periodic")) {
      return null;
    }
    // Filter out the actual heartbeat prompt, but not cron jobs that mention "heartbeat".
    // The heartbeat prompt starts with "Read HEARTBEAT.md" - cron payloads won't match this.
    if (lower.startsWith("read heartbeat.md")) {
      return null;
    }
    if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) {
      return null;
    }
    if (trimmed.startsWith("Node:")) {
      return trimmed.replace(/ · last input [^·]+/i, "").trim();
    }
    return trimmed;
  };

  const resolveSystemEventTimezone = (cfg: OpenClawConfig) => {
    const raw = cfg.agents?.defaults?.envelopeTimezone?.trim();
    if (!raw) {
      return { mode: "local" as const };
    }
    const lowered = raw.toLowerCase();
    if (lowered === "utc" || lowered === "gmt") {
      return { mode: "utc" as const };
    }
    if (lowered === "local" || lowered === "host") {
      return { mode: "local" as const };
    }
    if (lowered === "user") {
      return {
        mode: "iana" as const,
        timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
      };
    }
    const explicit = resolveTimezone(raw);
    return explicit ? { mode: "iana" as const, timeZone: explicit } : { mode: "local" as const };
  };

  const formatSystemEventTimestamp = (ts: number, cfg: OpenClawConfig) => {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return "unknown-time";
    }
    const zone = resolveSystemEventTimezone(cfg);
    if (zone.mode === "utc") {
      return formatUtcTimestamp(date, { displaySeconds: true });
    }
    if (zone.mode === "local") {
      return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
    }
    return (
      formatZonedTimestamp(date, { timeZone: zone.timeZone, displaySeconds: true }) ??
      "unknown-time"
    );
  };

  const systemLines: string[] = [];
  // Periodic heartbeat runs skip system events entirely.  They don't persist
  // to the session transcript (JSONL), so processing events here would
  // silently discard them — and repeated peeks would re-trigger the same
  // events on every heartbeat cycle, wasting tokens and risking duplicate
  // side-effects.  Events stay queued untouched for the next run to drain.
  //
  // Event-driven heartbeats (exec completion, cron) are the designated
  // consumer of those events — they MUST drain so the agent can act on the
  // results referenced by their prompt (e.g. "The result is shown in the
  // system messages above").
  const skipDrain = params.isHeartbeat && !params.isEventDrivenHeartbeat;
  const queued = skipDrain ? [] : drainSystemEventEntries(params.sessionKey);
  systemLines.push(
    ...queued
      .map((event) => {
        const compacted = compactSystemEvent(event.text);
        if (!compacted) {
          return null;
        }
        return `[${formatSystemEventTimestamp(event.ts, params.cfg)}] ${compacted}`;
      })
      .filter((v): v is string => Boolean(v)),
  );
  if (params.isMainSession && params.isNewSession) {
    const summary = await buildChannelSummary(params.cfg);
    if (summary.length > 0) {
      systemLines.unshift(...summary);
    }
  }
  if (systemLines.length === 0) {
    return undefined;
  }

  // Format events as trusted System: lines for the message timeline.
  // Inbound sanitization rewrites any user-supplied "System:" to "System (untrusted):",
  // so these gateway-originated lines are distinguishable by the model.
  // Each sub-line of a multi-line event gets its own System: prefix so continuation
  // lines can't be mistaken for user content.
  return systemLines
    .flatMap((line) => line.split("\n").map((subline) => `System: ${subline}`))
    .join("\n");
}
