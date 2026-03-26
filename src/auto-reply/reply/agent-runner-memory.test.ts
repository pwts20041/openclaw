import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { resolveMemoryFlushResetAtHour } from "./agent-runner-memory.js";

const DIRECT_SESSION_CONTEXT = {
  Provider: "whatsapp",
  OriginatingChannel: "telegram",
  ChatType: "direct",
} as unknown as TemplateContext;

describe("resolveMemoryFlushResetAtHour", () => {
  it("uses the direct session daily reset boundary", () => {
    const cfg = {
      session: {
        reset: {
          atHour: 4,
        },
      },
    } as OpenClawConfig;

    expect(
      resolveMemoryFlushResetAtHour({
        cfg,
        sessionCtx: DIRECT_SESSION_CONTEXT,
        sessionKey: "main",
      }),
    ).toBe(4);
  });

  it("skips reset-cycle day keys for non-daily reset policies", () => {
    const cfg = {
      session: {
        reset: {
          mode: "idle",
          idleMinutes: 30,
        },
      },
    } as OpenClawConfig;

    expect(
      resolveMemoryFlushResetAtHour({
        cfg,
        sessionCtx: DIRECT_SESSION_CONTEXT,
        sessionKey: "main",
      }),
    ).toBeUndefined();
  });
});
