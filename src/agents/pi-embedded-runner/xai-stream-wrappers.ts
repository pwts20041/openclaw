import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

function resolveXaiFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return XAI_FAST_MODEL_IDS.get(modelId.trim());
}

function stripUnsupportedStrictFlag(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") {
    return tool;
  }
  const toolObj = tool as Record<string, unknown>;
  const fn = toolObj.function;
  if (!fn || typeof fn !== "object") {
    return tool;
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj.strict !== "boolean") {
    return tool;
  }
  const nextFunction = { ...fnObj };
  delete nextFunction.strict;
  return { ...toolObj, function: nextFunction };
}

function stripUnsupportedXaiPayloadFields(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const payloadObj = payload as Record<string, unknown>;
  if (Array.isArray(payloadObj.tools)) {
    payloadObj.tools = payloadObj.tools.map((tool) => stripUnsupportedStrictFlag(tool));
  }
  delete payloadObj.reasoning;
  delete payloadObj.reasoningEffort;
  delete payloadObj.reasoning_effort;
}

export function createXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const supportsFastAliasTransport =
      model.api === "openai-completions" || model.api === "openai-responses";
    if (!fastMode || !supportsFastAliasTransport || model.provider !== "xai") {
      return underlying(model, context, options);
    }

    const fastModelId = resolveXaiFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

export function createXaiReasoningEffortStripWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "xai") {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    const nextOptions = {
      ...(options as Record<string, unknown> | undefined),
      reasoning: undefined,
      reasoningEffort: undefined,
      reasoningSummary: undefined,
      onPayload: (payload: unknown) => {
        stripUnsupportedXaiPayloadFields(payload);
        return originalOnPayload?.(payload, model);
      },
    };
    return underlying(model, context, {
      ...(nextOptions as typeof options),
    });
  };
}
