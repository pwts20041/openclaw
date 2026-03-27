import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  attachChannelToResult,
  attachChannelToResults,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { resolveSignalAccount, type ResolvedSignalAccount } from "./accounts.js";
import { markdownToSignalTextChunks } from "./format.js";
import { signalMessageActions } from "./message-actions.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalOutboundTarget } from "./outbound-session.js";
import type { SignalProbe } from "./probe.js";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  normalizeE164,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  type ChannelPlugin,
} from "./runtime-api.js";
import { getSignalRuntime } from "./runtime.js";
import { resolveSignalQuoteParams } from "./send.js";
import { signalSetupAdapter } from "./setup-core.js";
import {
  signalConfigAdapter,
  createSignalPluginBase,
  signalSecurityAdapter,
  signalSetupWizard,
} from "./shared.js";

/** Default text chunk size for Signal outbound messages (chars). */
const SIGNAL_TEXT_CHUNK_LIMIT = 4000;

type SignalSendFn = ReturnType<typeof getSignalRuntime>["channel"]["signal"]["sendMessageSignal"];

function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ??
    getSignalRuntime().channel.signal.sendMessageSignal;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
    accountId: params.accountId,
  });
  return { send, maxBytes };
}

async function sendSignalOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  replyToId?: string | null;
  deps?: { [channelId: string]: unknown };
}) {
  const { send, maxBytes } = resolveSignalSendContext(params);
  const quoteParams = resolveSignalQuoteParams({
    to: params.to,
    replyToId: params.replyToId ?? undefined,
  });
  return await send(params.to, params.text, {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    ...quoteParams,
  });
}

function inferSignalTargetChatType(rawTo: string) {
  let to = rawTo.trim();
  if (!to) {
    return undefined;
  }
  if (/^signal:/i.test(to)) {
    to = to.replace(/^signal:/i, "").trim();
  }
  if (!to) {
    return undefined;
  }
  const lower = to.toLowerCase();
  if (lower.startsWith("group:")) {
    return "group" as const;
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct" as const;
  }
  return "direct" as const;
}

function parseSignalExplicitTarget(raw: string) {
  const normalized = normalizeSignalMessagingTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: inferSignalTargetChatType(normalized),
  };
}

function buildSignalBaseSessionKey(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "signal" });
}

function resolveSignalOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const resolved = resolveSignalOutboundTarget(params.target);
  if (!resolved) {
    return null;
  }
  const baseSessionKey = buildSignalBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer: resolved.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    ...resolved,
  };
}

async function sendFormattedSignalText(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  replyToId?: string | null;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  const { send, maxBytes } = resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const limit = resolveTextChunkLimit(ctx.cfg, "signal", ctx.accountId ?? undefined, {
    fallbackLimit: 4000,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  let chunks =
    limit === undefined
      ? markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(ctx.text, limit, { tableMode });
  if (chunks.length === 0 && ctx.text) {
    chunks = [{ text: ctx.text, styles: [] }];
  }
  const results = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk) continue;
    ctx.abortSignal?.throwIfAborted();
    const result = await send(ctx.to, chunk.text, {
      cfg: ctx.cfg,
      maxBytes,
      accountId: ctx.accountId ?? undefined,
      textMode: "plain",
      textStyles: chunk.styles,
      replyToId: i === 0 ? (ctx.replyToId ?? undefined) : undefined,
    });
    results.push(result);
  }
  return attachChannelToResults("signal", results);
}

async function sendFormattedSignalMedia(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  replyToId?: string | null;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const { send, maxBytes } = resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  const formatted = markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, {
    tableMode,
  })[0] ?? {
    text: ctx.text,
    styles: [],
  };
  const result = await send(ctx.to, formatted.text, {
    cfg: ctx.cfg,
    mediaUrl: ctx.mediaUrl,
    mediaLocalRoots: ctx.mediaLocalRoots,
    maxBytes,
    accountId: ctx.accountId ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
    replyToId: ctx.replyToId ?? undefined,
  });
  return attachChannelToResult("signal", result);
}

async function sendSignalOutboundChunked(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  deps?: { [channelId: string]: unknown };
}): Promise<{ channel: string; messageId: string }> {
  const limit = resolveTextChunkLimit(params.cfg, "signal", params.accountId ?? undefined);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId ?? undefined,
  });
  let chunks =
    limit === undefined
      ? markdownToSignalTextChunks(params.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(params.text, limit, { tableMode });
  if (chunks.length === 0 && params.text) {
    chunks = [{ text: params.text, styles: [] }];
  }
  const { send, maxBytes } = resolveSignalSendContext({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    deps: params.deps,
  });
  let lastResult: { channel: string; messageId: string } | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const result = await send(params.to, chunk.text, {
      cfg: params.cfg,
      maxBytes,
      accountId: params.accountId ?? undefined,
      textMode: "plain",
      textStyles: chunk.styles,
      replyToId: i === 0 ? (params.replyToId ?? undefined) : undefined,
    });
    lastResult = { channel: "signal", ...result };
  }
  return lastResult ?? { channel: "signal", messageId: "" };
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount, SignalProbe> =
  createChatChannelPlugin({
    base: {
      ...createSignalPluginBase({
        setupWizard: signalSetupWizard,
        setup: signalSetupAdapter,
      }),
      actions: signalMessageActions,
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "signal",
        resolveAccount: resolveSignalAccount,
        normalize: ({ cfg, accountId, values }) =>
          signalConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      messaging: {
        normalizeTarget: normalizeSignalMessagingTarget,
        parseExplicitTarget: ({ raw }) => parseSignalExplicitTarget(raw),
        inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeSignalTargetId,
          hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedSignalAccount, SignalProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            baseUrl: snapshot.baseUrl ?? null,
            probe: snapshot.probe,
            lastProbeAt: snapshot.lastProbeAt ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) => {
          const baseUrl = account.baseUrl;
          return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
        },
        formatCapabilitiesProbe: ({ probe }) =>
          (probe as SignalProbe | undefined)?.version
            ? [{ text: `Signal daemon: ${(probe as SignalProbe).version}` }]
            : [],
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.baseUrl,
          });
          ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
          // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
          return getSignalRuntime().channel.signal.monitorSignalProvider({
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
          });
        },
      },
    },
    pairing: {
      text: {
        idLabel: "signalNumber",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^signal:/i),
        notify: async ({ id, message }) => {
          await getSignalRuntime().channel.signal.sendMessageSignal(id, message);
        },
      },
    },
    security: signalSecurityAdapter,
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) => getSignalRuntime().channel.text.chunkText(text, limit),
        chunkerMode: "text",
        textChunkLimit: SIGNAL_TEXT_CHUNK_LIMIT,
        sendFormattedText: async ({ cfg, to, text, replyToId, accountId, deps, abortSignal }) =>
          await sendFormattedSignalText({
            cfg,
            to,
            text,
            replyToId,
            accountId,
            deps,
            abortSignal,
          }),
        sendFormattedMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          replyToId,
          accountId,
          deps,
          abortSignal,
        }) =>
          await sendFormattedSignalMedia({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            replyToId,
            accountId,
            deps,
            abortSignal,
          }),
      },
      sendPayload: async (ctx) => {
        const text = ctx.payload.text ?? "";
        const urls: string[] = ctx.payload.mediaUrls?.length
          ? ctx.payload.mediaUrls
          : ctx.payload.mediaUrl
            ? [ctx.payload.mediaUrl]
            : [];
        if (!text && urls.length === 0) {
          // Interactive-only payload (e.g. buttons, channelData) has no text or
          // media that Signal can send. Return a no-op result so the caller knows
          // the payload was intentionally skipped rather than silently lost.
          return { channel: "signal" as const, messageId: "", meta: { skipped: true } };
        }
        if (urls.length > 0) {
          let lastResult: { channel: string; messageId: string } | undefined;
          for (let i = 0; i < urls.length; i++) {
            const mediaUrl = urls[i];
            if (!mediaUrl) continue;
            const result = await sendSignalOutbound({
              cfg: ctx.cfg,
              to: ctx.to,
              text: i === 0 ? text : "",
              mediaUrl,
              mediaLocalRoots: ctx.mediaLocalRoots,
              accountId: ctx.accountId ?? undefined,
              replyToId: i === 0 ? (ctx.replyToId ?? undefined) : undefined,
              deps: ctx.deps,
            });
            lastResult = { channel: "signal", ...result };
          }
          return lastResult ?? { channel: "signal", messageId: "" };
        }
        // Text-only: chunk and send; only first chunk carries the quote.
        return await sendSignalOutboundChunked({
          cfg: ctx.cfg,
          to: ctx.to,
          text,
          accountId: ctx.accountId,
          replyToId: ctx.replyToId,
          deps: ctx.deps,
        });
      },
      attachedResults: {
        channel: "signal",
        sendText: async ({ cfg, to, text, accountId, deps, replyToId }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            replyToId: replyToId ?? undefined,
            deps,
          }),
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          accountId,
          deps,
          replyToId,
        }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            accountId: accountId ?? undefined,
            replyToId: replyToId ?? undefined,
            deps,
          }),
      },
    },
  });

