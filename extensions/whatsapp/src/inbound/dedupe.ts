import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";

const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;

// Fast synchronous Set for immediate duplicate detection within the same event loop tick.
// This prevents race conditions when baileys fires multiple messages.upsert events
// for the same message in rapid succession (common with media messages).
const processingMessages = new Set<string>();

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
  maxSize: RECENT_WEB_MESSAGE_MAX,
});
const recentOutboundMessages = createDedupeCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

export function resetWebInboundDedupe(): void {
  recentInboundMessages.clear();
  recentOutboundMessages.clear();
  processingMessages.clear();
}

/**
 * Checks if a message is currently being processed or was recently processed.
 * This function is synchronous and must be called before any async work starts
 * to prevent duplicate message processing when baileys fires rapid duplicate events.
 * 
 * @param key - Dedupe key (accountId:remoteJid:messageId)
 * @returns true if message is duplicate (should skip), false if new (should process)
 */
export function isRecentInboundMessage(key: string): boolean {
  // Fast path: check if we're currently processing this exact message
  if (processingMessages.has(key)) {
    return true;  // Duplicate detected
  }
  
  // Check long-term cache
  const isDuplicate = recentInboundMessages.check(key);
  
  // If this is a new message, mark it as currently processing
  if (!isDuplicate) {
    processingMessages.add(key);
    // Clear from processing set after a short delay (5 seconds)
    // This handles the case where message processing fails/throws
    setTimeout(() => processingMessages.delete(key), 5000);
  }
  
  return isDuplicate;
}

export function rememberRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildMessageKey(params);
  if (!key) {
    return;
  }
  recentOutboundMessages.check(key);
}

export function isRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): boolean {
  const key = buildMessageKey(params);
  if (!key) {
    return false;
  }
  return recentOutboundMessages.peek(key);
}
