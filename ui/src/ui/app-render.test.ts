import { describe, expect, it } from "vitest";

// Import the function and regex patterns
// Note: These are private in app-render.ts, so we'll test through the public API
// For now, we'll extract and test the logic directly

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

/**
 * Extracted logic from resolveAssistantAvatarUrl for testing
 * This mirrors the implementation in app-render.ts
 */
function resolveAssistantAvatarUrl(state: unknown): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = state as any;
  const list = s.agentsList?.agents ?? [];
  const agentId = s.agentsList?.defaultId ?? "main";
  const agent = list.find((entry: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (entry as any).id === agentId;
  });
  const identity = agent?.identity;
  // Prefer avatarUrl (which should be a data URL or HTTP URL from backend)
  // Validate it to ensure it's a safe URL before using
  const avatarUrl = identity?.avatarUrl;
  if (avatarUrl && (AVATAR_DATA_RE.test(avatarUrl) || AVATAR_HTTP_RE.test(avatarUrl))) {
    return avatarUrl;
  }
  // If avatarUrl is not available or invalid, check if avatar is a valid URL
  const avatar = identity?.avatar;
  if (avatar && (AVATAR_DATA_RE.test(avatar) || AVATAR_HTTP_RE.test(avatar))) {
    return avatar;
  }
  return undefined;
}

describe("resolveAssistantAvatarUrl", () => {
  describe("avatarUrl priority (backend-processed)", () => {
    it("returns avatarUrl when it is a data URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      );
    });

    it("returns avatarUrl when it is an HTTP URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "https://example.com/avatar.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("https://example.com/avatar.png");
    });

    it("returns avatarUrl when it is an HTTPS URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "https://cdn.example.com/avatars/lumi.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("https://cdn.example.com/avatars/lumi.png");
    });
  });

  describe("avatar fallback (raw config field)", () => {
    it("returns avatar when avatarUrl is undefined and avatar is HTTP URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatar: "http://example.com/avatar.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("http://example.com/avatar.png");
    });

    it("returns avatar when avatarUrl is undefined and avatar is data URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatar: "data:image/png;base64,ABC123",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("data:image/png;base64,ABC123");
    });
  });

  describe("edge cases and empty string handling", () => {
    it("returns avatar when avatarUrl is empty string and avatar is HTTP URL (the bug fix)", () => {
      // This is the critical edge case that the fix addresses
      // Empty string should be treated as absent, not as a valid URL
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "", // Empty string - should fall through to avatar
                avatar: "https://example.com/avatar.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("https://example.com/avatar.png");
    });

    it("returns undefined when avatarUrl is empty string and avatar is local path", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "",
                avatar: "avatars/lumi.png", // Local path - not a valid URL
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("returns undefined when both avatarUrl and avatar are undefined", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("returns undefined when both avatarUrl and avatar are empty strings", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "",
                avatar: "",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("returns undefined when avatarUrl is invalid URL and avatar is local path", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "not-a-valid-url",
                avatar: "avatars/lumi.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });
  });

  describe("URL validation", () => {
    it("rejects avatarUrl with relative path", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "/avatars/lumi.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("rejects avatar with relative path", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatar: "/avatars/lumi.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("accepts data URL with uppercase DATA prefix", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "DATA:image/png;base64,ABC123",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("DATA:image/png;base64,ABC123");
    });

    it("accepts HTTP URL (not just HTTPS)", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatar: "http://example.com/avatar.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("http://example.com/avatar.png");
    });
  });

  describe("missing agent or identity", () => {
    it("returns undefined when agent list is empty", () => {
      const state = {
        agentsList: {
          agents: [],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("returns undefined when agentsList is undefined", () => {
      const state = {
        agentsList: undefined,
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });

    it("returns undefined when agent identity is undefined", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              // identity is undefined
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBeUndefined();
    });
  });

  describe("avatarUrl takes priority over avatar", () => {
    it("returns avatarUrl when both avatarUrl and avatar are valid URLs", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "https://backend.example.com/avatar-processed.png",
                avatar: "https://config.example.com/avatar-original.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe(
        "https://backend.example.com/avatar-processed.png",
      );
    });

    it("returns avatarUrl (data URL) even when avatar is HTTP URL", () => {
      const state = {
        agentsList: {
          agents: [
            {
              id: "main",
              identity: {
                name: "Test Agent",
                avatarUrl: "data:image/png;base64,ABC123",
                avatar: "https://example.com/avatar.png",
              },
            },
          ],
          defaultId: "main",
        },
        sessionKey: "main",
      } as unknown;

      expect(resolveAssistantAvatarUrl(state)).toBe("data:image/png;base64,ABC123");
    });
  });
});
