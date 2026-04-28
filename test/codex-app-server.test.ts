import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("CodexAppServerClient", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("starts a fresh app-server after the child process exits", async () => {
    const { CodexAppServerClient } = await import("../src/codex-app-server.js");
    const firstProc = createFakeProcess();
    const secondProc = createFakeProcess();
    mockSpawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const client = new CodexAppServerClient({ codexBin: "codex", env: {} });

    const firstResponse = client.request("thread/read", { threadId: "thread-a" });
    await respondToNextRequest(firstProc, "initialize", {});
    await respondToNextRequest(firstProc, "thread/read", { ok: "first" });

    await expect(firstResponse).resolves.toEqual({ ok: "first" });

    firstProc.emit("exit", 1, null);

    const secondResponse = client.request("thread/read", { threadId: "thread-a" });
    await respondToNextRequest(secondProc, "initialize", {});
    await respondToNextRequest(secondProc, "thread/read", { ok: "second" });

    await expect(secondResponse).resolves.toEqual({ ok: "second" });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

type FakeProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  readMessage: () => Promise<any>;
};

function createFakeProcess(): FakeProcess {
  const stdin = new PassThrough();
  const messages: any[] = [];
  const waiters: Array<(message: any) => void> = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        messages.push(message);
      }
    }
  });

  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    readMessage: () =>
      messages.length > 0
        ? Promise.resolve(messages.shift())
        : new Promise((resolve) => waiters.push(resolve)),
  });
}

async function respondToNextRequest(proc: FakeProcess, method: string, result: unknown): Promise<void> {
  let message = await proc.readMessage();
  while (message.method !== method) {
    message = await proc.readMessage();
  }
  expect(message.method).toBe(method);
  proc.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
}
