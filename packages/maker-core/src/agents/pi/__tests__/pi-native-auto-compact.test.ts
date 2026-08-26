/**
 * Pi owns automatic threshold and overflow compaction. Cindy observes the native
 * events and only latches deterministic failures for the next-send rollover.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const knobs = vi.hoisted(() => ({
  compactCalls: [] as Array<Record<string, unknown>>,
  compactHold: null as null | Promise<void>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  switchSessionSuccess: true,
  autoCompactionSuccess: true,
  onEvent: null as
    null | ((event: { type: string; [key: string]: unknown }) => void),
}));

vi.mock("../transport.js", () => ({
  createPiStdioTransport: (opts: {
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock("../rpc-client.js", () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: {
      onEvent?: (event: { type: string; [key: string]: unknown }) => void;
    }) {
      knobs.onEvent = opts.onEvent ?? null;
    }
    async request(cmd: Record<string, unknown>): Promise<{
      success: boolean;
      data?: unknown;
      error?: string;
    }> {
      knobs.rpcCalls.push(cmd);
      if (cmd.type === "get_state") {
        return {
          success: true,
          data: {
            sessionFile: "/mock/s.jsonl",
            model: { contextWindow: 200_000 },
          },
        };
      }
      if (cmd.type === "compact") {
        knobs.compactCalls.push(cmd);
        if (knobs.compactHold) await knobs.compactHold;
        return { success: true, data: {} };
      }
      if (cmd.type === "set_auto_compaction") {
        return knobs.autoCompactionSuccess
          ? { success: true, data: {} }
          : { success: false, error: "runtime rejected" };
      }
      if (cmd.type === "set_model") {
        return { success: true, data: { contextWindow: 100_000 } };
      }
      if (cmd.type === "switch_session") {
        return knobs.switchSessionSuccess
          ? { success: true, data: {} }
          : { success: false, error: "reload denied" };
      }
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { buildPiSettingsJsonContent, PiAgent } from "../index.js";
import type { AgentDeps, AgentSessionHandle } from "../../base-agent.js";
import type { Logger } from "../../../interfaces/logger.js";

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

describe("Pi native settings", () => {
  it("maps the configured percentage to Pi reserve tokens", () => {
    expect(JSON.parse(buildPiSettingsJsonContent(128_000, 75))).toEqual({
      transport: "sse",
      compaction: { reserveTokens: 32_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(200_000, 75))).toEqual({
      transport: "sse",
      compaction: { reserveTokens: 50_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(100_000, 75))).toEqual({
      transport: "sse",
      compaction: { reserveTokens: 25_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(128_000))).toEqual({ transport: "sse" });
  });
});

describe("PiAgent native auto-compaction ownership", () => {
  let agentHome = "";
  let cwd = "";

  beforeEach(() => {
    knobs.compactCalls = [];
    knobs.compactHold = null;
    knobs.rpcCalls = [];
    knobs.switchSessionSuccess = true;
    knobs.autoCompactionSuccess = true;
    knobs.onEvent = null;
    agentHome = mkdtempSync(path.join(tmpdir(), "pi-native-ac-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "pi-native-ac-cwd-"));
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({
          authenticated: true,
          identity: "t",
          authSource: "api-key" as const,
        }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      // Keep a host threshold here to prove PiAgent no longer consumes it.
      runtimeConfig: {
        endpoint: "http://127.0.0.1:9",
        autoCompactThresholdPct: 75,
        piAutoCompactThresholdPct: 75,
      },
      binaryPath: path.join(agentHome, "pi"),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: "m",
            displayName: "M",
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
          {
            id: "n",
            displayName: "N",
            contextWindow: 100_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiGatewayModelApi: () => "openai-responses",
      resolvePiAgentHome: () => agentHome,
    };
  }

  async function start(): Promise<AgentSessionHandle> {
    return new PiAgent(buildDeps()).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
  }

  function settleWithUsage(input: number): void {
    knobs.onEvent?.({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input, cacheRead: 0, cacheWrite: 0, output: 8 },
      },
    });
    knobs.onEvent?.({ type: "agent_settled" });
  }

  it("enables Pi native auto-compaction during startup", async () => {
    const handle = await start();
    expect(knobs.rpcCalls).toContainEqual({
      type: "set_auto_compaction",
      enabled: true,
    });
    await handle.close();
  });

  it("refuses to start when native auto-compaction cannot be enabled", async () => {
    knobs.autoCompactionSuccess = false;
    await expect(start()).rejects.toThrow(/refusing to start without native auto-compaction/);
  });

  it("does not issue host compact RPCs at the shared threshold or a full window", async () => {
    const handle = await start();
    settleWithUsage(160_000);
    settleWithUsage(200_000);
    await Promise.resolve();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it("accepts a successful native threshold boundary and updates context usage", async () => {
    const handle = await start();
    settleWithUsage(200_000);
    knobs.onEvent?.({ type: "compaction_start", reason: "threshold" });
    knobs.onEvent?.({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 200_000, estimatedTokensAfter: 20_000 },
      aborted: false,
    });
    expect(handle.getUsageSnapshot()).toMatchObject({
      contextTokens: 20_000,
      contextWindow: 200_000,
    });
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it.each(["threshold", "overflow"])(
    "latches a deterministic native %s compaction failure for local rollover",
    async (reason) => {
      const handle = await start();
      settleWithUsage(190_000);
      knobs.onEvent?.({
        type: "compaction_end",
        reason,
        result: null,
        aborted: false,
        errorMessage: "summarization produced empty response",
      });
      expect(handle.getUsageSnapshot().needsRollover).toBe(true);
      expect(knobs.compactCalls).toEqual([]);
      await handle.close();
    },
  );

  it("does not latch manual, aborted, or transient native compaction failures", async () => {
    const cases = [
      {
        reason: "manual",
        aborted: false,
        errorMessage: "summarization produced empty response",
      },
      {
        reason: "threshold",
        aborted: true,
        errorMessage: "summarization produced empty response",
      },
      { reason: "threshold", aborted: false, errorMessage: "gateway 500" },
    ];
    for (const testCase of cases) {
      const handle = await start();
      settleWithUsage(190_000);
      knobs.onEvent?.({ type: "compaction_end", result: null, ...testCase });
      expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();
      await handle.close();
    }
  });

  async function startHeldManualCompact(handle: AgentSessionHandle): Promise<{
    release: () => void;
    compactDone: Promise<unknown>;
  }> {
    let release!: () => void;
    knobs.compactHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compactDone = handle.compactSession!();
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    return { release, compactDone };
  }

  it("keeps manual compact serialized before model controls", async () => {
    const handle = await start();
    const { release, compactDone } = await startHeldManualCompact(handle);
    const setModelDone = handle.setModel!("n");
    await Promise.resolve();
    expect(knobs.rpcCalls.some((call) => call.type === "set_model")).toBe(
      false,
    );
    release();
    await Promise.all([compactDone, setModelDone]);
    const types = knobs.rpcCalls.map((call) => call.type);
    expect(types.lastIndexOf("set_model")).toBeGreaterThan(
      types.lastIndexOf("compact"),
    );
    await handle.close();
  });

  it.each([
    [
      "prompt",
      (handle: AgentSessionHandle) =>
        handle.send({
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
    ],
    [
      "steer",
      (handle: AgentSessionHandle) =>
        handle.steer!({
          role: "user",
          content: [{ type: "text", text: "steer now" }],
        }),
    ],
  ] as const)(
    "keeps manual compact serialized before %s",
    async (rpcType, run) => {
      const handle = await start();
      const { release, compactDone } = await startHeldManualCompact(handle);
      const controlDone = run(handle);
      await Promise.resolve();
      await Promise.resolve();
      expect(knobs.rpcCalls.some((call) => call.type === rpcType)).toBe(false);
      release();
      await Promise.all([compactDone, controlDone]);
      const types = knobs.rpcCalls.map((call) => call.type);
      expect(types.lastIndexOf(rpcType)).toBeGreaterThan(
        types.lastIndexOf("compact"),
      );
      await handle.close();
    },
  );

  function readLatestPiSettings(): { compaction?: { reserveTokens?: number } } {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "settings.json") files.push(next);
      }
    };
    walk(agentHome);
    expect(files.length).toBeGreaterThan(0);
    return JSON.parse(readFileSync(files[files.length - 1]!, "utf8")) as {
      compaction?: { reserveTokens?: number };
    };
  }

  it("rewrites native reserve tokens when the model window changes", async () => {
    const handle = await start();
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(50_000);
    await handle.setModel!("n");
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(25_000);
    expect(knobs.rpcCalls.some((call) => call.type === "switch_session")).toBe(true);
    await handle.close();
  });

  it("terminates the session when compaction settings reload fails after a window change", async () => {
    const handle = await start();
    knobs.switchSessionSuccess = false;
    await expect(handle.setModel!("n")).rejects.toThrow(/未能重载压缩阈值/);
    await handle.close();
  });

  it("keeps the startup Pi percentage after the live setting changes", async () => {
    const runtimeConfig = {
      endpoint: "http://127.0.0.1:9",
      autoCompactThresholdPct: 75,
      piAutoCompactThresholdPct: 75,
    };
    const handle = await new PiAgent({
      ...buildDeps(),
      runtimeConfig,
    }).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(50_000);
    runtimeConfig.piAutoCompactThresholdPct = 50;
    await handle.setModel!("n");
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(25_000);
    await handle.close();
  });
});
