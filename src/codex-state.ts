import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  source?: string | null;
  isSubAgent?: boolean;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  source: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, source, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];
}

export function getThread(id: string): CodexThreadRecord | null {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, source, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as ThreadRow | undefined;
      return row ? mapThreadRow(row) : null;
    }) ?? null
  );
}

export function listWorkspaces(): string[] {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

      const rows = query.all() as WorkspaceRow[];
      const workspaces = rows
        .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
        .map(normalizeCodexPath)
        .filter(Boolean);

      return uniqueWorkspacePaths(workspaces);
    }) ?? []
  );
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  const source = typeof row.source === "string" ? row.source : null;
  const parsedSource = parseThreadSource(source);
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? normalizeCodexPath(row.cwd) : "",
    model: typeof row.model === "string" ? row.model : null,
    source,
    isSubAgent: parsedSource.isSubAgent,
    parentThreadId: parsedSource.parentThreadId,
    agentNickname: parsedSource.agentNickname,
    agentRole: parsedSource.agentRole,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
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

function getCodexDir(): string | null {
  const explicitCodexHome = process.env.CODEX_HOME?.trim();
  if (explicitCodexHome) {
    return explicitCodexHome;
  }

  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return home ? path.join(home, ".codex") : null;
}

export function normalizeCodexPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }

  if (value.startsWith("\\\\?\\")) {
    return value.slice("\\\\?\\".length);
  }

  return value;
}

function uniqueWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const workspace of paths) {
    const key = normalizeWorkspaceKey(workspace);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(workspace);
  }

  return unique;
}

function normalizeWorkspaceKey(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function parseThreadSource(source: string | null): {
  isSubAgent: boolean;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
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
      agentRole:
        typeof threadSpawn.agent_role === "string"
          ? threadSpawn.agent_role
          : typeof threadSpawn.agentRole === "string"
            ? threadSpawn.agentRole
            : undefined,
    };
  } catch {
    return { isSubAgent: true };
  }
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}
