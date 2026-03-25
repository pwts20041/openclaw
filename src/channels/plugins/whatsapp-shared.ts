import type { OpenClawConfig } from "../../config/config.js";
import { resolveOutboundSendDep } from "../../infra/outbound/send-deps.js";
import { createAttachedChannelResultAdapter } from "../../plugin-sdk/channel-send-result.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { escapeRegExp } from "../../utils.js";
import type { ChannelOutboundAdapter } from "./types.js";

export const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

export function resolveWhatsAppGroupIntroHint(): string {
  return WHATSAPP_GROUP_INTRO_HINT;
}

export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (!selfE164) {
    return [];
  }
  const escaped = escapeRegExp(selfE164);
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendMessage = PluginRuntimeChannel["whatsapp"]["sendMessageWhatsApp"];
type WhatsAppSendPoll = PluginRuntimeChannel["whatsapp"]["sendPollWhatsApp"];

type CreateWhatsAppOutboundBaseParams = {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
  /** Optional wrapper applied to every send call after deps resolution (e.g. for retry). */
  wrapSend?: <T>(
    fn: () => Promise<T>,
    label: string,
    cfg: OpenClawConfig | undefined,
    accountId: string | null | undefined,
  ) => Promise<T>;
};

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = (text) => text ?? "",
  skipEmptyText = false,
  wrapSend,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  return {
    deliveryMode: "gateway",
    chunker,
    chunkerMode: "text",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget,
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
      sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
        const doSend = () =>
          send(to, normalizedText, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
            gifPlayback,
          });
        return wrapSend ? await wrapSend(doSend, "sendText", cfg, accountId) : await doSend();
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        gifPlayback,
      }) => {
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
        const doSend = () =>
          send(to, normalizeText(text), {
            verbose: false,
            cfg,
            mediaUrl,
            mediaLocalRoots,
            accountId: accountId ?? undefined,
            gifPlayback,
          });
        return wrapSend ? await wrapSend(doSend, "sendMedia", cfg, accountId) : await doSend();
      },
      sendPoll: async ({ cfg, to, poll, accountId }) => {
        const doSend = () =>
          sendPollWhatsApp(to, poll, {
            verbose: shouldLogVerbose(),
            accountId: accountId ?? undefined,
            cfg,
          });
        return wrapSend ? await wrapSend(doSend, "sendPoll", cfg, accountId) : await doSend();
      },
    }),
  };
}
