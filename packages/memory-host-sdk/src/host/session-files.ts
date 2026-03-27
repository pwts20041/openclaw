import fs from "node:fs/promises";
import path from "node:path";
import { stripLeadingInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../../src/config/sessions/paths.js";
import { redactSensitiveText } from "../../../../src/logging/redact.js";
import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
import { hashText } from "./internal.js";

/**
 * Matches one or more leading directive tags (audio/reply) at the very start of text,
 * optionally preceded by whitespace.  Inline mentions pass through unchanged so they
 * remain searchable in the memory index.
 */
const LEADING_DIRECTIVE_TAGS_RE =
  /^(\s*\[\[\s*(?:audio_as_voice|reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*)+/i;

/**
 * Matches the leading timestamp envelope injected by `injectTimestamp`.
 * Format: `[DOW YYYY-MM-DD HH:MM TZ] ` — e.g. `[Wed 2026-03-27 14:47 EDT] `.
 *
 * The DOW prefix means the year does NOT appear immediately after `[`, so a
 * simple `includes("[20")` check misses this format entirely.  We anchor on
 * the date component `\d{4}-\d{2}-\d{2}` to avoid matching arbitrary
 * square-bracket constructs.
 *
 * Must stay in sync with `LEADING_TIMESTAMP_PREFIX_RE` in
 * `src/auto-reply/reply/strip-inbound-meta.ts`.
 */
const LEADING_TIMESTAMP_ENVELOPE_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips OpenClaw-injected metadata from a raw content string before
 * normalization. Must be called on the original multi-line text so that
 * the line-based sentinel detection in `stripLeadingInboundMetadata` works correctly.
 */
function stripRawContentMeta(raw: string, role: "user" | "assistant"): string {
  // Only strip inbound metadata for user messages — assistant responses may
  // legitimately quote or discuss metadata headers (e.g. troubleshooting output).
  // Fast-path: skip stripping entirely when the text clearly contains no injected
  // metadata. We check several sentinel patterns to cover all formats:
  //   '<'                        — XML-style fenced blocks
  //   "untrusted metadata"       — "Conversation info (untrusted metadata):" etc.
  //   "untrusted, for context"   — "Thread starter (untrusted, for context):" etc.
  //   "Untrusted context"        — standalone UNTRUSTED_CONTEXT_HEADER prefix
  //   LEADING_TIMESTAMP_ENVELOPE_RE — injected timestamp e.g. "[Wed 2026-03-27 …]"
  //     NOTE: `includes("[20")` does NOT match "[Wed 2026-…]" because the DOW
  //     abbreviation precedes the year, so we use the regex instead.
  const mightHaveMeta =
    role === "user" &&
    (raw.includes("<") ||
      raw.includes("untrusted metadata") ||
      raw.includes("untrusted, for context") ||
      raw.includes("Untrusted context") ||
      LEADING_TIMESTAMP_ENVELOPE_RE.test(raw));
  const afterMeta = mightHaveMeta ? stripLeadingInboundMetadata(raw) : raw;
  // `stripLeadingInboundMetadata` strips inbound metadata sentinel blocks but does
  // NOT remove the timestamp envelope — that is handled by `stripInboundMetadata`
  // (the full-strip path used by UI surfaces).  Strip it here so that any
  // directive tags that follow the timestamp are correctly detected as leading
  // tags by `LEADING_DIRECTIVE_TAGS_RE`.
  // Gate timestamp stripping to user messages only — assistant content may
  // legitimately begin with timestamp-like text (e.g. quoting logs or schedules)
  // and silently truncating it would be a regression.
  const afterTs =
    role === "user" ? afterMeta.replace(LEADING_TIMESTAMP_ENVELOPE_RE, "") : afterMeta;
  if (!afterTs.includes("[[")) {
    return afterTs;
  }
  // Only strip directive tags at leading control-tag positions (start of text).
  // Inline mid-text mentions (e.g. discussing [[reply_to_current]] in docs)
  // are left intact so they remain searchable in the memory index.
  return afterTs.replace(LEADING_DIRECTIVE_TAGS_RE, "");
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

/**
 * Like `extractSessionText` but strips OpenClaw-injected inbound metadata
 * blocks and inline directive tags from raw content *before* normalization.
 * Stripping must happen pre-normalization so that line-based sentinel
 * detection in `stripLeadingInboundMetadata` can identify the fenced JSON blocks.
 *
 * The `role` parameter controls whether `stripLeadingInboundMetadata` is applied:
 * only `user` messages have their metadata blocks removed. Assistant messages
 * may legitimately reference metadata headers, so they are kept intact.
 *
 * For multipart (array) content: raw parts are joined *before* stripping so
 * that leading-tag detection sees the whole message rather than each fragment
 * in isolation (a later fragment starting with `[[reply_to_*]]` is not a
 * leading directive tag of the overall message).
 */
function extractAndStripSessionText(content: unknown, role: "user" | "assistant"): string | null {
  if (typeof content === "string") {
    const clean = stripRawContentMeta(content, role);
    const normalized = normalizeSessionText(clean);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const rawParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    if (record.text) {
      rawParts.push(record.text);
    }
  }
  if (rawParts.length === 0) {
    return null;
  }
  // Join first so that leading-directive-tag detection operates on the
  // full message rather than each fragment in isolation.
  const joined = rawParts.join("\n");
  const clean = stripRawContentMeta(joined, role);
  const normalized = normalizeSessionText(clean);
  return normalized ? normalized : null;
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractAndStripSessionText(message.content, message.role);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${safe}`);
      lineMap.push(jsonlIdx + 1);
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",")),
      content,
      lineMap,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
