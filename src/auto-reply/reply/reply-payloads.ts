import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../types.js";

export {
  applyReplyTagsToPayload,
  applyReplyThreading,
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "./reply-payloads-base.js";
export {
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads-dedupe.js";

export function resolveToolDeliveryPayload(
  payload: ReplyPayload,
  options?: { allowText?: boolean; allowExecApproval?: boolean },
): ReplyPayload | null {
  const allowText = options?.allowText === true;
  const allowExecApproval = options?.allowExecApproval !== false;
  if (allowText && payload.text?.trim()) {
    return payload;
  }
  const execApproval =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.execApproval
      : undefined;
  if (
    allowExecApproval &&
    execApproval &&
    typeof execApproval === "object" &&
    !Array.isArray(execApproval)
  ) {
    return payload;
  }
  const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
  if (!hasMedia) {
    return null;
  }
  return { ...payload, text: undefined };
}
