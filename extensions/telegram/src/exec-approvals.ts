import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramExecApprovalConfig } from "openclaw/plugin-sdk/config-runtime";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/infra-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { isNumericTelegramChatId, resolveTelegramTargetChatType } from "./targets.js";

function normalizeApproverId(value: string | number): string {
  return String(value).trim();
}

export function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined {
  return resolveTelegramAccount(params).config.execApprovals;
}

export function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return (resolveTelegramExecApprovalConfig(params)?.approvers ?? [])
    .map(normalizeApproverId)
    .filter(Boolean);
}

export function isTelegramExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveTelegramExecApprovalConfig(params);
  return Boolean(config?.enabled && getTelegramExecApprovalApprovers(params).length > 0);
}

export function isTelegramExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const approvers = getTelegramExecApprovalApprovers(params);
  return approvers.includes(senderId);
}

/**
 * Check if a sender is an implicit approver by being the DM recipient
 * of an exec approval forwarding target (approvals.exec.targets).
 *
 * When approvals.exec.targets routes to a Telegram DM, the recipient
 * receives inline approval buttons but may not have explicit
 * channels.telegram.execApprovals configured. This function allows
 * those recipients to act on the buttons they were sent.
 */
export function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  const targets = params.cfg.approvals?.exec?.targets;
  if (!targets || !Array.isArray(targets)) {
    return false;
  }
  const accountId = params.accountId?.trim() || undefined;
  return targets.some((target) => {
    const channel = target.channel?.trim().toLowerCase();
    if (channel !== "telegram") {
      return false;
    }
    // Skip targets scoped to a different account
    if (accountId && target.accountId && target.accountId !== accountId) {
      return false;
    }
    const to = target.to?.trim();
    // Only accept positive (DM) chat IDs; negative IDs are group targets
    if (!to || !isNumericTelegramChatId(to) || to.startsWith("-")) {
      return false;
    }
    return to === senderId;
  });
}

export function resolveTelegramExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveTelegramExecApprovalConfig(params)?.target ?? "dm";
}

export function shouldInjectTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean {
  if (!isTelegramExecApprovalClientEnabled(params)) {
    return false;
  }
  const target = resolveTelegramExecApprovalTarget(params);
  const chatType = resolveTelegramTargetChatType(params.to);
  if (chatType === "direct") {
    return target === "dm" || target === "both";
  }
  if (chatType === "group") {
    return target === "channel" || target === "both";
  }
  return target === "both";
}

function resolveExecApprovalButtonsExplicitlyDisabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const capabilities = resolveTelegramAccount(params).config.capabilities;
  if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== "object") {
    return false;
  }
  const inlineButtons = (capabilities as { inlineButtons?: unknown }).inlineButtons;
  return typeof inlineButtons === "string" && inlineButtons.trim().toLowerCase() === "off";
}

export function shouldEnableTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean {
  if (!shouldInjectTelegramExecApprovalButtons(params)) {
    return false;
  }
  return !resolveExecApprovalButtonsExplicitlyDisabled(params);
}

export function shouldSuppressLocalTelegramExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  void params.cfg;
  void params.accountId;
  return getExecApprovalReplyMetadata(params.payload) !== null;
}
