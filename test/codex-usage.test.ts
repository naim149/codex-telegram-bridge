import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockDbState = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; cwd: string; model: string | null; source?: string | null }>,
}));

vi.mock("node:fs", () => ({
  existsSync: mockFs.existsSync,
  readdirSync: mockFs.readdirSync,
  readFileSync: mockFs.readFileSync,
}));

vi.mock("../src/codex-state.js", () => ({
  findLatestDatabase: vi.fn(() => "/Users/tester/.codex/state_main.sqlite"),
  normalizeCodexPath: vi.fn((value: string) => {
    if (value.startsWith("\\\\?\\")) {
      return value.slice(4);
    }
    return value;
  }),
}));

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    prepare(_sql: string) {
      return {
        all: () => mockDbState.rows,
      };
    }

    close(): void {}
  },
}));

beforeEach(() => {
  process.env.HOME = "/Users/tester";
  mockDbState.rows = [];
  mockFs.existsSync.mockReset();
  mockFs.readdirSync.mockReset();
  mockFs.readFileSync.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function dirent(name: string, kind: "file" | "dir") {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  };
}

describe("codex-usage", () => {
  it("summarizes workspace token usage and standard API-equivalent cost", async () => {
    const workspace = "C:\\Users\\Example\\Projects\\sample-app";
    const sessionsDir = path.join("/Users/tester", ".codex", "sessions");

    mockDbState.rows = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        cwd: "\\\\?\\C:\\Users\\Example\\Projects\\sample-app",
        model: "gpt-5.4",
        source: null,
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        cwd: "C:\\Users\\Example\\Projects\\sample-app",
        model: "gpt-5.4-mini",
        source: JSON.stringify({
          subagent: {
            thread_spawn: {
              parent_thread_id: "11111111-1111-1111-1111-111111111111",
              agent_nickname: "Ada",
            },
          },
        }),
      },
    ];

    mockFs.existsSync.mockImplementation((targetPath: string) => targetPath === sessionsDir);
    mockFs.readdirSync.mockImplementation((targetPath: string) => {
      if (targetPath === sessionsDir) {
        return [dirent("2026", "dir")];
      }
      if (targetPath === path.join(sessionsDir, "2026")) {
        return [dirent("04", "dir")];
      }
      if (targetPath === path.join(sessionsDir, "2026", "04")) {
        return [
          dirent("rollout-2026-04-23T10-00-00-11111111-1111-1111-1111-111111111111.jsonl", "file"),
          dirent("rollout-2026-04-23T10-05-00-22222222-2222-2222-2222-222222222222.jsonl", "file"),
        ];
      }
      return [];
    });
    mockFs.readFileSync.mockImplementation((targetPath: string) => {
      if (String(targetPath).includes("11111111-1111-1111-1111-111111111111")) {
        return [
          JSON.stringify({
            timestamp: "2026-04-23T10:00:00.000Z",
            type: "session_meta",
            payload: {},
          }),
          JSON.stringify({
            timestamp: "2026-04-23T10:02:00.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 1_000,
                  cached_input_tokens: 600,
                  output_tokens: 100,
                  reasoning_output_tokens: 50,
                  total_tokens: 1_100,
                },
              },
              rate_limits: { plan_type: "plus" },
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-23T10:12:00.000Z",
            type: "response_item",
            payload: { type: "message" },
          }),
        ].join("\n");
      }

      return [
        JSON.stringify({
          timestamp: "2026-04-23T10:05:00.000Z",
          type: "session_meta",
          payload: {},
        }),
        JSON.stringify({
          timestamp: "2026-04-23T10:05:30.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 2_000,
                cached_input_tokens: 1_000,
                output_tokens: 200,
                reasoning_output_tokens: 80,
                total_tokens: 2_200,
              },
            },
            rate_limits: { plan_type: "plus" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-23T10:08:30.000Z",
          type: "response_item",
          payload: { type: "message" },
        }),
      ].join("\n");
    });

    const { summarizeWorkspaceUsage } = await import("../src/codex-usage.js");
    const summary = summarizeWorkspaceUsage(workspace);

    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      workspace,
      threadCount: 2,
      summarizedThreadCount: 2,
      mainThreadCount: 1,
      subAgentThreadCount: 1,
      observedPlanTypes: ["plus"],
      unsupportedModels: [],
      totals: {
        totalTokens: 3_300,
        inputTokens: 3_000,
        cachedInputTokens: 1_600,
        outputTokens: 300,
        reasoningOutputTokens: 130,
      },
      activity: {
        estimatedActiveMs: 630_000,
        observedSpanMs: 720_000,
        mainThreadActiveMs: 420_000,
        subAgentActiveMs: 210_000,
        eventCount: 6,
      },
    });
    expect(summary?.estimatedCostUsd).toBeCloseTo(0.004375, 8);
    expect(summary?.byModel).toHaveLength(2);
    expect(summary?.threads[0]).toMatchObject({
      threadId: "22222222-2222-2222-2222-222222222222",
      isSubAgent: true,
      agentNickname: "Ada",
      activity: {
        estimatedActiveMs: 210_000,
        observedSpanMs: 210_000,
        eventCount: 3,
      },
    });
  });

  it("returns null when no matching workspace threads are found", async () => {
    const sessionsDir = path.join("/Users/tester", ".codex", "sessions");
    mockFs.existsSync.mockImplementation((targetPath: string) => targetPath === sessionsDir);
    mockFs.readdirSync.mockReturnValue([]);
    mockDbState.rows = [];

    const { summarizeWorkspaceUsage } = await import("../src/codex-usage.js");
    expect(summarizeWorkspaceUsage("C:\\Users\\Example\\Projects\\sample-app")).toBeNull();
  });

  it("prices current and historical Codex model slugs", async () => {
    const workspace = "C:\\Users\\Example\\Projects\\model-fixtures";
    const sessionsDir = path.join("/Users/tester", ".codex", "sessions");
    const models = ["gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex-max"];

    mockDbState.rows = models.map((model, index) => ({
      id: `${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}-${index + 1}${index + 1}${index + 1}${index + 1}-${index + 1}${index + 1}${index + 1}${index + 1}-${index + 1}${index + 1}${index + 1}${index + 1}-${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}`,
      cwd: workspace,
      model,
      source: null,
    }));

    mockFs.existsSync.mockImplementation((targetPath: string) => targetPath === sessionsDir);
    mockFs.readdirSync.mockImplementation((targetPath: string) => {
      if (targetPath === sessionsDir) {
        return mockDbState.rows.map((thread) => dirent(`rollout-2026-04-23T10-00-00-${thread.id}.jsonl`, "file"));
      }
      return [];
    });
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        timestamp: "2026-04-23T10:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000_000,
              cached_input_tokens: 100_000,
              output_tokens: 10_000,
              reasoning_output_tokens: 0,
              total_tokens: 1_010_000,
            },
          },
        },
      }),
    );

    const { summarizeWorkspaceUsage } = await import("../src/codex-usage.js");
    const summary = summarizeWorkspaceUsage(workspace);

    expect(summary?.unsupportedModels).toEqual([]);
    expect(summary?.byModel.map((model) => model.model).sort()).toEqual([...models].sort());
    for (const model of summary?.byModel ?? []) {
      expect(model.estimatedCostUsd).toBeCloseTo(1.7325, 8);
    }
  });

  it("returns the latest observed rate-limit snapshot", async () => {
    const sessionsDir = path.join("/Users/tester", ".codex", "sessions");
    mockDbState.rows = [];
    mockFs.existsSync.mockImplementation((targetPath: string) => targetPath === sessionsDir);
    mockFs.readdirSync.mockImplementation((targetPath: string) => {
      if (targetPath === sessionsDir) {
        return [
          dirent("rollout-2026-04-23T10-00-00-11111111-1111-1111-1111-111111111111.jsonl", "file"),
          dirent("rollout-2026-04-23T11-00-00-22222222-2222-2222-2222-222222222222.jsonl", "file"),
        ];
      }
      return [];
    });
    mockFs.readFileSync.mockImplementation((targetPath: string) => {
      if (String(targetPath).includes("11111111-1111-1111-1111-111111111111")) {
        return JSON.stringify({
          timestamp: "2026-04-23T10:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: null,
            rate_limits: {
              limit_id: "codex",
              plan_type: "plus",
              primary: { used_percent: 20, window_minutes: 300, resets_at: 1_777_000_000 },
              secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1_778_000_000 },
            },
          },
        });
      }

      return JSON.stringify({
        timestamp: "2026-04-23T11:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_777_100_000 },
            secondary: { used_percent: 55, window_minutes: 10080, resets_at: 1_778_100_000 },
          },
        },
      });
    });

    const { getLatestRateLimitSummary } = await import("../src/codex-usage.js");
    const summary = getLatestRateLimitSummary();

    expect(summary).toMatchObject({
      limitId: "codex",
      planType: "pro",
      primary: {
        usedPercent: 12.5,
        remainingPercent: 87.5,
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 55,
        remainingPercent: 45,
        windowMinutes: 10080,
      },
    });
    expect(summary?.observedAt.toISOString()).toBe("2026-04-23T11:00:00.000Z");
  });
});
