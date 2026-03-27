import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { volcengineTTS } from "./tts.js";

const DEFAULT_VOICE = "zh_female_xiaohe_uranus_bigtts";
const DEFAULT_CLUSTER = "volcano_tts";

export const VOLCENGINE_VOICES: readonly string[] = [
  "zh_female_xiaohe_uranus_bigtts",
  "zh_male_aojiao_mars_bigtts",
  "zh_female_shuangkuai_moon_bigtts",
  "zh_male_wennuanahu_moon_bigtts",
  "zh_female_tianmei_mars_bigtts",
  "zh_male_chunhou_mars_bigtts",
];

type VolcengineTtsProviderConfig = {
  appId?: string;
  token?: string;
  voice: string;
  cluster: string;
  speedRatio?: number;
  emotion?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeVolcengineProviderConfig(
  rawConfig: Record<string, unknown>,
): VolcengineTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.volcengine) ?? asObject(rawConfig.volcengine);
  return {
    appId: trimToUndefined(raw?.appId),
    token: normalizeResolvedSecretInputString({
      value: raw?.token,
      path: "messages.tts.providers.volcengine.token",
    }),
    voice: trimToUndefined(raw?.voice) ?? DEFAULT_VOICE,
    cluster: trimToUndefined(raw?.cluster) ?? DEFAULT_CLUSTER,
    speedRatio: asNumber(raw?.speedRatio),
    emotion: trimToUndefined(raw?.emotion),
  };
}

function readProviderConfig(config: SpeechProviderConfig): VolcengineTtsProviderConfig {
  const normalized = normalizeVolcengineProviderConfig({});
  return {
    appId: trimToUndefined(config.appId) ?? normalized.appId,
    token: trimToUndefined(config.token) ?? normalized.token,
    voice: trimToUndefined(config.voice) ?? normalized.voice,
    cluster: trimToUndefined(config.cluster) ?? normalized.cluster,
    speedRatio: asNumber(config.speedRatio) ?? normalized.speedRatio,
    emotion: trimToUndefined(config.emotion) ?? normalized.emotion,
  };
}

export function buildVolcengineSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "volcengine",
    label: "Volcengine",
    aliases: ["bytedance", "doubao"],
    voices: VOLCENGINE_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeVolcengineProviderConfig(rawConfig),

    listVoices: async () =>
      VOLCENGINE_VOICES.map((v) => ({
        id: v,
        name: v.replace(/^zh_(female|male)_/, "").replace(/_.*$/, ""),
        locale: "zh-CN",
        gender: v.includes("_female_") ? "female" : "male",
      })),

    isConfigured: ({ providerConfig }) => {
      const cfg = readProviderConfig(providerConfig);
      return Boolean(
        (cfg.appId || process.env.VOLCENGINE_TTS_APPID) &&
        (cfg.token || process.env.VOLCENGINE_TTS_TOKEN),
      );
    },

    synthesize: async (req) => {
      const cfg = readProviderConfig(req.providerConfig);
      const appId = cfg.appId || process.env.VOLCENGINE_TTS_APPID;
      const token = cfg.token || process.env.VOLCENGINE_TTS_TOKEN;

      if (!appId || !token) {
        throw new Error(
          "Volcengine TTS credentials missing. Set VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_TOKEN, " +
            "or configure messages.tts.providers.volcengine.appId / token.",
        );
      }

      const voice = cfg.voice || process.env.VOLCENGINE_TTS_VOICE || DEFAULT_VOICE;
      const isVoiceNote = req.target === "voice-note";
      const encoding = isVoiceNote ? "ogg_opus" : "mp3";

      const audioBuffer = await volcengineTTS({
        text: req.text,
        appId,
        token,
        voice,
        cluster: cfg.cluster,
        speedRatio: cfg.speedRatio,
        emotion: cfg.emotion,
        encoding,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: encoding === "ogg_opus" ? "opus" : "mp3",
        fileExtension: encoding === "ogg_opus" ? ".opus" : ".mp3",
        voiceCompatible: isVoiceNote,
      };
    },
  };
}
