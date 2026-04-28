import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getThread } from "./codex-state.js";
import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { formatLogError } from "./log-redaction.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  updatedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.loadPersistedMetadata();
    this.sanitizePersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const createOptions = {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
    };

    try {
      session = await CodexSessionService.create(this.config, createOptions);
    } catch (error) {
      if (!meta?.threadId || !shouldResetPersistedThread(error)) {
        throw error;
      }

      console.warn(
        `Failed to resume persisted thread for Telegram context: ${formatLogError(error)}. Resetting saved thread and continuing.`,
      );

      this.metadata.set(contextKey, {
        ...meta,
        threadId: null,
        updatedAt: Date.now(),
      });
      this.persistMetadata();

      session = await CodexSessionService.create(this.config, {
        workspace: meta.workspace,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
        launchProfileId,
        deferThreadStart: options?.deferThreadStart,
      });
    }

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }

  private sanitizePersistedMetadata(): void {
    let changed = false;

    for (const [contextKey, entry] of this.metadata.entries()) {
      if (!entry.threadId) {
        continue;
      }

      if (getThread(entry.threadId)) {
        continue;
      }

      console.warn("Persisted thread no longer exists in local Codex state. Resetting saved thread id.");
      this.metadata.set(contextKey, {
        ...entry,
        threadId: null,
        updatedAt: Date.now(),
      });
      changed = true;
    }

    if (changed) {
      this.persistMetadata();
    }
  }
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn("Unknown persisted launch profile for Telegram context. Falling back to default launch profile.");
  return undefined;
}

function shouldResetPersistedThread(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("unknown codex thread") ||
    (message.includes("thread") && message.includes("not found"))
  );
}
