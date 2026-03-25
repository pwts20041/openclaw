---
summary: "Synology Chat webhook setup and OpenClaw config"
read_when:
  - Setting up Synology Chat with OpenClaw
  - Debugging Synology Chat webhook routing
title: "Synology Chat"
---

# Synology Chat (plugin)

Status: supported via plugin for direct messages and group/channel conversations using
Synology Chat webhooks. The plugin accepts inbound messages from Synology Chat outgoing
webhooks and sends replies through Synology Chat incoming webhooks.

## Plugin required

Synology Chat is plugin-based and not part of the default core channel install.

Install from a local checkout:

```bash
openclaw plugins install ./extensions/synology-chat
```

Details: [Plugins](/tools/plugin)

## Synology Chat integration types

Synology Chat offers two integration types that both work with this plugin:

- **Bot** — appears as a dedicated contact in the user list. Best for direct messages:
  users can message the bot directly without a trigger word. Uses `method=chatbot` incoming
  webhooks (requires `user_ids` for delivery).
- **Outgoing + Incoming webhooks** — attached to a channel. Best for group/channel
  conversations: the outgoing webhook fires on a trigger word, and the incoming webhook
  posts replies back to the channel. Uses `method=incoming` (no `user_ids` needed).

Both types use the same config fields (`token` for the outgoing side, `incomingUrl` for
the incoming side). You can combine a Bot for DMs and channel webhooks for groups in a
single multi-account setup.

## Quick setup

### Direct messages (Bot)

1. Install and enable the Synology Chat plugin.
   - `openclaw onboard` now shows Synology Chat in the same channel setup list as `openclaw channels add`.
   - Non-interactive setup: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. In Synology Chat integrations, create a **Bot**:
   - Copy its outgoing webhook token and incoming webhook URL (`method=chatbot`).
3. Point the bot's outgoing URL to your OpenClaw gateway:
   - `https://gateway-host/webhook/synology` by default.
   - Or your custom `channels.synology-chat.webhookPath`.
4. Finish setup in OpenClaw.
   - Guided: `openclaw onboard`
   - Direct: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. Restart gateway and send a DM to the bot.

### Channels (Outgoing + Incoming webhooks)

See [Group / channel support](#group--channel-support) below for full setup instructions.

Minimal config:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## Environment variables

For the default account, you can use env vars:

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (comma-separated)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

Config values override env vars.

## DM policy and access control

- `dmPolicy: "allowlist"` is the recommended default.
- `allowedUserIds` accepts a list (or comma-separated string) of Synology user IDs.
- In `allowlist` mode, an empty `allowedUserIds` list is treated as misconfiguration and the webhook route will not start (use `dmPolicy: "open"` for allow-all).
- `dmPolicy: "open"` allows any sender.
- `dmPolicy: "disabled"` blocks DMs.
- Reply recipient binding stays on stable numeric `user_id` by default. `channels.synology-chat.dangerouslyAllowNameMatching: true` is break-glass compatibility mode that re-enables mutable username/nickname lookup for reply delivery.
- Pairing approvals work with:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## Outbound delivery

Use numeric Synology Chat user IDs as targets.

Examples:

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

Media sends are supported by URL-based file delivery.

## Group / channel support

Synology Chat channels (group conversations) are supported alongside direct messages.
Each channel requires its own account with a dedicated outgoing webhook token and incoming
webhook URL, plus a distinct `webhookPath`.

### Setting up a channel

1. In Synology Chat, open the target channel's integration settings.
2. Create an **incoming webhook** (for sending replies into the channel) and copy its URL.
3. Create an **outgoing webhook** (for receiving messages from the channel) with a trigger word
   (e.g., the bot name) and point its URL to your gateway with a dedicated path
   (e.g., `http://gateway-host:port/webhook/synology-general`).
4. Add a named account in your OpenClaw config:

```json5
{
  channels: {
    "synology-chat": {
      // Default account handles DMs
      token: "dm-outgoing-token",
      incomingUrl: "https://nas.example.com/...&method=chatbot&token=...",
      accounts: {
        general: {
          token: "channel-outgoing-token",
          incomingUrl: "https://nas.example.com/...&method=incoming&token=...",
          webhookPath: "/webhook/synology-general",
          groupPolicy: "open",
          allowInsecureSsl: false,
        },
      },
    },
  },
}
```

> **Note:** Synology Chat uses `method=chatbot` for DM incoming webhooks (requires `user_ids`)
> and `method=incoming` for channel incoming webhooks (no `user_ids` needed). The plugin
> handles this automatically based on the message context.

### Group policy and access control

- `groupPolicy: "disabled"` (default) — silently ignores messages from channels.
- `groupPolicy: "open"` — accepts messages from any user in the channel.
- `groupPolicy: "allowlist"` — only accepts messages from users listed in `groupAllowFrom`.

```json5
{
  channels: {
    "synology-chat": {
      accounts: {
        general: {
          token: "channel-outgoing-token",
          incomingUrl: "https://nas.example.com/...&method=incoming&token=...",
          webhookPath: "/webhook/synology-general",
          groupPolicy: "allowlist",
          groupAllowFrom: ["123456", "789012"],
          allowInsecureSsl: false,
        },
      },
    },
  },
}
```

### Per-channel overrides

When multiple channels share one account, use the `channels` config to set per-channel
allowlists and mention requirements. Channel keys match by `channel_id` or `channel_name`,
with a `"*"` wildcard as fallback.

```json5
{
  channels: {
    "synology-chat": {
      accounts: {
        general: {
          token: "channel-outgoing-token",
          incomingUrl: "https://nas.example.com/...&method=incoming&token=...",
          webhookPath: "/webhook/synology-general",
          groupPolicy: "allowlist",
          groupAllowFrom: ["123456"],
          channels: {
            "*": { requireMention: true },
            engineering: { requireMention: false, allowFrom: ["123456", "789012"] },
          },
        },
      },
    },
  },
}
```

## Multi-account

Multiple Synology Chat accounts are supported under `channels.synology-chat.accounts`.
Each account can override token, incoming URL, webhook path, DM policy, and limits.
Direct-message sessions are isolated per account and user, so the same numeric `user_id`
on two different Synology accounts does not share transcript state.
Give each enabled account a distinct `webhookPath`. OpenClaw now rejects duplicate exact paths
and refuses to start named accounts that only inherit a shared webhook path in multi-account setups.
If you intentionally need legacy inheritance for a named account, set
`dangerouslyAllowInheritedWebhookPath: true` on that account or at `channels.synology-chat`,
but duplicate exact paths are still rejected fail-closed. Prefer explicit per-account paths.

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## Security notes

- Keep `token` secret and rotate it if leaked.
- Keep `allowInsecureSsl: false` unless you explicitly trust a self-signed local NAS cert.
- Inbound webhook requests are token-verified and rate-limited per sender.
- Prefer `dmPolicy: "allowlist"` for production.
- Keep `dangerouslyAllowNameMatching` off unless you explicitly need legacy username-based reply delivery.
- Keep `dangerouslyAllowInheritedWebhookPath` off unless you explicitly accept shared-path routing risk in a multi-account setup.
- Group channels default to `groupPolicy: "disabled"` — enable explicitly per account.
- Prefer `groupPolicy: "allowlist"` with explicit `groupAllowFrom` user IDs for production channel accounts.
