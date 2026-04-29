import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { findLatestDatabase, normalizeCodexPath } from "./codex-state.js";

export const STANDARD_API_PRICING_AS_OF = "2026-04-27";
export const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

type ThreadRow = {
  id: unknown;
  cwd: unknown;
  model: unknown;
  source: unknown;
};

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;

type RolloutTokenUsage = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
};

type RolloutRateLimitWindow = {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
};

type RolloutRateLimits = {
  limit_id?: unknown;
  plan_type?: unknown;
  primary?: RolloutRateLimitWindow;
  secondary?: RolloutRateLimitWindow;
  rate_limit_reached_type?: unknown;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

const STANDARD_MODEL_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.1-codex-max": { input: 1.75, cachedInput: 0.175, output: 14 },
};

export interface TokenTotals {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ActivityTotals {
  estimatedActiveMs: number;
  observedSpanMs: number;
  firstEventAt?: Date;
  lastEventAt?: Date;
  eventCount: number;
}

export interface WorkspaceActivitySummary extends ActivityTotals {
  mainThreadActiveMs: number;
  subAgentActiveMs: number;
}

export interface ThreadUsageSummary {
  threadId: string;
  workspace: string;
  model: string | null;
  isSubAgent: boolean;
  parentThreadId?: string;
  agentNickname?: string;
  planType?: string;
  totals: TokenTotals;
  activity: ActivityTotals;
  estimatedCostUsd?: number;
}

export interface ModelUsageSummary {
  model: string;
  threadCount: number;
  totals: TokenTotals;
  estimatedCostUsd?: number;
}

export interface WorkspaceUsageSummary {
  workspace: string;
  threadCount: number;
  summarizedThreadCount: number;
  mainThreadCount: number;
  subAgentThreadCount: number;
  totals: TokenTotals;
  activity: WorkspaceActivitySummary;
  estimatedCostUsd?: number;
  observedPlanTypes: string[];
  unsupportedModels: string[];
  byModel: ModelUsageSummary[];
  threads: ThreadUsageSummary[];
}

export interface RateLimitWindowSummary {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt?: Date;
}

export interface RateLimitSummary {
  observedAt: Date;
  limitId?: string;
  planType?: string;
  primary?: RateLimitWindowSummary;
  secondary?: RateLimitWindowSummary;
  rateLimitReachedType?: string;
}

export function summarizeWorkspaceUsage(workspace: string): WorkspaceUsageSummary | null {
  const normalizedWorkspace = normalizeCodexPath(workspace);
  const workspaceKey = normalizeWorkspaceKey(normalizedWorkspace);
  const threadRows = readAllThreads().filter(
    (thread) => normalizeWorkspaceKey(thread.workspace) === workspaceKey,
  );

  if (threadRows.length === 0) {
    return null;
  }

  const rolloutIndex = buildRolloutIndex();
  const threadSummaries: ThreadUsageSummary[] = [];
  const observedPlanTypes = new Set<string>();

  for (const thread of threadRows) {
    const rolloutPath = rolloutIndex.get(thread.id.toLowerCase());
    if (!rolloutPath) {
      continue;
    }

    const rolloutSummary = parseRolloutUsage(rolloutPath);
    if (!rolloutSummary) {
      continue;
    }

    if (rolloutSummary.planType) {
      observedPlanTypes.add(rolloutSummary.planType);
    }

    threadSummaries.push({
      threadId: thread.id,
      workspace: thread.workspace,
      model: thread.model,
      isSubAgent: thread.isSubAgent,
      parentThreadId: thread.parentThreadId,
      agentNickname: thread.agentNickname,
      planType: rolloutSummary.planType,
      totals: rolloutSummary.totals,
      activity: rolloutSummary.activity,
      estimatedCostUsd: estimateStandardApiCost(thread.model, rolloutSummary.totals),
    });
  }

  if (threadSummaries.length === 0) {
    return null;
  }

  const mainThreadCount = threadRows.filter((thread) => !thread.isSubAgent).length;
  const subAgentThreadCount = threadRows.length - mainThreadCount;
  const byModelMap = new Map<string, ModelUsageSummary>();
  const unsupportedModels = new Set<string>();

  for (const thread of threadSummaries) {
    const modelKey = thread.model ?? "(unknown)";
    const existing = byModelMap.get(modelKey);
    if (existing) {
      existing.threadCount += 1;
      addTotals(existing.totals, thread.totals);
      existing.estimatedCostUsd =
        (existing.estimatedCostUsd ?? 0) + (thread.estimatedCostUsd ?? 0);
    } else {
      byModelMap.set(modelKey, {
        model: modelKey,
        threadCount: 1,
        totals: cloneTotals(thread.totals),
        estimatedCostUsd: thread.estimatedCostUsd,
      });
    }

    if (thread.model && thread.estimatedCostUsd === undefined) {
      unsupportedModels.add(thread.model);
    }
  }

  const totals = sumTotals(threadSummaries.map((thread) => thread.totals));
  const estimatedCostUsd = threadSummaries.reduce(
    (sum, thread) => sum + (thread.estimatedCostUsd ?? 0),
    0,
  );

  return {
    workspace: normalizedWorkspace,
    threadCount: threadRows.length,
    summarizedThreadCount: threadSummaries.length,
    mainThreadCount,
    subAgentThreadCount,
    totals,
    activity: summarizeWorkspaceActivity(threadSummaries),
    estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : undefined,
    observedPlanTypes: [...observedPlanTypes].sort(),
    unsupportedModels: [...unsupportedModels].sort(),
    byModel: [...byModelMap.values()].sort((left, right) => right.totals.totalTokens - left.totals.totalTokens),
    threads: threadSummaries.sort((left, right) => right.totals.totalTokens - left.totals.totalTokens),
  };
}

export function getLatestRateLimitSummary(): RateLimitSummary | null {
  const rolloutIndex = buildRolloutIndex();
  let latest: RateLimitSummary | null = null;

  for (const rolloutPath of rolloutIndex.values()) {
    const summary = parseRolloutRateLimits(rolloutPath);
    if (!summary) {
      continue;
    }

    if (!latest || summary.observedAt.getTime() > latest.observedAt.getTime()) {
      latest = summary;
    }
  }

  return latest;
}

type ThreadMetadata = {
  id: string;
  workspace: string;
  model: string | null;
  isSubAgent: boolean;
  parentThreadId?: string;
  agentNickname?: string;
};

type RolloutSummary = {
  totals: TokenTotals;
  activity: ActivityTotals;
  planType?: string;
};

function readAllThreads(): ThreadMetadata[] {
  return (
    withDatabase((db) => {
      const rows = db
        .prepare(
          `
            SELECT id, cwd, model, source
            FROM threads
            WHERE (archived = 0 OR archived IS NULL)
          `,
        )
        .all() as ThreadRow[];

      return rows.map(mapThreadRow);
    }) ?? []
  );
}

function mapThreadRow(row: ThreadRow): ThreadMetadata {
  const source = typeof row.source === "string" ? row.source : null;
  const parsedSource = parseThreadSource(source);
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    workspace: typeof row.cwd === "string" ? normalizeCodexPath(row.cwd) : "",
    model: typeof row.model === "string" ? row.model : null,
    isSubAgent: parsedSource.isSubAgent,
    parentThreadId: parsedSource.parentThreadId,
    agentNickname: parsedSource.agentNickname,
  };
}

function buildRolloutIndex(): Map<string, string> {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir || !existsSync(sessionsDir)) {
    return new Map();
  }

  const filesByThread = new Map<string, string>();
  const pending = [sessionsDir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(current, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
      if (!match) {
        continue;
      }

      filesByThread.set(match[1].toLowerCase(), fullPath);
    }
  }

  return filesByThread;
}

function parseRolloutRateLimits(filePath: string): RateLimitSummary | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let latest: RateLimitSummary | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let item: any;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item?.type !== "event_msg" || item?.payload?.type !== "token_count") {
      continue;
    }

    const observedAt = parseEventTimestamp(item?.timestamp);
    const rateLimits = item.payload?.rate_limits as RolloutRateLimits | undefined;
    if (!observedAt || !rateLimits) {
      continue;
    }

    const summary: RateLimitSummary = {
      observedAt,
      limitId: stringValue(rateLimits.limit_id),
      planType: stringValue(rateLimits.plan_type),
      primary: parseRateLimitWindow(rateLimits.primary),
      secondary: parseRateLimitWindow(rateLimits.secondary),
      rateLimitReachedType: stringValue(rateLimits.rate_limit_reached_type),
    };

    if (summary.primary || summary.secondary) {
      latest = summary;
    }
  }

  return latest;
}

function parseRolloutUsage(filePath: string): RolloutSummary | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let lastUsage: TokenTotals | null = null;
  let planType: string | undefined;
  let firstEventAt: Date | undefined;
  let lastEventAt: Date | undefined;
  let previousEventAt: Date | undefined;
  let estimatedActiveMs = 0;
  let eventCount = 0;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let item: any;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    const eventAt = parseEventTimestamp(item?.timestamp);
    if (eventAt) {
      eventCount += 1;
      if (!firstEventAt) {
        firstEventAt = eventAt;
      }
      if (previousEventAt) {
        estimatedActiveMs += Math.min(
          Math.max(0, eventAt.getTime() - previousEventAt.getTime()),
          ACTIVE_GAP_CAP_MS,
        );
      }
      previousEventAt = eventAt;
      lastEventAt = eventAt;
    }

    if (item?.type !== "event_msg" || item?.payload?.type !== "token_count") {
      continue;
    }

    const usage = item.payload?.info?.total_token_usage as RolloutTokenUsage | undefined;
    if (usage) {
      lastUsage = {
        totalTokens: numberValue(usage.total_tokens),
        inputTokens: numberValue(usage.input_tokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens),
        outputTokens: numberValue(usage.output_tokens),
        reasoningOutputTokens: numberValue(usage.reasoning_output_tokens),
      };
    }

    if (typeof item.payload?.rate_limits?.plan_type === "string") {
      planType = item.payload.rate_limits.plan_type;
    }
  }

  if (!lastUsage) {
    return null;
  }

  return {
    totals: lastUsage,
    activity: {
      estimatedActiveMs,
      observedSpanMs:
        firstEventAt && lastEventAt ? Math.max(0, lastEventAt.getTime() - firstEventAt.getTime()) : 0,
      firstEventAt,
      lastEventAt,
      eventCount,
    },
    planType,
  };
}

function estimateStandardApiCost(model: string | null, totals: TokenTotals): number | undefined {
  if (!model) {
    return undefined;
  }

  const pricing = STANDARD_MODEL_PRICING[model];
  if (!pricing) {
    return undefined;
  }

  const uncachedInputTokens = Math.max(0, totals.inputTokens - totals.cachedInputTokens);
  return (
    (uncachedInputTokens / 1_000_000) * pricing.input +
    (totals.cachedInputTokens / 1_000_000) * pricing.cachedInput +
    (totals.outputTokens / 1_000_000) * pricing.output
  );
}

function sumTotals(values: TokenTotals[]): TokenTotals {
  const totals = emptyTotals();
  for (const value of values) {
    addTotals(totals, value);
  }
  return totals;
}

function emptyTotals(): TokenTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function cloneTotals(value: TokenTotals): TokenTotals {
  return {
    totalTokens: value.totalTokens,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens,
  };
}

function addTotals(target: TokenTotals, source: TokenTotals): void {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRateLimitWindow(value: RolloutRateLimitWindow | undefined): RateLimitWindowSummary | undefined {
  const usedPercent = optionalNumberValue(value?.used_percent);
  const windowMinutes = optionalNumberValue(value?.window_minutes);
  if (usedPercent === undefined || windowMinutes === undefined) {
    return undefined;
  }

  const resetSeconds = optionalNumberValue(value?.resets_at);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000),
  };
}

function parseEventTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): T | null {
  if (!BetterSqlite3) {
    return null;
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getSessionsDir(): string | null {
  const explicitCodexHome = process.env.CODEX_HOME?.trim();
  if (explicitCodexHome) {
    return path.join(explicitCodexHome, "sessions");
  }

  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return home ? path.join(home, ".codex", "sessions") : null;
}

function normalizeWorkspaceKey(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function summarizeWorkspaceActivity(threads: ThreadUsageSummary[]): WorkspaceActivitySummary {
  let earliest: Date | undefined;
  let latest: Date | undefined;
  let eventCount = 0;
  let estimatedActiveMs = 0;
  let mainThreadActiveMs = 0;
  let subAgentActiveMs = 0;

  for (const thread of threads) {
    estimatedActiveMs += thread.activity.estimatedActiveMs;
    eventCount += thread.activity.eventCount;
    if (thread.isSubAgent) {
      subAgentActiveMs += thread.activity.estimatedActiveMs;
    } else {
      mainThreadActiveMs += thread.activity.estimatedActiveMs;
    }

    const first = thread.activity.firstEventAt;
    const last = thread.activity.lastEventAt;
    if (first && (!earliest || first.getTime() < earliest.getTime())) {
      earliest = first;
    }
    if (last && (!latest || last.getTime() > latest.getTime())) {
      latest = last;
    }
  }

  return {
    estimatedActiveMs,
    observedSpanMs: earliest && latest ? Math.max(0, latest.getTime() - earliest.getTime()) : 0,
    firstEventAt: earliest,
    lastEventAt: latest,
    eventCount,
    mainThreadActiveMs,
    subAgentActiveMs,
  };
}

function parseThreadSource(source: string | null): {
  isSubAgent: boolean;
  parentThreadId?: string;
  agentNickname?: string;
} {
  if (!source) {
    return { isSubAgent: false };
  }

  if (!source.includes("subagent") && !source.includes("subAgent") && !source.includes("thread_spawn")) {
    return { isSubAgent: false };
  }

  try {
    const parsed = JSON.parse(source) as any;
    const subAgent = parsed?.subagent ?? parsed?.subAgent;
    const threadSpawn = subAgent?.thread_spawn ?? subAgent?.threadSpawn;
    if (!threadSpawn || typeof threadSpawn !== "object") {
      return { isSubAgent: Boolean(subAgent) };
    }

    return {
      isSubAgent: true,
      parentThreadId:
        typeof threadSpawn.parent_thread_id === "string"
          ? threadSpawn.parent_thread_id
          : typeof threadSpawn.parentThreadId === "string"
            ? threadSpawn.parentThreadId
            : undefined,
      agentNickname:
        typeof threadSpawn.agent_nickname === "string"
          ? threadSpawn.agent_nickname
          : typeof threadSpawn.agentNickname === "string"
            ? threadSpawn.agentNickname
            : undefined,
    };
  } catch {
    return { isSubAgent: true };
  }
}
