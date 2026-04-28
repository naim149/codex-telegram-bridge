import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadWatchService, type ThreadStatusSnapshot } from "../src/thread-watch.js";
import type { TeleCodexConfig } from "../src/config.js";

const threadId = "019dc68e-3c88-7401-a062-2c81e96f8e16";

describe("ThreadWatchService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("retries a transition notification when delivery fails", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-watch-"));
    tempDirs.push(workspace);
    const service = new ThreadWatchService(makeConfig(workspace));
    const reader = {
      readThread: vi.fn(),
      listActiveCandidates: vi.fn(),
      dispose: vi.fn(),
    };
    (service as any).reader = reader;

    reader.readThread.mockResolvedValueOnce(snapshot("running"));
    await service.addWatch("133786587", threadId);

    reader.readThread.mockResolvedValue(snapshot("idle"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onTransition = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram offline"))
      .mockResolvedValueOnce(undefined);

    await (service as any).poll(onTransition);

    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(service.listWatches("133786587")[0].lastState).toBe("running");
    expect(warnSpy).toHaveBeenCalledWith(
      "Thread watch notification failed; will retry:",
      "telegram offline",
    );

    await (service as any).poll(onTransition);

    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(service.listWatches("133786587")[0].lastState).toBe("idle");
  });
});

function snapshot(state: "running" | "idle"): ThreadStatusSnapshot {
  return {
    threadId,
    title: "Plan mobile app roadmap",
    workspace: "C:\\Users\\Admin\\project-phoenix",
    model: "gpt-5.5",
    state,
    activeFlags: [],
    lastTurnStatus: state === "idle" ? "completed" : "inProgress",
    lastTurnStartedAt: new Date("2026-04-28T08:05:20.000Z"),
    lastTurnCompletedAt: state === "idle" ? new Date("2026-04-28T20:39:42.000Z") : undefined,
    lastTurnDurationMs: state === "idle" ? 45_261_612 : undefined,
    lastUpdatedAt: state === "idle" ? new Date("2026-04-28T20:39:42.000Z") : new Date("2026-04-28T08:05:20.000Z"),
  };
}

function makeConfig(workspace: string): TeleCodexConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: [133786587],
    telegramAllowedUserIdSet: new Set([133786587]),
    telegramAllowedChatIds: [],
    telegramAllowedChatIdSet: new Set(),
    workspace,
    allowedProjectRoots: [workspace],
    monitoredProjectRoots: [workspace],
    codexSessionBackend: "app-server",
    maxFileSize: 10_000_000,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "on-request",
    launchProfiles: [],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    showTurnTokenUsage: false,
    showAssistantOutputInTelegram: false,
    showErrorDetailsInTelegram: false,
    enableGroupChats: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    enableVoiceInput: false,
    enableFileUploads: false,
    autoSendArtifacts: false,
  };
}
