import * as crypto from "node:crypto";
import * as https from "node:https";

export type VolcengineTTSParams = {
  text: string;
  appId: string;
  token: string;
  voice?: string;
  cluster?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
  emotion?: string;
  encoding?: "ogg_opus" | "mp3" | "pcm" | "wav";
  timeoutMs?: number;
};

const DEFAULT_VOICE = "zh_female_xiaohe_uranus_bigtts";
const DEFAULT_CLUSTER = "volcano_tts";
const API_HOST = "openspeech.bytedance.com";

export async function volcengineTTS(params: VolcengineTTSParams): Promise<Buffer> {
  const {
    text,
    appId,
    token,
    voice = DEFAULT_VOICE,
    cluster = DEFAULT_CLUSTER,
    speedRatio = 1.0,
    volumeRatio = 1.0,
    pitchRatio = 1.0,
    emotion,
    encoding = "ogg_opus",
    timeoutMs = 30_000,
  } = params;

  const payload = JSON.stringify({
    app: { appid: appId, token, cluster },
    user: { uid: "openclaw" },
    audio: {
      voice_type: voice,
      encoding,
      speed_ratio: speedRatio,
      volume_ratio: volumeRatio,
      pitch_ratio: pitchRatio,
      ...(emotion ? { emotion } : {}),
    },
    request: {
      reqid: crypto.randomUUID(),
      text,
      text_type: "plain",
      operation: "query",
    },
  });

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const req = https.request(
      {
        hostname: API_HOST,
        port: 443,
        path: "/api/v1/tts",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer;${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Volcengine TTS response stream error: ${e.message}`));
        });
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (body.code === 3000 && body.data) {
              resolve(Buffer.from(body.data, "base64"));
            } else {
              reject(new Error(`Volcengine TTS error ${body.code}: ${body.message ?? "unknown"}`));
            }
          } catch (e) {
            reject(new Error(`Volcengine TTS: failed to parse response: ${e}`));
          }
        });
      },
    );

    timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Volcengine TTS timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Volcengine TTS request error: ${e.message}`));
    });

    req.write(payload);
    req.end();
  });
}
