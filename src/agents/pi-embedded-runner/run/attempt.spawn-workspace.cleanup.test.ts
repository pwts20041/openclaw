import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createDefaultEmbeddedSession,
  createSubscriptionMock,
  getHoisted,
  loadRunEmbeddedAttempt,
  resetEmbeddedAttemptHarness,
  testModel,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt cleanup", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness({
      subscribeImpl: createSubscriptionMock,
    });
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("clears the active run and releases session resources when idle flush fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");

    const disposeMock = vi.fn();
    const flushError = new Error("flush failed");
    hoisted.flushPendingToolResultsAfterIdleMock.mockRejectedValueOnce(flushError);
    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: {
        ...createDefaultEmbeddedSession(),
        dispose: disposeMock,
      },
    }));

    const runEmbeddedAttempt = await loadRunEmbeddedAttempt();
    await expect(
      runEmbeddedAttempt({
        sessionId: "embedded-session",
        sessionKey: "agent:main:test-cleanup",
        sessionFile,
        workspaceDir,
        agentDir,
        config: {},
        prompt: "hello",
        timeoutMs: 10_000,
        runId: "run-cleanup-flush-failure",
        provider: "openai",
        modelId: "gpt-test",
        model: testModel,
        authStorage: {} as AuthStorage,
        modelRegistry: {} as ModelRegistry,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
      }),
    ).rejects.toThrow(flushError);

    expect(hoisted.flushPendingToolResultsAfterIdleMock).toHaveBeenCalledTimes(1);
    expect(hoisted.setActiveEmbeddedRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.clearActiveEmbeddedRunMock).toHaveBeenCalledWith(
      "embedded-session",
      expect.any(Object),
      "agent:main:test-cleanup",
    );
    expect(hoisted.flushPendingToolResultsAfterIdleMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.clearActiveEmbeddedRunMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session");
    expect(hoisted.sessionLockReleaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionLockReleaseMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.clearActiveEmbeddedRunMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("skips active-run clear without masking the original error when subscribe fails before registration", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");

    const disposeMock = vi.fn();
    const subscribeError = new Error("subscribe failed");
    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockImplementation(() => {
      throw subscribeError;
    });
    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: {
        ...createDefaultEmbeddedSession(),
        dispose: disposeMock,
      },
    }));

    const runEmbeddedAttempt = await loadRunEmbeddedAttempt();
    await expect(
      runEmbeddedAttempt({
        sessionId: "embedded-session",
        sessionKey: "agent:main:test-subscribe-failure",
        sessionFile,
        workspaceDir,
        agentDir,
        config: {},
        prompt: "hello",
        timeoutMs: 10_000,
        runId: "run-cleanup-subscribe-failure",
        provider: "openai",
        modelId: "gpt-test",
        model: testModel,
        authStorage: {} as AuthStorage,
        modelRegistry: {} as ModelRegistry,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
      }),
    ).rejects.toThrow(subscribeError);

    expect(hoisted.setActiveEmbeddedRunMock).not.toHaveBeenCalled();
    expect(hoisted.clearActiveEmbeddedRunMock).not.toHaveBeenCalled();
    expect(hoisted.flushPendingToolResultsAfterIdleMock).toHaveBeenCalledTimes(1);
  });

  it("clears the active run only after idle flush and session lock release finish", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");

    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: createDefaultEmbeddedSession(),
    }));

    const runEmbeddedAttempt = await loadRunEmbeddedAttempt();
    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:test-cleanup-order",
      sessionFile,
      workspaceDir,
      agentDir,
      config: {},
      prompt: "hello",
      timeoutMs: 10_000,
      runId: "run-cleanup-order",
      provider: "openai",
      modelId: "gpt-test",
      model: testModel,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
    });

    expect(result.promptError).toBeNull();
    expect(hoisted.clearActiveEmbeddedRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.flushPendingToolResultsAfterIdleMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionLockReleaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.flushPendingToolResultsAfterIdleMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.sessionLockReleaseMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(hoisted.sessionLockReleaseMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.clearActiveEmbeddedRunMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps the active run registered when session lock release fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");

    const lockReleaseError = new Error("lock release failed");
    hoisted.sessionLockReleaseMock.mockRejectedValueOnce(lockReleaseError);
    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: createDefaultEmbeddedSession(),
    }));

    const runEmbeddedAttempt = await loadRunEmbeddedAttempt();
    await expect(
      runEmbeddedAttempt({
        sessionId: "embedded-session",
        sessionKey: "agent:main:test-cleanup-lock-release",
        sessionFile,
        workspaceDir,
        agentDir,
        config: {},
        prompt: "hello",
        timeoutMs: 10_000,
        runId: "run-cleanup-lock-release",
        provider: "openai",
        modelId: "gpt-test",
        model: testModel,
        authStorage: {} as AuthStorage,
        modelRegistry: {} as ModelRegistry,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
      }),
    ).rejects.toThrow(lockReleaseError);

    expect(hoisted.flushPendingToolResultsAfterIdleMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionLockReleaseMock).toHaveBeenCalledTimes(1);
    expect(hoisted.clearActiveEmbeddedRunMock).not.toHaveBeenCalled();
    expect(hoisted.releaseWsSessionMock).toHaveBeenCalledWith("embedded-session");
    expect(hoisted.flushPendingToolResultsAfterIdleMock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.sessionLockReleaseMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
