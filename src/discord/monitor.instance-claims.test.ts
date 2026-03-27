import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("discord instance claims", () => {
  let tempHome = "";
  let previousHome: string | undefined;
  let previousConfigPath: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    tempHome = await mkdtemp(join(tmpdir(), "openclaw-claims-"));
    previousHome = process.env.HOME;
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it("derives stable instance keys from config paths", async () => {
    const claims = await import("./monitor/instance-claims.js");
    expect(
      claims.resolveDiscordInstanceKey({ configPath: "/Users/test/.openclaw/openclaw.json" }),
    ).toBe("openclaw-main");
    expect(
      claims.resolveDiscordInstanceKey({ configPath: "/Users/test/.openclaw-rescue/openclaw.json" }),
    ).toBe("openclaw-rescue");
  });

  it("returns claimed-by-other when a sibling instance owns the channel", async () => {
    const claims = await import("./monitor/instance-claims.js");
    const botId = "1483062961550393496";

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw/openclaw.json",
      botId,
      guildEntries: {
        guild1: {
          id: "guild1",
          channels: {
            "1483321827781644319": {},
            "1483039228819411069": {},
          },
        },
      },
    });

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw-rescue/openclaw.json",
      botId,
      guildEntries: {
        guild1: {
          id: "guild1",
          channels: {
            "1483059582044606557": {},
          },
        },
      },
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw/openclaw.json",
        botId,
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "owned",
      instanceKey: "openclaw-main",
      matchedChannelId: "1483321827781644319",
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId,
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "claimed-by-other",
      instanceKey: "openclaw-rescue",
      ownerInstanceKey: "openclaw-main",
      matchedChannelId: "1483321827781644319",
    });
  });

  it("keeps empty local claims as no-entry", async () => {
    const claims = await import("./monitor/instance-claims.js");
    const botId = "1483062961550393496";

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw-rescue/openclaw.json",
      botId,
      guildEntries: {},
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId,
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "no-entry",
      instanceKey: "openclaw-rescue",
    });
  });

  it("matches only the requested bot when botId is provided", async () => {
    const claims = await import("./monitor/instance-claims.js");

    await claims.refreshDiscordClaims({
      accountId: "default",
      configPath: "/Users/test/.openclaw/openclaw.json",
      botId: "bot-a",
      guildEntries: {
        guild1: {
          id: "guild1",
          channels: {
            "1483321827781644319": {},
          },
        },
      },
    });

    await expect(
      claims.resolveDiscordClaimOwnership({
        accountId: "default",
        configPath: "/Users/test/.openclaw-rescue/openclaw.json",
        botId: "bot-b",
        channelId: "1483321827781644319",
      }),
    ).resolves.toMatchObject({
      status: "no-entry",
      instanceKey: "openclaw-rescue",
    });
  });
});
