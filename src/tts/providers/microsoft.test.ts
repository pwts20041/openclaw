import { afterEach, describe, expect, it, vi } from "vitest";
import { isCjkDominant, listMicrosoftVoices } from "./microsoft.js";

describe("listMicrosoftVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Microsoft voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "en-US-AvaNeural",
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
            Locale: "en-US",
            Gender: "Female",
            VoiceTag: {
              ContentCategories: ["General"],
              VoicePersonalities: ["Friendly", "Positive"],
            },
          },
        ]),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const voices = await listMicrosoftVoices();

    expect(voices).toEqual([
      {
        id: "en-US-AvaNeural",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        category: "General",
        description: "Friendly, Positive",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/voices/list?trustedclienttoken="),
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "Sec-MS-GEC": expect.any(String),
          "Sec-MS-GEC-Version": expect.stringContaining("1-"),
        }),
      }),
    );
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 503 })) as typeof globalThis.fetch;

    await expect(listMicrosoftVoices()).rejects.toThrow("Microsoft voices API error (503)");
  });
});

describe("isCjkDominant", () => {
  it("returns true for Chinese text", () => {
    expect(isCjkDominant("你好世界")).toBe(true);
  });

  it("returns true for mixed text with majority CJK", () => {
    expect(isCjkDominant("你好，这是一个测试 hello")).toBe(true);
  });

  it("returns false for English text", () => {
    expect(isCjkDominant("Hello, this is a test")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCjkDominant("")).toBe(false);
  });

  it("returns false for mostly English with a few CJK chars", () => {
    expect(isCjkDominant("This is a long English sentence with one 字")).toBe(false);
  });
});
