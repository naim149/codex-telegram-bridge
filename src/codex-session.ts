import path from "node:path";

import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";

import { CodexAppServerClient, type AppServerNotification, type AppServerRequest } from "./codex-app-server.js";
import { buildCodexChildEnv } from "./codex-env.js";
import type { TeleCodexConfig } from "./config.js";
import {
  getThread,
  listModels,
  listThreads,
  listWorkspaces,
  normalizeCodexPath,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";
import { isWorkspaceAllowed } from "./config.js";

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
  onUserInputRequest?: (request: PendingUserInputRequest) => void;
}

export interface PendingUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }> | null;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface PendingUserInputRequest {
  threadId: string;
  turnId: string;
  questions: PendingUserInputQuestion[];
}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: {
    input: number;
    cached: number;
    output: number;
  };
}

export type CodexSessionRuntimeState =
  | "not_started"
  | "idle"
  | "running"
  | "waiting_for_input"
  | "unknown";

export interface CodexSessionStatusSnapshot {
  info: CodexSessionInfo;
  state: CodexSessionRuntimeState;
  appServerThreadStatus?: string;
  appServerActiveFlags?: string[];
  lastTurnId?: string;
  lastTurnStatus?: string;
  lastTurnError?: string;
  lastUpdatedAt?: Date;
  latestAssistantMessage?: string;
  pendingUserInput?: PendingUserInputRequest | null;
  readWarning?: string;
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput = string | { text?: string; imagePaths?: string[]; stagedFileInstructions?: string };

export class CodexSessionService {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private appServer: CodexAppServerClient | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private appServerActiveTurnId: string | null = null;
  private pendingUserInput:
    | (PendingUserInputRequest & { requestId: number | string })
    | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: ModelReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(private readonly config: TeleCodexConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodexConfig, options?: CreateOptions): Promise<CodexSessionService> {
    const service = new CodexSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.codexModel;
    service.currentReasoningEffort = options?.reasoningEffort as ModelReasoningEffort | undefined;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );
    service.resetCodexClient();

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (this.currentReasoningEffort) {
      info.reasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null || this.appServerActiveTurnId !== null;
  }

  hasActiveThread(): boolean {
    return this.thread !== null || this.currentThreadId !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  hasPendingUserInput(): boolean {
    return this.pendingUserInput !== null;
  }

  getPendingUserInput(): PendingUserInputRequest | null {
    if (!this.pendingUserInput) {
      return null;
    }

    const { requestId: _requestId, ...request } = this.pendingUserInput;
    return request;
  }

  async getStatusSnapshot(): Promise<CodexSessionStatusSnapshot> {
    const info = this.getInfo();
    const snapshot: CodexSessionStatusSnapshot = {
      info,
      state: this.getLocalRuntimeState(info),
      pendingUserInput: this.getPendingUserInput(),
    };

    if (!info.threadId || this.config.codexSessionBackend !== "app-server") {
      return snapshot;
    }

    try {
      const result = await this.getAppServer().request("thread/read", {
        threadId: info.threadId,
        includeTurns: true,
      });
      const thread = result?.thread;
      if (!thread || typeof thread !== "object") {
        snapshot.readWarning = "Codex did not return thread details.";
        return snapshot;
      }

      if (typeof thread.cwd === "string") {
        const workspace = normalizeCodexPath(thread.cwd);
        this.ensureAllowedWorkspace(workspace);
        snapshot.info = { ...snapshot.info, workspace };
      }

      const threadStatus = normalizeThreadStatus(thread.status);
      if (threadStatus) {
        snapshot.appServerThreadStatus = threadStatus.label;
        snapshot.appServerActiveFlags = threadStatus.activeFlags;
      }

      const updatedAt = dateFromUnixSeconds(thread.updatedAt);
      if (updatedAt) {
        snapshot.lastUpdatedAt = updatedAt;
      }

      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const lastTurn = turns.at(-1);
      if (lastTurn && typeof lastTurn === "object") {
        if (typeof lastTurn.id === "string") {
          snapshot.lastTurnId = lastTurn.id;
        }
        if (typeof lastTurn.status === "string") {
          snapshot.lastTurnStatus = lastTurn.status;
        }
        if (typeof lastTurn.error?.message === "string") {
          snapshot.lastTurnError = lastTurn.error.message;
        }
      }

      snapshot.latestAssistantMessage = findLatestAssistantMessage(turns);
      snapshot.state = deriveRuntimeState(snapshot, threadStatus?.type);
    } catch (error) {
      snapshot.readWarning = error instanceof Error ? error.message : String(error);
    }

    return snapshot;
  }

  async answerPendingUserInput(answerText: string): Promise<void> {
    if (!this.pendingUserInput) {
      throw new Error("No pending Codex question to answer");
    }

    const pending = this.pendingUserInput;
    const answers = buildUserInputAnswers(pending.questions, answerText);
    this.pendingUserInput = null;
    this.getAppServer().respond(pending.requestId, { answers });
  }

  async steerActiveTurn(input: CodexPromptInput): Promise<void> {
    if (!this.appServerActiveTurnId || !this.currentThreadId) {
      throw new Error("No active app-server turn to steer");
    }

    await this.getAppServer().request("turn/steer", {
      threadId: this.currentThreadId,
      expectedTurnId: this.appServerActiveTurnId,
      input: this.buildAppServerInput(input),
    });
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (this.config.codexSessionBackend === "app-server") {
      await this.promptViaAppServer(input, callbacks);
      return;
    }

    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let lastAgentText = "";

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of events) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                lastAgentText = item.text;
                callbacks.onTextDelta(delta);
              } else {
                lastAgentText = item.text;
              }
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                callbacks.onTextDelta(delta);
              }
              lastAgentText = item.text;
            } else if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "turn.completed": {
            // Accumulate and deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            this.sessionTokens.input += u.input_tokens;
            this.sessionTokens.cached += u.cached_input_tokens;
            this.sessionTokens.output += u.output_tokens;
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  async abort(): Promise<void> {
    if (this.config.codexSessionBackend === "app-server" && this.currentThreadId && this.appServerActiveTurnId) {
      await this.getAppServer().request("turn/interrupt", {
        threadId: this.currentThreadId,
        turnId: this.appServerActiveTurnId,
      });
      return;
    }

    this.abortController?.abort();
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    this.ensureAllowedWorkspace(effectiveWorkspace);

    if (this.config.codexSessionBackend === "app-server") {
      const result = await this.getAppServer().request("thread/start", {
        ...this.buildAppServerThreadParams(effectiveWorkspace, effectiveModel),
        serviceName: "codex_telegram_bridge",
        sessionStartSource: "clear",
      });
      this.thread = null;
      this.currentThreadId = getResultThreadId(result);
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = effectiveWorkspace;
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");
    this.ensureAllowedWorkspace(this.currentWorkspace);

    if (this.config.codexSessionBackend === "app-server") {
      const result = await this.getAppServer().request("thread/resume", {
        ...this.buildAppServerThreadParams(this.currentWorkspace, this.currentModel),
        threadId,
      });
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentThreadId = getResultThreadId(result) ?? threadId;
      return this.getInfo();
    }

    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(this.currentWorkspace, this.currentModel),
    );
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    if (!record) {
      throw new Error(`Unknown Codex thread: ${threadId}`);
    }

    const workspace = record.cwd;
    this.ensureAllowedWorkspace(workspace);
    const model = record?.model || undefined;

    if (this.config.codexSessionBackend === "app-server") {
      const result = await this.getAppServer().request("thread/resume", {
        ...this.buildAppServerThreadParams(workspace, model),
        threadId,
      });
      this.thread = null;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;
      this.currentWorkspace = workspace;
      this.currentThreadId = getResultThreadId(result) ?? threadId;
      if (model) {
        this.currentModel = model;
      }
      return this.getInfo();
    }

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  listAllSessions(limit?: number, options?: { includeSubAgents?: boolean; onlySubAgents?: boolean }): CodexThreadRecord[] {
    const requestedLimit = limit ?? 20;
    return listThreads(Math.max(requestedLimit * 10, 100))
      .filter((thread) => isWorkspaceAllowed(thread.cwd, this.getAllowedProjectRoots()))
      .filter((thread) => {
        if (options?.onlySubAgents) {
          return Boolean(thread.isSubAgent);
        }
        return options?.includeSubAgents ? true : !thread.isSubAgent;
      })
      .slice(0, requestedLimit);
  }

  listWorkspaces(): string[] {
    const workspaces = [this.config.workspace, ...listWorkspaces()];
    const seen = new Set<string>();
    const uniqueWorkspaces: string[] = [];

    for (const workspace of workspaces) {
      const key = normalizeWorkspaceKey(workspace);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      uniqueWorkspaces.push(workspace);
    }

    return uniqueWorkspaces.filter((workspace) => isWorkspaceAllowed(workspace, this.getAllowedProjectRoots()));
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setReasoningEffort(effort: ModelReasoningEffort): void {
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.appServerActiveTurnId = null;
    this.pendingUserInput = null;
    this.appServer?.dispose();
    this.appServer = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
  }

  private async promptViaAppServer(
    input: CodexPromptInput,
    callbacks: CodexSessionCallbacks,
  ): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.appServerActiveTurnId) {
      throw new Error("A Codex turn is already in progress");
    }

    const client = this.getAppServer();
    const threadId = this.currentThreadId;
    const lastCommandOutput = new Map<string, string>();
    let lastAgentText = "";
    let lastUsage:
      | { inputTokens: number; cachedInputTokens: number; outputTokens: number }
      | undefined;
    let cleanupTurnListeners = (): void => {};

    const turnPromise = new Promise<void>((resolve, reject) => {
      const cleanupNotification = client.onNotification((message) => {
        if (!message.params || message.params.threadId !== threadId) {
          return;
        }

        const turnId = getMessageTurnId(message);
        if (turnId && this.appServerActiveTurnId && turnId !== this.appServerActiveTurnId) {
          return;
        }

        try {
          switch (message.method) {
            case "turn/started": {
              const startedTurnId = message.params.turn?.id;
              if (typeof startedTurnId === "string") {
                this.appServerActiveTurnId = startedTurnId;
              }
              break;
            }
            case "item/agentMessage/delta": {
              const delta = typeof message.params.delta === "string" ? message.params.delta : "";
              if (delta) {
                lastAgentText += delta;
                callbacks.onTextDelta(delta);
              }
              break;
            }
            case "item/started": {
              this.handleAppServerItemStarted(message.params.item, callbacks, lastCommandOutput);
              break;
            }
            case "item/commandExecution/outputDelta": {
              const itemId = message.params.itemId;
              const delta = typeof message.params.delta === "string" ? message.params.delta : "";
              if (typeof itemId === "string" && delta) {
                lastCommandOutput.set(itemId, `${lastCommandOutput.get(itemId) ?? ""}${delta}`);
                callbacks.onToolUpdate(itemId, delta);
              }
              break;
            }
            case "item/completed": {
              lastAgentText = this.handleAppServerItemCompleted(
                message.params.item,
                callbacks,
                lastCommandOutput,
                lastAgentText,
              );
              break;
            }
            case "thread/tokenUsage/updated": {
              const last = message.params.tokenUsage?.last;
              if (last) {
                lastUsage = {
                  inputTokens: Number(last.inputTokens ?? 0),
                  cachedInputTokens: Number(last.cachedInputTokens ?? 0),
                  outputTokens: Number(last.outputTokens ?? 0),
                };
              }
              break;
            }
            case "turn/completed": {
              cleanupTurnListeners();
              const turn = message.params.turn;
              const status = turn?.status;
              this.appServerActiveTurnId = null;
              this.pendingUserInput = null;

              if (lastUsage) {
                this.sessionTokens.input += lastUsage.inputTokens;
                this.sessionTokens.cached += lastUsage.cachedInputTokens;
                this.sessionTokens.output += lastUsage.outputTokens;
                callbacks.onTurnComplete?.(lastUsage);
              }

              if (status && status !== "completed") {
                reject(new Error(turn?.error?.message ?? `Codex turn ${status}`));
                return;
              }

              callbacks.onAgentEnd();
              resolve();
              break;
            }
            case "error": {
              cleanupTurnListeners();
              this.appServerActiveTurnId = null;
              this.pendingUserInput = null;
              reject(new Error(message.params?.message ?? "Codex app-server error"));
              break;
            }
            default:
              break;
          }
        } catch (error) {
          cleanupTurnListeners();
          this.appServerActiveTurnId = null;
          this.pendingUserInput = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      const cleanupServerRequest = client.onServerRequest((request) => {
        if (!request.params || request.params.threadId !== threadId) {
          return;
        }

        if (request.method === "item/tool/requestUserInput") {
          this.pendingUserInput = {
            requestId: request.id,
            threadId: request.params.threadId,
            turnId: request.params.turnId,
            questions: normalizeUserInputQuestions(request.params.questions),
          };
          callbacks.onUserInputRequest?.(this.getPendingUserInput()!);
          return;
        }

        if (request.method === "item/commandExecution/requestApproval") {
          client.respond(request.id, { decision: "decline" });
          return;
        }

        if (request.method === "item/fileChange/requestApproval") {
          client.respond(request.id, { decision: "decline" });
          return;
        }

        client.respondError(request.id, -32601, `Unsupported app-server request: ${request.method}`);
      });

      cleanupTurnListeners = (): void => {
        cleanupNotification();
        cleanupServerRequest();
      };
    });

    try {
      const result = await client.request("turn/start", {
        threadId,
        cwd: this.currentWorkspace,
        model: this.currentModel ?? this.config.codexModel,
        effort: this.currentReasoningEffort ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        input: this.buildAppServerInput(input),
      });
      const turnId = result?.turn?.id;
      if (typeof turnId === "string") {
        this.appServerActiveTurnId = turnId;
      }
      await turnPromise;
    } catch (error) {
      cleanupTurnListeners();
      this.appServerActiveTurnId = null;
      this.pendingUserInput = null;
      throw error;
    }
  }

  private handleAppServerItemStarted(
    item: any,
    callbacks: CodexSessionCallbacks,
    lastCommandOutput: Map<string, string>,
  ): void {
    if (!item || typeof item.id !== "string") {
      return;
    }

    if (item.type === "commandExecution") {
      lastCommandOutput.set(item.id, item.aggregatedOutput ?? "");
      callbacks.onToolStart(item.command ?? "command", item.id);
      return;
    }

    if (item.type === "webSearch") {
      const label = truncate(item.query ?? "web search", 60);
      callbacks.onToolStart(`ðŸ” ${label}`, item.id);
      callbacks.onToolUpdate(item.id, item.query ?? "");
      return;
    }

    if (item.type === "mcpToolCall") {
      callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
      return;
    }

    if (item.type === "dynamicToolCall") {
      callbacks.onToolStart(`tool:${item.tool}`, item.id);
    }
  }

  private handleAppServerItemCompleted(
    item: any,
    callbacks: CodexSessionCallbacks,
    lastCommandOutput: Map<string, string>,
    lastAgentText: string,
  ): string {
    if (!item || typeof item.id !== "string") {
      return lastAgentText;
    }

    if (item.type === "agentMessage") {
      const text = typeof item.text === "string" ? item.text : "";
      const delta = computeTextDelta(lastAgentText, text);
      if (delta) {
        callbacks.onTextDelta(delta);
      }
      return text || lastAgentText;
    }

    if (item.type === "commandExecution") {
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      const prev = lastCommandOutput.get(item.id) ?? "";
      const delta = computeTextDelta(prev, output);
      if (delta) {
        callbacks.onToolUpdate(item.id, delta);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
      return lastAgentText;
    }

    if (item.type === "fileChange") {
      const summary = (item.changes ?? []).map((change: any) => `${change.kind} ${change.path}`).join(", ");
      callbacks.onToolStart("file_change", item.id);
      callbacks.onToolUpdate(item.id, summary);
      callbacks.onToolEnd(item.id, item.status === "failed");
      return lastAgentText;
    }

    if (item.type === "mcpToolCall") {
      if (item.error?.message) {
        callbacks.onToolUpdate(item.id, item.error.message);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
      return lastAgentText;
    }

    if (item.type === "dynamicToolCall") {
      callbacks.onToolEnd(item.id, item.status === "failed");
      return lastAgentText;
    }

    if (item.type === "webSearch") {
      callbacks.onToolEnd(item.id, false);
    }

    return lastAgentText;
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    if (typeof input === "string") {
      return input;
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildAppServerInput(input: CodexPromptInput): Array<Record<string, unknown>> {
    if (typeof input === "string") {
      return [{ type: "text", text: input }];
    }

    const parts: Array<Record<string, unknown>> = [];
    const textParts: string[] = [];

    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "localImage", path: imagePath });
    }

    return parts.length > 0 ? parts : [{ type: "text", text: "" }];
  }

  private buildThreadOptions(workspace: string, model?: string): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
    modelReasoningEffort?: ModelReasoningEffort;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const options = {
      model: effectiveModel,
      sandboxMode: this.currentLaunchProfile.sandboxMode,
      workingDirectory: workspace,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      skipGitRepoCheck: true as const,
    };

    if (this.currentReasoningEffort) {
      return {
        ...options,
        modelReasoningEffort: this.currentReasoningEffort,
      };
    }

    return options;
  }

  private buildAppServerThreadParams(workspace: string, model?: string): Record<string, unknown> {
    return {
      cwd: workspace,
      model: model ?? this.currentModel ?? this.config.codexModel ?? null,
      sandbox: this.currentLaunchProfile.sandboxMode,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      config: {
        skip_git_repo_check: true,
      },
    };
  }

  private ensureIdle(action: string): void {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private ensureAllowedWorkspace(workspace: string): void {
    if (!isWorkspaceAllowed(workspace, this.getAllowedProjectRoots())) {
      throw new Error("Workspace is not allowed by the configured project roots.");
    }
  }

  private getAllowedProjectRoots(): string[] {
    return this.config.allowedProjectRoots ?? [this.config.workspace];
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
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

  private resetCodexClient(): void {
    this.appServer?.dispose();
    this.appServer = null;
    this.appServerActiveTurnId = null;
    this.pendingUserInput = null;
    this.codex = new Codex({
      codexPathOverride: this.config.codexBin,
      apiKey: this.config.codexApiKey,
      config: {
        approval_policy: this.currentLaunchProfile.approvalPolicy,
      },
      env: buildCodexChildEnv(this.config.codexApiKey),
    });
  }

  private getLocalRuntimeState(info: CodexSessionInfo): CodexSessionRuntimeState {
    if (!info.threadId) {
      return "not_started";
    }

    if (this.pendingUserInput) {
      return "waiting_for_input";
    }

    if (this.isProcessing()) {
      return "running";
    }

    return "idle";
  }
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function getResultThreadId(result: any): string | null {
  const id = result?.thread?.id;
  return typeof id === "string" ? id : null;
}

function getMessageTurnId(message: AppServerNotification): string | null {
  const direct = message.params?.turnId;
  if (typeof direct === "string") {
    return direct;
  }

  const nested = message.params?.turn?.id;
  return typeof nested === "string" ? nested : null;
}

function normalizeUserInputQuestions(raw: any): PendingUserInputQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((question) => question && typeof question === "object")
    .map((question) => ({
      id: typeof question.id === "string" ? question.id : "",
      header: typeof question.header === "string" ? question.header : "Question",
      question: typeof question.question === "string" ? question.question : "",
      options: Array.isArray(question.options)
        ? question.options
            .filter((option: any) => option && typeof option === "object")
            .map((option: any) => ({
              label: typeof option.label === "string" ? option.label : "",
              description: typeof option.description === "string" ? option.description : "",
            }))
            .filter((option: { label: string }) => option.label)
        : null,
      isOther: Boolean(question.isOther),
      isSecret: Boolean(question.isSecret),
    }))
    .filter((question) => question.id && question.question);
}

function normalizeWorkspaceKey(workspace: string): string {
  const normalized = path.normalize(normalizeCodexPath(workspace)).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildUserInputAnswers(
  questions: PendingUserInputQuestion[],
  answerText: string,
): Record<string, { answers: string[] }> {
  const trimmed = answerText.trim();
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const answers: Record<string, { answers: string[] }> = {};
  questions.forEach((question, index) => {
    const answer = questions.length === 1 ? trimmed : lines[index] ?? "";
    answers[question.id] = { answers: answer ? [answer] : [] };
  });

  return answers;
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
  const activeFlags = Array.isArray(rawStatus.activeFlags)
    ? rawStatus.activeFlags.filter((flag: unknown): flag is string => typeof flag === "string")
    : [];

  if (type) {
    return {
      label: activeFlags.length > 0 ? `${type} (${activeFlags.join(", ")})` : type,
      type,
      activeFlags,
    };
  }

  return { label: JSON.stringify(rawStatus), activeFlags };
}

function dateFromUnixSeconds(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000);
}

function deriveRuntimeState(
  snapshot: CodexSessionStatusSnapshot,
  appServerThreadStatusType?: string,
): CodexSessionRuntimeState {
  if (!snapshot.info.threadId) {
    return "not_started";
  }

  if (snapshot.pendingUserInput || snapshot.appServerActiveFlags?.includes("waitingOnUserInput")) {
    return "waiting_for_input";
  }

  if (
    snapshot.lastTurnStatus === "inProgress" ||
    appServerThreadStatusType === "active" ||
    snapshot.state === "running"
  ) {
    return "running";
  }

  if (appServerThreadStatusType === "idle" || snapshot.lastTurnStatus === "completed") {
    return "idle";
  }

  return snapshot.state === "unknown" ? "unknown" : snapshot.state;
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
    }
  }

  return undefined;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
