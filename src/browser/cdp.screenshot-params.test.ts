import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserProfile } from "./config.js";
import { shouldUsePlaywrightForScreenshot } from "./profile-capabilities.js";

const sentMessages = vi.hoisted(() => {
  const msgs: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return msgs;
});

vi.mock("./cdp.helpers.js", () => ({
  withCdpSocket: vi.fn(async (_wsUrl: string, fn: (send: unknown) => Promise<unknown>) => {
    const send = (method: string, params?: Record<string, unknown>) => {
      sentMessages.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: "AAAA" });
      }
      return Promise.resolve({});
    };
    return fn(send);
  }),
  appendCdpPath: vi.fn(),
  fetchJson: vi.fn(),
  isLoopbackHost: vi.fn(),
  isWebSocketUrl: vi.fn(),
}));

vi.mock("./navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

const localProfile: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpUrl: "http://127.0.0.1:18800",
  cdpPort: 18800,
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  attachOnly: false,
};

let captureScreenshot: typeof import("./cdp.js").captureScreenshot;

beforeEach(async () => {
  sentMessages.length = 0;
  vi.resetModules();
  ({ captureScreenshot } = await import("./cdp.js"));
});

describe("CDP screenshot params", () => {
  it("viewport screenshot sends fromSurface: true and captureBeyondViewport: false without clip", async () => {
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", format: "png" });

    const call = sentMessages.find((m) => m.method === "Page.captureScreenshot");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    expect(call!.params).not.toHaveProperty("clip");
  });
});

describe("shouldUsePlaywrightForScreenshot routing", () => {
  it("returns false for a normal viewport screenshot with wsUrl", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x" })).toBe(
      false,
    );
  });

  it("returns true when wsUrl is missing", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile })).toBe(true);
  });

  it("returns true when ref is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x", ref: "btn-1" }),
    ).toBe(true);
  });

  it("returns true when element is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({
        profile: localProfile,
        wsUrl: "ws://x",
        element: "#submit",
      }),
    ).toBe(true);
  });

  it("returns true when fullPage is true, routing full-page captures to Playwright", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x", fullPage: true }),
    ).toBe(true);
  });

  it("returns false when fullPage is false or undefined", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x", fullPage: false }),
    ).toBe(false);
    expect(
      shouldUsePlaywrightForScreenshot({
        profile: localProfile,
        wsUrl: "ws://x",
        fullPage: undefined,
      }),
    ).toBe(false);
  });
});
