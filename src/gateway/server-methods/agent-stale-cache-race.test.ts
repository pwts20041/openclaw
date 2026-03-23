/**
 * Targeted regression test for issue #5369: stale-cache race in agent handler.
 *
 * This test does NOT import agent.ts (which has transitive module-loading
 * issues in this environment).  Instead it reproduces the exact data-flow
 * pattern that main uses vs the fix, so we can prove:
 *
 *   1. main's pattern drops a freshly-written modelOverride  (FAIL = bug exists)
 *   2. the fix's pattern preserves it                        (PASS = bug fixed)
 *
 * The "updateSessionStore" contract: the mutator receives a `store` object
 * that was loaded with `skipCache: true` (fresh from disk).  The mutator
 * must use that fresh data — not a stale `entry` captured before the lock.
 */
import { describe, expect, it } from "vitest";

// ─── Minimal types mirroring SessionEntry ────────────────────────────
interface SessionEntry {
  sessionId: string;
  updatedAt: number;
  modelOverride?: string;
  providerOverride?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  label?: string;
  spawnedBy?: string;
  [key: string]: unknown;
}

// ─── Simulate updateSessionStore ─────────────────────────────────────
// Real implementation: acquires lock, loads store with skipCache:true,
// calls mutator(store), saves store.
async function fakeUpdateSessionStore(
  freshStoreSnapshot: Record<string, SessionEntry>,
  mutator: (store: Record<string, SessionEntry>) => void | SessionEntry,
): Promise<Record<string, SessionEntry>> {
  // The real function does: const store = loadSessionStore(path, { skipCache: true })
  // We pass the fresh snapshot directly.
  mutator(freshStoreSnapshot);
  return freshStoreSnapshot;
}

// ─── The two code patterns under test ────────────────────────────────

/**
 * main's pattern (VULNERABLE):
 *   1. Read entry from cache (may be stale)
 *   2. Build nextEntry from stale entry
 *   3. Inside updateSessionStore mutator, blindly write: store[key] = nextEntry
 */
async function mainPattern(
  staleEntry: SessionEntry | undefined,
  freshStore: Record<string, SessionEntry>,
  sessionKey: string,
  requestLabel?: string,
): Promise<Record<string, SessionEntry>> {
  // Step 1: staleEntry is what loadSessionEntry() returned (cached, potentially stale)
  const entry = staleEntry;

  // Step 2: Build nextEntry from stale data (lines 239-262 on main)
  const nextEntry: SessionEntry = {
    sessionId: entry?.sessionId ?? "generated-id",
    updatedAt: Date.now(),
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    modelOverride: entry?.modelOverride, // <-- READS FROM STALE CACHE
    providerOverride: entry?.providerOverride, // <-- READS FROM STALE CACHE
    label: requestLabel?.trim() || entry?.label,
    spawnedBy: entry?.spawnedBy,
  };

  // Step 3: updateSessionStore mutator blindly writes stale nextEntry (lines 284-286 on main)
  await fakeUpdateSessionStore(freshStore, (store) => {
    store[sessionKey] = nextEntry; // <-- OVERWRITES FRESH DATA WITH STALE
  });

  return freshStore;
}

/**
 * Fix pattern (from PR #19328):
 *   1. Read entry from cache (may be stale) — used only for non-store fields
 *   2. Inside updateSessionStore mutator, read freshEntry from store
 *   3. Build nextEntry from freshEntry
 */
async function fixPattern(
  _staleEntry: SessionEntry | undefined,
  freshStore: Record<string, SessionEntry>,
  sessionKey: string,
  requestLabel?: string,
  requestSpawnedBy?: string,
): Promise<Record<string, SessionEntry>> {
  // The fix builds nextEntry INSIDE the mutator, using fresh store data
  await fakeUpdateSessionStore(freshStore, (store) => {
    const freshEntry = store[sessionKey]; // <-- READS FROM FRESH STORE

    const nextEntry: SessionEntry = {
      sessionId: freshEntry?.sessionId ?? "generated-id",
      updatedAt: Date.now(),
      thinkingLevel: freshEntry?.thinkingLevel,
      verboseLevel: freshEntry?.verboseLevel,
      modelOverride: freshEntry?.modelOverride, // <-- READS FROM FRESH STORE
      providerOverride: freshEntry?.providerOverride, // <-- READS FROM FRESH STORE
      label: requestLabel ?? freshEntry?.label, // Request params override fresh store
      spawnedBy: requestSpawnedBy ?? freshEntry?.spawnedBy,
    };

    store[sessionKey] = nextEntry;
  });

  return freshStore;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("issue #5369: stale-cache race in agent handler session entry construction", () => {
  const SESSION_KEY = "agent:main:subagent:spawn-uuid";

  /**
   * Core race scenario:
   *   1. sessions_spawn calls sessions.patch → writes modelOverride to store
   *   2. agent handler calls loadSessionEntry → gets stale cached entry (no modelOverride)
   *   3. agent handler builds nextEntry from stale entry → modelOverride is undefined
   *   4. updateSessionStore opens lock, loads fresh store (HAS modelOverride)
   *   5. mutator writes nextEntry to store → OVERWRITES the fresh modelOverride
   *
   * Expected: modelOverride survives in the store after the agent handler runs.
   */
  it("main pattern: stale cache read overwrites fresh modelOverride (demonstrates the bug)", async () => {
    // Stale cached entry: loadSessionEntry returned this BEFORE sessions.patch wrote modelOverride
    const staleEntry: SessionEntry = {
      sessionId: "subagent-session-id",
      updatedAt: Date.now() - 1000,
      // NO modelOverride — this is the stale state
    };

    // Fresh store: sessions.patch has already written modelOverride here
    const freshStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now(),
        modelOverride: "qwen3-coder:30b",
        providerOverride: "ollama",
      },
    };

    const result = await mainPattern(staleEntry, freshStore, SESSION_KEY);

    // BUG: main's pattern overwrites the fresh modelOverride with undefined
    // This assertion documents the broken behavior:
    expect(result[SESSION_KEY]?.modelOverride).toBeUndefined();
    expect(result[SESSION_KEY]?.providerOverride).toBeUndefined();

    // What it SHOULD be (but isn't on main):
    // expect(result[SESSION_KEY]?.modelOverride).toBe("qwen3-coder:30b");
  });

  it("fix pattern: fresh store modelOverride is preserved", async () => {
    const staleEntry: SessionEntry = {
      sessionId: "subagent-session-id",
      updatedAt: Date.now() - 1000,
      // NO modelOverride — stale
    };

    const freshStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now(),
        modelOverride: "qwen3-coder:30b",
        providerOverride: "ollama",
      },
    };

    const result = await fixPattern(staleEntry, freshStore, SESSION_KEY);

    // FIXED: modelOverride is preserved from fresh store
    expect(result[SESSION_KEY]?.modelOverride).toBe("qwen3-coder:30b");
    expect(result[SESSION_KEY]?.providerOverride).toBe("ollama");
  });

  it("main pattern: stale thinkingLevel/verboseLevel overwrites fresh values too", async () => {
    const staleEntry: SessionEntry = {
      sessionId: "subagent-session-id",
      updatedAt: Date.now() - 1000,
      // Stale: no thinkingLevel set
    };

    const freshStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now(),
        thinkingLevel: "high",
        verboseLevel: "detailed",
        modelOverride: "claude-opus",
        providerOverride: "anthropic",
      },
    };

    const result = await mainPattern(staleEntry, freshStore, SESSION_KEY);

    // BUG: ALL fields from fresh store are lost
    expect(result[SESSION_KEY]?.thinkingLevel).toBeUndefined();
    expect(result[SESSION_KEY]?.verboseLevel).toBeUndefined();
    expect(result[SESSION_KEY]?.modelOverride).toBeUndefined();
    expect(result[SESSION_KEY]?.providerOverride).toBeUndefined();
  });

  it("fix pattern: request params (label, spawnedBy) override fresh store values", async () => {
    const staleEntry: SessionEntry = {
      sessionId: "subagent-session-id",
      updatedAt: Date.now() - 1000,
    };

    const freshStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now(),
        label: "store-label",
        spawnedBy: "store-spawner",
        modelOverride: "gpt-4",
        providerOverride: "openai",
      },
    };

    const result = await fixPattern(
      staleEntry,
      freshStore,
      SESSION_KEY,
      "request-label", // Should override fresh store label
      "request-spawner", // Should override fresh store spawnedBy
    );

    // Request params take precedence
    expect(result[SESSION_KEY]?.label).toBe("request-label");
    expect(result[SESSION_KEY]?.spawnedBy).toBe("request-spawner");
    // But modelOverride must still come from fresh store
    expect(result[SESSION_KEY]?.modelOverride).toBe("gpt-4");
    expect(result[SESSION_KEY]?.providerOverride).toBe("openai");
  });

  it("fix pattern: new session (no fresh store entry) creates entry with generated sessionId", async () => {
    const staleEntry = undefined; // Brand new session, nothing cached

    const freshStore: Record<string, SessionEntry> = {}; // Nothing in store either

    const result = await fixPattern(staleEntry, freshStore, SESSION_KEY, "new-label");

    expect(result[SESSION_KEY]).toBeDefined();
    expect(result[SESSION_KEY]?.sessionId).toBe("generated-id");
    expect(result[SESSION_KEY]?.label).toBe("new-label");
    expect(result[SESSION_KEY]?.modelOverride).toBeUndefined(); // Correctly undefined
  });

  it("main pattern: even when stale and fresh agree, the pattern works — the bug is timing-dependent", async () => {
    // When cache is fresh (no race), main's pattern happens to work
    const entry: SessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      modelOverride: "claude-sonnet",
      providerOverride: "anthropic",
    };

    const freshStore: Record<string, SessionEntry> = {
      [SESSION_KEY]: { ...entry },
    };

    const result = await mainPattern(entry, freshStore, SESSION_KEY);

    // No race → works fine. This is why the bug only manifests ~3% of the time.
    expect(result[SESSION_KEY]?.modelOverride).toBe("claude-sonnet");
    expect(result[SESSION_KEY]?.providerOverride).toBe("anthropic");
  });
});
