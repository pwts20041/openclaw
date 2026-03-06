import type { ReplyToMode } from "../../config/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { extractReplyToTag } from "./reply-tags.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

export function formatBtwTextForExternalDelivery(payload: ReplyPayload): string | undefined {
  const text = payload.text?.trim();
  if (!text) {
    return payload.text;
  }
  const question = payload.btw?.question?.trim();
  if (!question) {
    return payload.text;
  }
  const formatted = `BTW\nQuestion: ${question}\n\n${text}`;
  return text === formatted || text.startsWith("BTW\nQuestion:") ? text : formatted;
}

function resolveReplyThreadingForPayload(params: {
  payload: ReplyPayload;
  implicitReplyToId?: string;
  currentMessageId?: string;
}): ReplyPayload {
  const implicitReplyToId = params.implicitReplyToId?.trim() || undefined;
  const currentMessageId = params.currentMessageId?.trim() || undefined;
  const normalizedReplyToId =
    typeof params.payload.replyToId === "string"
      ? params.payload.replyToId.trim() || undefined
      : params.payload.replyToId;
  const normalizedPayload =
    normalizedReplyToId === params.payload.replyToId
      ? params.payload
      : { ...params.payload, replyToId: normalizedReplyToId };

  const hasExplicitReplyToId = normalizedReplyToId !== undefined;

  // 1) Apply implicit reply threading first (replyToMode will strip later if needed).
  // Treat replyToId=null as an explicit "do not reply" signal (do not override).
  let resolved: ReplyPayload =
    hasExplicitReplyToId || normalizedPayload.replyToCurrent === false || !implicitReplyToId
      ? normalizedPayload
      : { ...normalizedPayload, replyToId: implicitReplyToId };

  // 2) Parse explicit reply tags from text (if present) and clean them.
  if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
    const { cleaned, replyToId, replyToCurrent, hasTag } = extractReplyToTag(
      resolved.text,
      currentMessageId,
    );
    resolved = {
      ...resolved,
      text: cleaned ? cleaned : undefined,
      replyToId: replyToId ?? resolved.replyToId,
      replyToTag: hasTag || resolved.replyToTag,
      replyToCurrent: replyToCurrent || resolved.replyToCurrent,
    };
  }

  // 3) If replyToCurrent was set out-of-band (e.g. tags already stripped upstream),
  // ensure replyToId is set to the current message id when available.
  if (resolved.replyToCurrent && resolved.replyToId === undefined && currentMessageId) {
    resolved = {
      ...resolved,
      replyToId: currentMessageId,
    };
  }

  return resolved;
}

export function applyReplyTagsToPayload(
  payload: ReplyPayload,
  currentMessageId?: string,
): ReplyPayload {
  return resolveReplyThreadingForPayload({ payload, currentMessageId });
}

export function isRenderablePayload(payload: ReplyPayload): boolean {
  return hasReplyPayloadContent(payload, { extraContent: payload.audioAsVoice });
}

export function shouldSuppressReasoningPayload(payload: ReplyPayload): boolean {
  return payload.isReasoning === true;
}

export function applyReplyThreading(params: {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
}): ReplyPayload[] {
  const { payloads, replyToMode, replyToChannel, currentMessageId } = params;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const implicitReplyToId = currentMessageId?.trim() || undefined;
  return payloads
    .map((payload) =>
      resolveReplyThreadingForPayload({ payload, implicitReplyToId, currentMessageId }),
    )
    .filter(isRenderablePayload)
    .map(applyReplyToMode);
}
