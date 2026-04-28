import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CodexAppServerClient } from "./codex-app-server.js";
import { buildCodexChildEnv } from "./codex-env.js";
import { getThread, listThreads, type CodexThreadRecord } from "./codex-state.js";
import { isWorkspaceAllowed, type TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export type ThreadWatchState =
  | "running"
  | "observed_running"
  | "waiting_for_input"
  | "idle"
  | "failed"
  | "not_found"
  | "unknown";

export interface ThreadStatusSnapshot {
  threadId: string;
  title: string;
  workspace: string;
  model?: string;
  isSubAgent?: boolean;
  state: ThreadWatchState;
  statusLabel?: string;
  activeFlags: string[];
  lastTurnId?: string;
  lastTurnStatus?: string;
  lastTurnStartedAt?: Date;
  lastTurnCompletedAt?: Date;
  lastTurnDurationMs?: number;
  lastTurnError?: string;
  lastUpdatedAt?: Date;
  latestAssistantMessage?: string;
}

export interface WatchRecord {
  contextKey: TelegramContextKey;
  threadId: string;
  title: string;
  workspace: string;
  model?: string;
  lastState?: ThreadWatchState;
  lastTurnStatus?: string;
  lastTurnStartedAt?: string;
  lastTurnCompletedAt?: string;
  lastTurnDurationMs?: number;
  lastUpdatedAt?: string;
  runningStartedAt?: number;
  lastRunDurationMs?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WatchTransition {
  watch: WatchRecord;
  previousState?: ThreadWatchState;
  current: ThreadStatusSnapshot;
}

const RECENT_DATABASE_ACTIVITY_MS = 10 * 60 * 1000;

export class ThreadWatchService {
  private readonly persistPath: string;
  private readonly reader: ThreadStatusReader;
  private readonly watches = new Map<string, WatchRecord>();
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "watches.json");
    this.reader = new ThreadStatusReader(config);
    this.load();
  }

  async listActiveCandidates(limit = 12): Promise<ThreadStatusSnapshot[]> {
    return this.reader.listActiveCandidates(limit);
  }

  async addWatch(contextKey: TelegramContextKey, threadId: string): Promise<WatchRecord> {
    const snapshot = await this.reader.readThread(threadId);
    if (snapshot.state === "not_found") {
      throw new Error("Unknown Codex session.");
    }

    const now = Date.now();
    const watch: WatchRecord = {
      contextKey,
      threadId,
      title: snapshot.title,
      workspace: snapshot.workspace,
      model: snapshot.model,
      lastState: snapshot.state,
      lastTurnStatus: snapshot.lastTurnStatus,
      lastTurnStartedAt: snapshot.lastTurnStartedAt?.toISOString(),
      lastTurnCompletedAt: snapshot.lastTurnCompletedAt?.toISOString(),
      lastTurnDurationMs: snapshot.lastTurnDurationMs,
      lastUpdatedAt: snapshot.lastUpdatedAt?.toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    if (isActiveWatchState(snapshot.state)) {
      watch.runningStartedAt = now;
    }

    this.watches.set(watchKey(contextKey, threadId), watch);
    this.persist();
    return watch;
  }

  removeWatch(contextKey: TelegramContextKey, threadId: string): boolean {
    const removed = this.watches.delete(watchKey(contextKey, threadId));
    if (removed) {
      this.persist();
    }
    return removed;
  }

  removeAllForContext(contextKey: TelegramContextKey): number {
    let removed = 0;
    for (const key of this.watches.keys()) {
      if (key.startsWith(`${contextKey}\0`)) {
        this.watches.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  listWatches(contextKey?: TelegramContextKey): WatchRecord[] {
    const values = [...this.watches.values()];
    return values
      .filter((watch) => !contextKey || watch.contextKey === contextKey)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async refreshWatches(contextKey?: TelegramContextKey): Promise<WatchRecord[]> {
    for (const watch of this.listWatches(contextKey)) {
      const current = await this.reader.readThread(watch.threadId);
      this.applySnapshot(watch, current, Date.now());
    }
    this.persist();
    return this.listWatches(contextKey);
  }

  start(onTransition: (transition: WatchTransition) => Promise<void> | void, intervalMs = 30_000): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.poll(onTransition).catch((error) => {
        console.warn("Thread watch poll failed:", error instanceof Error ? error.message : String(error));
      });
    }, intervalMs);
    this.pollTimer.unref?.();

    void this.poll(onTransition).catch((error) => {
      console.warn("Initial thread watch poll failed:", error instanceof Error ? error.message : String(error));
    });
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.reader.dispose();
  }

  private async poll(onTransition: (transition: WatchTransition) => Promise<void> | void): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;

    try {
      for (const watch of this.listWatches()) {
        const now = Date.now();
        const current = await this.reader.readThread(watch.threadId);
        const { previousState, changed } = this.applySnapshot(watch, current, now);

        if (changed && previousState && shouldNotifyTransition(previousState, current.state)) {
          await onTransition({ watch: { ...watch }, previousState, current });
        }
      }
    } finally {
      this.polling = false;
      this.persist();
    }
  }

  private load(): void {
    if (!existsSync(this.persistPath)) {
      return;
    }

    try {
      const records = JSON.parse(readFileSync(this.persistPath, "utf8")) as WatchRecord[];
      for (const record of records) {
        if (record.contextKey && record.threadId) {
          this.watches.set(watchKey(record.contextKey, record.threadId), record);
        }
      }
    } catch {
      // Ignore corrupt watch state; commands can recreate subscriptions.
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistPath, JSON.stringify([...this.watches.values()], null, 2), "utf8");
    } catch (error) {
      console.warn("Failed to persist thread watches:", error instanceof Error ? error.message : String(error));
    }
  }

  private applySnapshot(
    watch: WatchRecord,
    current: ThreadStatusSnapshot,
    now: number,
  ): { previousState: ThreadWatchState | undefined; changed: boolean } {
    const previousState = watch.lastState;
    const changed = previousState !== undefined && previousState !== current.state;
    const wasActive = previousState ? isActiveWatchState(previousState) : false;
    const isActive = isActiveWatchState(current.state);

    if (isActive && (!wasActive || !watch.runningStartedAt)) {
      watch.runningStartedAt = now;
      if (!wasActive) {
        watch.lastRunDurationMs = undefined;
        watch.completedAt = undefined;
      }
    }

    if (!isActive && (wasActive || watch.runningStartedAt) && (current.state === "idle" || current.state === "failed")) {
      const startedAt = watch.runningStartedAt ?? watch.createdAt;
      watch.lastRunDurationMs = Math.max(0, now - startedAt);
      watch.completedAt = now;
      watch.runningStartedAt = undefined;
    }

    watch.title = current.title;
    watch.workspace = current.workspace;
    watch.model = current.model;
    watch.lastState = current.state;
    watch.lastTurnStatus = current.lastTurnStatus;
    watch.lastTurnStartedAt = current.lastTurnStartedAt?.toISOString();
    watch.lastTurnCompletedAt = current.lastTurnCompletedAt?.toISOString();
    watch.lastTurnDurationMs = current.lastTurnDurationMs;
    watch.lastUpdatedAt = current.lastUpdatedAt?.toISOString();
    watch.updatedAt = now;

    return { previousState, changed };
  }
}

export class ThreadStatusReader {
  private appServer: CodexAppServerClient | null = null;

  constructor(private readonly config: TeleCodexConfig) {}

  async listActiveCandidates(limit = 12): Promise<ThreadStatusSnapshot[]> {
    const recentThreads = listThreads(Math.max(limit * 4, 40))
      .filter((thread) => !thread.isSubAgent)
      .filter((thread) => isWorkspaceAllowed(thread.cwd, this.config.monitoredProjectRoots));

    const snapshots: ThreadStatusSnapshot[] = [];
    for (const thread of recentThreads) {
      const snapshot = await this.readThread(thread.id, thread);
      if (isActiveWatchState(snapshot.state)) {
        snapshots.push(snapshot);
      }
      if (snapshots.length >= limit) {
        break;
      }
    }

    return snapshots.sort((left, right) => {
      const leftTime = left.lastUpdatedAt?.getTime() ?? 0;
      const rightTime = right.lastUpdatedAt?.getTime() ?? 0;
      return rightTime - leftTime;
    });
  }

  async readThread(threadId: string, knownRecord?: CodexThreadRecord): Promise<ThreadStatusSnapshot> {
    const record = knownRecord ?? getThread(threadId);
    if (!record) {
      return {
        threadId,
        title: "(unknown)",
        workspace: "",
        state: "not_found",
        activeFlags: [],
      };
    }

    if (!isWorkspaceAllowed(record.cwd, this.config.monitoredProjectRoots)) {
      throw new Error("Workspace is not allowed by the configured monitored roots.");
    }

    try {
      const result = await this.getAppServer().request("thread/read", {
        threadId,
        includeTurns: true,
      });

      return snapshotFromAppServerThread(record, result?.thread);
    } catch (error) {
      return {
        threadId: record.id,
        title: record.title || record.firstUserMessage || "(untitled)",
        workspace: record.cwd,
        model: record.model ?? undefined,
        isSubAgent: record.isSubAgent,
        state: "unknown",
        activeFlags: [],
        lastTurnError: error instanceof Error ? error.message : String(error),
        lastUpdatedAt: record.updatedAt,
      };
    }
  }

  dispose(): void {
    this.appServer?.dispose();
    this.appServer = null;
  }

  private getAppServer(): CodexAppServerClient {
    if (!this.appServer) {
      this.appServer = new CodexAppServerClient({
        codexBin: this.config.codexBin ?? "codex",
        env: buildCodexChildEnv(this.config.codexApiKey),
      });
    }
    return this.appServer;
  }
}

function snapshotFromAppServerThread(record: CodexThreadRecord, thread: any): ThreadStatusSnapshot {
  const status = normalizeThreadStatus(thread?.status);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.at(-1);
  const lastTurnStatus = typeof lastTurn?.status === "string" ? lastTurn.status : undefined;
  const lastTurnStartedAt = dateFromUnixSeconds(lastTurn?.startedAt);
  const lastTurnCompletedAt = dateFromUnixSeconds(lastTurn?.completedAt);
  const lastTurnDurationMs = typeof lastTurn?.durationMs === "number" ? lastTurn.durationMs : undefined;
  const lastTurnError = typeof lastTurn?.error?.message === "string" ? lastTurn.error.message : undefined;
  const updatedAt = dateFromUnixSeconds(thread?.updatedAt) ?? record.updatedAt;
  const state = deriveState(status?.type, status?.activeFlags ?? [], lastTurnStatus, updatedAt);

  return {
    threadId: record.id,
    title: (typeof thread?.title === "string" && thread.title) || record.title || record.firstUserMessage || "(untitled)",
    workspace: typeof thread?.cwd === "string" ? thread.cwd : record.cwd,
    model: (typeof thread?.model === "string" ? thread.model : record.model) ?? undefined,
    isSubAgent: record.isSubAgent,
    state,
    statusLabel: status?.label,
    activeFlags: status?.activeFlags ?? [],
    lastTurnId: typeof lastTurn?.id === "string" ? lastTurn.id : undefined,
    lastTurnStatus,
    lastTurnStartedAt,
    lastTurnCompletedAt,
    lastTurnDurationMs,
    lastTurnError,
    lastUpdatedAt: updatedAt,
    latestAssistantMessage: findLatestAssistantMessage(turns),
  };
}

function normalizeThreadStatus(rawStatus: any): { label: string; type?: string; activeFlags: string[] } | null {
  if (rawStatus === null || rawStatus === undefined) {
    return null;
  }

  if (typeof rawStatus === "string") {
    return { label: rawStatus, type: rawStatus, activeFlags: [] };
  }

  if (typeof rawStatus !== "object") {
    return { label: String(rawStatus), activeFlags: [] };
  }

  const type = typeof rawStatus.type === "string" ? rawStatus.type : undefined;
  const activeFlags = Object.entries(rawStatus)
    .filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && entry[1] === true)
    .map(([key]) => key)
    .filter((key) => key !== "type");

  const label = [type, ...activeFlags].filter(Boolean).join(" ") || JSON.stringify(rawStatus);
  return { label, type, activeFlags };
}

function deriveState(
  appServerThreadStatusType: string | undefined,
  activeFlags: string[],
  lastTurnStatus: string | undefined,
  updatedAt: Date | undefined,
): ThreadWatchState {
  if (activeFlags.includes("waitingOnUserInput")) {
    return "waiting_for_input";
  }

  if (lastTurnStatus === "inProgress" || lastTurnStatus === "running" || appServerThreadStatusType === "active") {
    return "running";
  }

  if (lastTurnStatus === "failed" || lastTurnStatus === "cancelled" || lastTurnStatus === "canceled") {
    return "failed";
  }

  if (appServerThreadStatusType === "idle" || lastTurnStatus === "completed") {
    if (appServerThreadStatusType === "notLoaded" && isRecentlyUpdated(updatedAt)) {
      return "observed_running";
    }
    return "idle";
  }

  if (
    appServerThreadStatusType === "notLoaded" &&
    (lastTurnStatus === "interrupted" || lastTurnStatus === undefined) &&
    isRecentlyUpdated(updatedAt)
  ) {
    return "observed_running";
  }

  return "unknown";
}

function shouldNotifyTransition(previous: ThreadWatchState, current: ThreadWatchState): boolean {
  if (current === "idle" && previous !== "idle") {
    return true;
  }

  if (current === "failed" && previous !== "failed") {
    return true;
  }

  if (current === "waiting_for_input" && previous !== "waiting_for_input") {
    return true;
  }

  return false;
}

function isActiveWatchState(state: ThreadWatchState): boolean {
  return state === "running" || state === "observed_running" || state === "waiting_for_input";
}

function isRecentlyUpdated(updatedAt: Date | undefined): boolean {
  return updatedAt !== undefined && Date.now() - updatedAt.getTime() <= RECENT_DATABASE_ACTIVITY_MS;
}

function findLatestAssistantMessage(turns: any[]): string | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
    }
  }

  return undefined;
}

function dateFromUnixSeconds(value: unknown): Date | undefined {
  return typeof value === "number" ? new Date(value * 1000) : undefined;
}

function watchKey(contextKey: TelegramContextKey, threadId: string): string {
  return `${contextKey}\0${threadId}`;
}
