import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import {
  evaluateSessionFreshness,
  resolveDailyResetAtMs,
  type SessionResetPolicy,
} from "./reset.js";

describe("session reset timezone semantics", () => {
  const shanghaiCfg: OpenClawConfig = {
    agents: {
      defaults: {
        userTimezone: "Asia/Shanghai",
      },
    },
  };

  const dailyPolicy: SessionResetPolicy = {
    mode: "daily",
    atHour: 4,
  };

  it("treats sessions before the local reset hour as part of the previous human day", () => {
    const updatedAt = Date.UTC(2026, 2, 18, 19, 30, 0); // 2026-03-19 03:30 +08:00
    const now = Date.UTC(2026, 2, 18, 21, 0, 0); // 2026-03-19 05:00 +08:00

    const freshness = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: dailyPolicy,
      cfg: shanghaiCfg,
    });

    expect(freshness.fresh).toBe(false);
  });

  it("returns a daily reset boundary anchored to the configured human timezone", () => {
    const now = Date.UTC(2026, 2, 18, 21, 0, 0); // 2026-03-19 05:00 +08:00
    const boundaryMs = resolveDailyResetAtMs(now, 4, shanghaiCfg);
    expect(boundaryMs).toBe(Date.UTC(2026, 2, 18, 20, 0, 0));
  });

  it("treats invalid activity timestamps as stale instead of throwing", () => {
    const now = Date.UTC(2026, 2, 18, 21, 0, 0); // 2026-03-19 05:00 +08:00

    const freshness = evaluateSessionFreshness({
      updatedAt: Number.NaN,
      now,
      policy: dailyPolicy,
      cfg: shanghaiCfg,
    });

    expect(freshness).toEqual({
      fresh: false,
      dailyResetAt: Date.UTC(2026, 2, 18, 20, 0, 0),
    });
  });
});
