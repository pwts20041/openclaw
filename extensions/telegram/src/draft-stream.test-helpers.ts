import { vi } from "vitest";

export type TestDraftStream = {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  previewMode: ReturnType<typeof vi.fn<() => "message" | "draft">>;
  previewRevision: ReturnType<typeof vi.fn<() => number>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  materialize: ReturnType<typeof vi.fn<() => Promise<number | undefined>>>;
  prepareFinalization: ReturnType<
    typeof vi.fn<
      (params: {
        text: string;
      }) => Promise<
        | { kind: "finalized"; content: string; messageId?: number }
        | { kind: "edit"; messageId: number; finalTextAlreadyLanded: boolean }
        | { kind: "retained" | "fallback" }
      >
    >
  >;
  archiveActivePreview: ReturnType<
    typeof vi.fn<() => Promise<{ textSnapshot: string; messageId?: number } | undefined>>
  >;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
};

export function createTestDraftStream(params?: {
  messageId?: number;
  previewMode?: "message" | "draft";
  onUpdate?: (text: string) => void;
  onStop?: () => void | Promise<void>;
  clearMessageIdOnForceNew?: boolean;
}): TestDraftStream {
  let messageId = params?.messageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  const stream: TestDraftStream = {
    update: vi.fn().mockImplementation((text: string) => {
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => messageId),
    previewMode: vi.fn().mockReturnValue(params?.previewMode ?? "message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    materialize: vi.fn().mockImplementation(async () => messageId),
    prepareFinalization: vi.fn().mockImplementation(async ({ text }: { text: string }) => {
      if ((params?.previewMode ?? "message") === "draft") {
        const materializedMessageId = await stream.materialize();
        if (typeof materializedMessageId === "number") {
          return {
            kind: "finalized",
            content: text.trimEnd(),
            messageId: materializedMessageId,
          } as const;
        }
        return { kind: "fallback" } as const;
      }
      if (typeof messageId === "number") {
        return { kind: "edit", messageId, finalTextAlreadyLanded: false } as const;
      }
      if (stream.sendMayHaveLanded() && previewRevision > 0) {
        return { kind: "retained" } as const;
      }
      return { kind: "fallback" } as const;
    }),
    archiveActivePreview: vi.fn().mockImplementation(async () =>
      lastDeliveredText
        ? {
            textSnapshot: lastDeliveredText,
            ...(typeof messageId === "number" ? { messageId } : {}),
          }
        : undefined,
    ),
    forceNewMessage: vi.fn().mockImplementation(() => {
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
    },
  };
  return stream;
}

export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeMessageId: number | undefined;
  let nextMessageId = startMessageId;
  let lastDeliveredText = "";
  const stream: TestDraftStream = {
    update: vi.fn().mockImplementation((text: string) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      lastDeliveredText = text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    previewMode: vi.fn().mockReturnValue("message"),
    previewRevision: vi.fn().mockImplementation(() => 0),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    materialize: vi.fn().mockImplementation(async () => activeMessageId),
    prepareFinalization: vi.fn().mockImplementation(async ({ text }: { text: string }) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      return {
        kind: "edit",
        messageId: activeMessageId,
        finalTextAlreadyLanded: false,
      } as const;
    }),
    archiveActivePreview: vi.fn().mockImplementation(async () =>
      lastDeliveredText
        ? {
            textSnapshot: lastDeliveredText,
            ...(typeof activeMessageId === "number" ? { messageId: activeMessageId } : {}),
          }
        : undefined,
    ),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = undefined;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      activeMessageId = value;
    },
  };
  return stream;
}
