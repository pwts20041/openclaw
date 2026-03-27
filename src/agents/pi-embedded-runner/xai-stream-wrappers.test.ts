import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createXaiFastModeWrapper,
  createXaiReasoningEffortStripWrapper,
} from "./xai-stream-wrappers.js";

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean;
  api?: Extract<Api, "openai-completions" | "openai-responses">;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: params.api ?? "openai-responses",
      provider: "xai",
      id: params.modelId,
    } as Model<Extract<Api, "openai-completions" | "openai-responses">>,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

describe("xai fast mode wrapper", () => {
  it("rewrites Grok 3 models to fast variants for Responses and completions transports", () => {
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: true })).toBe("grok-3-fast");
    expect(
      captureWrappedModelId({
        modelId: "grok-3",
        fastMode: true,
        api: "openai-completions",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3-mini", fastMode: true })).toBe(
      "grok-3-mini-fast",
    );
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ modelId: "grok-3-fast", fastMode: true })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ modelId: "grok-3", fastMode: false })).toBe("grok-3");
  });
});

describe("xai reasoning effort wrapper", () => {
  it("strips reasoning controls for xai models", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options as Record<string, unknown>;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createXaiReasoningEffortStripWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4.20-beta-latest-reasoning",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {
        reasoning: "high",
        reasoningEffort: "high",
        reasoningSummary: "auto",
      } as never,
    );

    expect(capturedOptions).toMatchObject({
      reasoning: undefined,
      reasoningEffort: undefined,
      reasoningSummary: undefined,
    });
  });

  it("leaves non-xai models untouched", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options as Record<string, unknown>;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createXaiReasoningEffortStripWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {
        reasoning: "high",
        reasoningEffort: "high",
      } as never,
    );

    expect(capturedOptions).toMatchObject({
      reasoning: "high",
      reasoningEffort: "high",
    });
  });
});
