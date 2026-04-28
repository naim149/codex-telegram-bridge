import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type CodexSessionBackend = "sdk" | "app-server";

export interface TeleCodexConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  telegramAllowedChatIds: number[];
  telegramAllowedChatIdSet: Set<number>;
  workspace: string;
  allowedProjectRoots: string[];
  monitoredProjectRoots: string[];
  codexBin?: string;
  codexSessionBackend: CodexSessionBackend;
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  showTurnTokenUsage: boolean;
  showAssistantOutputInTelegram: boolean;
  showErrorDetailsInTelegram: boolean;
  enableGroupChats: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  enableVoiceInput: boolean;
  enableFileUploads: boolean;
  autoSendArtifacts: boolean;
}

export function loadConfig(): TeleCodexConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const telegramAllowedChatIds = parseOptionalNumericIds(
    optionalString(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    "TELEGRAM_ALLOWED_CHAT_IDS",
    { allowNegative: true },
  );
  const defaultWorkspace = resolveDefaultWorkspace();
  const allowedProjectRoots = parseAllowedProjectRoots(
    optionalString(process.env.ALLOWED_PROJECT_ROOTS),
    defaultWorkspace,
  );
  const monitoredProjectRoots = parseProjectRoots(
    optionalString(process.env.MONITORED_PROJECT_ROOTS),
    allowedProjectRoots,
    "MONITORED_PROJECT_ROOTS",
  );
  const workspace = resolveWorkspace(defaultWorkspace, allowedProjectRoots);
  const codexBin = optionalString(process.env.CODEX_BIN);
  const codexSessionBackend = parseCodexSessionBackend(optionalString(process.env.CODEX_SESSION_BACKEND));
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const showAssistantOutputInTelegram = parseBooleanEnv(
    optionalString(process.env.SHOW_ASSISTANT_OUTPUT_IN_TELEGRAM),
    false,
  );
  const showErrorDetailsInTelegram = parseBooleanEnv(
    optionalString(process.env.SHOW_ERROR_DETAILS_IN_TELEGRAM),
    false,
  );
  const enableGroupChats = parseBooleanEnv(optionalString(process.env.ENABLE_GROUP_CHATS), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), false);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const enableVoiceInput = parseBooleanEnv(optionalString(process.env.ENABLE_VOICE_INPUT), false);
  const enableFileUploads = parseBooleanEnv(optionalString(process.env.ENABLE_FILE_UPLOADS), false);
  const autoSendArtifacts = parseBooleanEnv(optionalString(process.env.AUTO_SEND_ARTIFACTS), false);

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    telegramAllowedChatIds,
    telegramAllowedChatIdSet: new Set(telegramAllowedChatIds),
    workspace,
    allowedProjectRoots,
    monitoredProjectRoots,
    codexBin,
    codexSessionBackend,
    maxFileSize,
    codexApiKey,
    codexModel,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    showTurnTokenUsage,
    showAssistantOutputInTelegram,
    showErrorDetailsInTelegram,
    enableGroupChats,
    enableTelegramLogin,
    enableTelegramReactions,
    enableVoiceInput,
    enableFileUploads,
    autoSendArtifacts,
  };
}

/**
 * Workspace is derived from:
 * - CODEX_WORKSPACE when set
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveDefaultWorkspace(): string {
  const explicitWorkspace = optionalString(process.env.CODEX_WORKSPACE);
  if (explicitWorkspace) {
    return explicitWorkspace;
  }

  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function resolveWorkspace(defaultWorkspace: string, allowedProjectRoots: string[]): string {
  const workspace = canonicalizePath(defaultWorkspace);
  if (!isWorkspaceAllowed(workspace, allowedProjectRoots)) {
    throw new Error("CODEX_WORKSPACE must be inside ALLOWED_PROJECT_ROOTS.");
  }
  return workspace;
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    let wasQuoted = false;

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      wasQuoted = true;
      value = value.slice(1, -1);
    }

    process.env[key] = wasQuoted ? value.replace(/\\n/g, "\n") : value;
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = parseOptionalNumericIds(raw, "TELEGRAM_ALLOWED_USER_IDS", { allowNegative: false });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseOptionalNumericIds(
  raw: string | undefined,
  envName: string,
  options: { allowNegative: boolean },
): number[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      const validRange = options.allowNegative ? parsed !== 0 : parsed > 0;
      if (!Number.isInteger(parsed) || !validRange) {
        throw new Error(`Invalid Telegram id in ${envName}: ${value}`);
      }
      return parsed;
    });
}

function parseAllowedProjectRoots(raw: string | undefined, fallbackWorkspace: string): string[] {
  return parseProjectRoots(raw, [fallbackWorkspace], "ALLOWED_PROJECT_ROOTS");
}

function parseProjectRoots(raw: string | undefined, fallbackRoots: string[], envName: string): string[] {
  const roots = (raw ? raw.split(",") : fallbackRoots)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(canonicalizePath);

  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length === 0) {
    throw new Error(`${envName} must contain at least one absolute path`);
  }

  return uniqueRoots;
}

export function isWorkspaceAllowed(candidatePath: string, allowedRoots: string[]): boolean {
  const candidate = normalizePathForCompare(canonicalizePath(candidatePath));

  return allowedRoots.some((root) => {
    const normalizedRoot = normalizePathForCompare(canonicalizePath(root));
    return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function canonicalizePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);

  if (existsSync(resolved)) {
    try {
      return normalizeWindowsExtendedPath(path.normalize(realpathSync.native(resolved)));
    } catch {
      return normalizeWindowsExtendedPath(path.normalize(resolved));
    }
  }

  return normalizeWindowsExtendedPath(path.normalize(resolved));
}

function normalizeWindowsExtendedPath(inputPath: string): string {
  if (process.platform !== "win32") {
    return inputPath;
  }

  if (inputPath.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${inputPath.slice("\\\\?\\UNC\\".length)}`;
  }

  if (inputPath.startsWith("\\\\?\\")) {
    return inputPath.slice("\\\\?\\".length);
  }

  return inputPath;
}

function normalizePathForCompare(inputPath: string): string {
  let normalized = path.normalize(inputPath);
  const parsed = path.parse(normalized);
  while (normalized.length > parsed.root.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseCodexSessionBackend(raw: string | undefined): CodexSessionBackend {
  if (!raw) {
    return "sdk";
  }

  const normalized = raw.toLowerCase();
  if (normalized === "sdk" || normalized === "app-server") {
    return normalized;
  }

  console.warn(`Invalid CODEX_SESSION_BACKEND value: "${raw}". Falling back to "sdk".`);
  return "sdk";
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "on-request";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "on-request".`,
    );
    return "on-request";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
