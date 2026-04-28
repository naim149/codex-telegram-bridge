import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { formatLogError, redactForLog } from "./log-redaction.js";

type JsonRpcId = number | string;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type AppServerMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

export type AppServerNotification = {
  method: string;
  params: any;
};

export type AppServerRequest = {
  id: JsonRpcId;
  method: string;
  params: any;
};

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private closed = false;

  constructor(
    private readonly options: {
      codexBin: string;
      env: Record<string, string>;
    },
  ) {}

  onNotification(callback: (message: AppServerNotification) => void): () => void {
    this.emitter.on("notification", callback);
    return () => this.emitter.off("notification", callback);
  }

  onServerRequest(callback: (message: AppServerRequest) => void): () => void {
    this.emitter.on("serverRequest", callback);
    return () => this.emitter.off("serverRequest", callback);
  }

  async ensureReady(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed.");
    }

    if (this.initialized) {
      return this.initialized;
    }

    this.initialized = this.start().catch((error: unknown) => {
      this.resetProcess();
      throw error;
    });
    return this.initialized;
  }

  async request<T = any>(method: string, params?: any): Promise<T> {
    await this.ensureReady();
    return this.rawRequest<T>(method, params);
  }

  private rawRequest<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    try {
      this.write(payload);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  dispose(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`Codex app-server closed before response ${String(id)}`));
    }
    this.pending.clear();

    try {
      this.proc?.kill();
    } catch {
      // Ignore process shutdown failures.
    }
    this.proc = null;
    this.initialized = null;
  }

  private async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    this.proc = spawn(this.options.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env,
      windowsHide: true,
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.warn(`codex app-server: ${truncateForLog(redactForLog(text), 1000)}`);
      }
    });

    this.proc.on("error", (error) => {
      this.resetProcess();
      this.failAll(error);
    });
    this.proc.on("exit", (code, signal) => {
      this.resetProcess();
      if (this.closed) {
        return;
      }
      this.failAll(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
    });

    await this.rawRequest("initialize", {
      clientInfo: {
        name: "codex_telegram_bridge",
        title: "Codex Telegram Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.write({ method: "initialized", params: {} });
  }

  private write(message: unknown): void {
    if (!this.proc?.stdin.writable) {
      this.resetProcess();
      throw new Error("Codex app-server stdin is not writable");
    }

    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      console.warn(`Ignoring non-JSON app-server line: ${truncateForLog(redactForLog(line), 1000)}`);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? ""}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emitter.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params,
      } satisfies AppServerRequest);
      return;
    }

    if (message.method) {
      this.emitter.emit("notification", {
        method: message.method,
        params: message.params,
      } satisfies AppServerNotification);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    console.warn(`codex app-server client: ${formatLogError(error)}`);
  }

  private resetProcess(): void {
    this.proc = null;
    this.initialized = null;
  }
}

function truncateForLog(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}
