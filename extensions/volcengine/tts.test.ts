import { describe, it, expect } from "vitest";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";

function makeProviderConfig(overrides?: Record<string, unknown>) {
  return {
    appId: "test-app-id",
    token: "test-token",
    voice: "zh_female_xiaohe_uranus_bigtts",
    cluster: "volcano_tts",
    ...overrides,
  };
}

describe("Volcengine speech provider", () => {
  const provider = buildVolcengineSpeechProvider();

  it("has correct id, label, and aliases", () => {
    expect(provider.id).toBe("volcengine");
    expect(provider.label).toBe("Volcengine");
    expect(provider.aliases).toContain("bytedance");
    expect(provider.aliases).toContain("doubao");
  });

  it("reports configured when appId and token are present in providerConfig", () => {
    expect(provider.isConfigured({ providerConfig: makeProviderConfig(), timeoutMs: 30000 })).toBe(
      true,
    );
  });

  it("reports not configured when credentials are missing", () => {
    const oldAppId = process.env.VOLCENGINE_TTS_APPID;
    const oldToken = process.env.VOLCENGINE_TTS_TOKEN;
    delete process.env.VOLCENGINE_TTS_APPID;
    delete process.env.VOLCENGINE_TTS_TOKEN;
    try {
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(false);
    } finally {
      if (oldAppId) process.env.VOLCENGINE_TTS_APPID = oldAppId;
      if (oldToken) process.env.VOLCENGINE_TTS_TOKEN = oldToken;
    }
  });

  it("falls back to env vars for credentials", () => {
    const oldAppId = process.env.VOLCENGINE_TTS_APPID;
    const oldToken = process.env.VOLCENGINE_TTS_TOKEN;
    process.env.VOLCENGINE_TTS_APPID = "env-app-id";
    process.env.VOLCENGINE_TTS_TOKEN = "env-token";
    try {
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30000 })).toBe(true);
    } finally {
      if (oldAppId) process.env.VOLCENGINE_TTS_APPID = oldAppId;
      else delete process.env.VOLCENGINE_TTS_APPID;
      if (oldToken) process.env.VOLCENGINE_TTS_TOKEN = oldToken;
      else delete process.env.VOLCENGINE_TTS_TOKEN;
    }
  });

  it("lists voices with locale and gender", async () => {
    const voices = await provider.listVoices!({});
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toMatchObject({ locale: "zh-CN" });
    expect(voices[0].gender).toBeDefined();
  });
});
