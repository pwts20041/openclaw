import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const httpTransportMock = {
  request: vi.fn(),
  get: vi.fn(),
};
const httpsTransportMock = {
  request: vi.fn(),
  get: vi.fn(),
};

const {
  sendMessage,
  sendFileUrl,
  fetchChatUsers,
  resolveLegacyWebhookNameToChatUserId,
  setSynologyTransportOverridesForTest,
} = await import("./client.js");
let fakeNowMs = 1_700_000_000_000;

async function settleTimers<T>(promise: Promise<T>): Promise<T> {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}

function mockResponse(statusCode: number, body: string) {
  httpsTransportMock.request.mockImplementation((_url: any, _opts: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    queueMicrotask(() => {
      callback(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    });
    const req = new EventEmitter() as any;
    req.write = vi.fn();
    req.end = vi.fn();
    req.destroy = vi.fn();
    return req;
  });
}

function mockSuccessResponse() {
  mockResponse(200, '{"success":true}');
}

function mockFailureResponse(statusCode = 500) {
  mockResponse(statusCode, "error");
}

function installFakeTimerHarness() {
  beforeEach(() => {
    vi.clearAllMocks();
    setSynologyTransportOverridesForTest({
      http: httpTransportMock,
      https: httpsTransportMock,
    });
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    setSynologyTransportOverridesForTest(undefined);
    vi.useRealTimers();
  });
}

describe("sendMessage", () => {
  installFakeTimerHarness();

  it("returns true on successful send", async () => {
    mockSuccessResponse();
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(true);
  });

  it("returns false on server error after retries", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(false);
  });

  it("includes user_ids when userId is numeric", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", 42));
    expect(httpsTransportMock.request).toHaveBeenCalled();
    const callArgs = httpsTransportMock.request.mock.calls[0];
    expect(callArgs[0]).toBe("https://nas.example.com/incoming");
  });
});

describe("sendFileUrl", () => {
  installFakeTimerHarness();

  it("returns true on success", async () => {
    mockSuccessResponse();
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(true);
  });

  it("returns false on failure", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(false);
  });
});

// Helper to mock the user_list API response for fetchChatUsers / resolveLegacyWebhookNameToChatUserId
function mockUserListResponse(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, false);
}

function mockUserListResponseOnce(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, true);
}

function mockUserListResponseImpl(
  users: Array<{ user_id: number; username: string; nickname: string }>,
  once: boolean,
) {
  const impl = (_url: any, _opts: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    queueMicrotask(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify({ success: true, data: { users } })));
      res.emit("end");
    });
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    return req;
  };
  if (once) {
    httpsTransportMock.get.mockImplementationOnce(impl);
    return;
  }
  httpsTransportMock.get.mockImplementation(impl);
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  beforeEach(() => {
    vi.clearAllMocks();
    setSynologyTransportOverridesForTest({
      http: httpTransportMock,
      https: httpsTransportMock,
    });
    vi.useFakeTimers();
    // Advance time to invalidate any cached user list from previous tests
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    setSynologyTransportOverridesForTest(undefined);
    vi.useRealTimers();
  });

  it("resolves user by nickname (webhook username = Chat nickname)", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    expect(result).toBe(4);
  });

  it("resolves user by username when nickname does not match", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    // Advance time to invalidate cache
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn67",
    });
    expect(result).toBe(4);
  });

  it("is case-insensitive", async () => {
    mockUserListResponse([{ user_id: 4, username: "JMN67", nickname: "JMN" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    expect(result).toBe(4);
  });

  it("returns undefined when user is not found", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "unknown_user",
    });
    expect(result).toBeUndefined();
  });

  it("uses method=user_list instead of method=chatbot in the API URL", async () => {
    mockUserListResponse([]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "anyone",
    });
    expect(httpsTransportMock.get).toHaveBeenCalledWith(
      expect.stringContaining("method=user_list"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponseOnce([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUserListResponseOnce([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);

    const result1 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    const result2 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl2,
      mutableWebhookUsername: "jmn",
    });

    expect(result1).toBe(4);
    expect(result2).toBe(9);
    expect(httpsTransportMock.get).toHaveBeenCalledTimes(2);
  });
});

describe("fetchChatUsers", () => {
  installFakeTimerHarness();

  it("filters malformed user entries while keeping valid ones", async () => {
    httpsTransportMock.get.mockImplementation((_url: any, _opts: any, callback: any) => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      queueMicrotask(() => {
        callback(res);
        res.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              success: true,
              data: {
                users: [
                  { user_id: 4, username: "jmn67", nickname: "jmn" },
                  { user_id: "bad", username: "broken" },
                ],
              },
            }),
          ),
        );
        res.emit("end");
      });
      const req = new EventEmitter() as any;
      req.destroy = vi.fn();
      return req;
    });

    const users = await fetchChatUsers(
      "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22",
    );

    expect(users).toEqual([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
  });
});
