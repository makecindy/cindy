/**
 * Pi host 百分比自动压缩 —— turn 结束后按与 Claude Code 共用的阈值调 compact RPC。
 * 原生 window-reserve 不在本测范围。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knobs = vi.hoisted(() => ({
  compactCalls: [] as Array<Record<string, unknown>>,
  rpcTypes: [] as string[],
  compactResponse: null as null | { success: boolean; data?: unknown; error?: string },
  compactHold: null as null | Promise<void>,
  onEvent: null as null | ((event: { type: string; [key: string]: unknown }) => void),
}));

vi.mock('../transport.js', () => ({
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

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: { onEvent?: (event: { type: string; [key: string]: unknown }) => void }) {
      knobs.onEvent = opts.onEvent ?? null;
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown; error?: string }> {
      knobs.rpcTypes.push(cmd.type);
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200000 } } };
      }
      if (cmd.type === 'compact') {
        knobs.compactCalls.push(cmd as Record<string, unknown>);
        if (knobs.compactHold) await knobs.compactHold;
        return knobs.compactResponse ?? { success: true, data: {} };
      }
      if (cmd.type === 'set_model') {
        return { success: true, data: { contextWindow: 100000 } };
      }
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('PiAgent host auto-compact', () => {
  let agentHome = '';
  let cwd = '';

  beforeEach(() => {
    knobs.compactCalls = [];
    knobs.rpcTypes = [];
    knobs.compactResponse = null;
    knobs.compactHold = null;
    knobs.onEvent = null;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-host-ac-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-host-ac-cwd-'));
  });
  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(
    threshold: number | undefined,
    extra?: { shouldHandoff?: (tokens: number, window: number) => boolean },
  ): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {
        endpoint: 'http://127.0.0.1:9',
        ...(threshold === undefined ? {} : { autoCompactThresholdPct: threshold }),
        ...(extra?.shouldHandoff
          ? { shouldHandoffAfterContextAssessment: extra.shouldHandoff }
          : {}),
      },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null },
          { id: 'n', displayName: 'N', contextWindow: 100_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
    };
  }

  async function start(
    threshold: number | undefined,
    extra?: { shouldHandoff?: (tokens: number, window: number) => boolean },
  ): Promise<AgentSessionHandle> {
    return new PiAgent(buildDeps(threshold, extra)).startSession({
      sessionId: 's1',
      workingDir: cwd,
      model: 'm',
    });
  }

  function settleWithUsage(input: number, cacheRead = 0, cacheWrite = 0): void {
    knobs.onEvent?.({
      type: 'message_end',
      message: { role: 'assistant', usage: { input, cacheRead, cacheWrite, output: 8 } },
    });
    knobs.onEvent?.({ type: 'agent_settled' });
  }

  it('does not compact when host threshold is unset', async () => {
    const handle = await start(undefined);
    settleWithUsage(180_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toEqual([]));
    await handle.close();
  });

  it('does not compact below the shared percentage threshold', async () => {
    const handle = await start(75);
    // 140k / 200k = 70%
    settleWithUsage(140_000);
    await Promise.resolve();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it('compacts after agent_settled once occupancy crosses 75%', async () => {
    const handle = await start(75);
    // 160k / 200k = 80%
    settleWithUsage(160_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toEqual([{ type: 'compact' }]));
    await handle.close();
  });

  it('does not compact after agent_settled when host assessment requires rollover', async () => {
    const handle = await start(75, { shouldHandoff: () => true });
    settleWithUsage(160_000);
    await Promise.resolve();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it('does not compact after setModel when host assessment requires rollover', async () => {
    const handle = await start(75, { shouldHandoff: () => true });
    // 80k / 200k = 40% — 旧窗口未达阈值;切到 100k 后是 80%。
    settleWithUsage(80_000);
    await handle.setModel!('n');
    await Promise.resolve();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it('counts cache tokens toward occupancy', async () => {
    const handle = await start(75);
    settleWithUsage(1_000, 159_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    await handle.close();
  });

  it('counts cacheWrite tokens toward occupancy', async () => {
    const handle = await start(75);
    settleWithUsage(1_000, 0, 159_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    await handle.close();
  });

  async function waitForCompactCalls(n: number): Promise<void> {
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(n));
    // request() 入账后 then/finally 还要再走一拍，否则 in-flight 闸还没松开。
    await Promise.resolve();
    await Promise.resolve();
  }

  it('does not fire a second compact until compaction_end resets the latch', async () => {
    const handle = await start(75);
    settleWithUsage(160_000);
    await waitForCompactCalls(1);
    settleWithUsage(170_000);
    await Promise.resolve();
    expect(knobs.compactCalls).toHaveLength(1);
    knobs.onEvent?.({
      type: 'compaction_end',
      reason: 'manual',
      result: { tokensBefore: 170_000, estimatedTokensAfter: 20_000 },
    });
    settleWithUsage(160_000);
    await waitForCompactCalls(2);
    await handle.close();
  });

  it('retries after a failed compact instead of staying latched', async () => {
    knobs.compactResponse = { success: false, error: 'gateway 500' };
    const handle = await start(75);
    settleWithUsage(160_000);
    await waitForCompactCalls(1);
    knobs.compactResponse = { success: true, data: {} };
    settleWithUsage(161_000);
    await waitForCompactCalls(2);
    await handle.close();
  });

  it('treats aborted compaction_end as cancel so the next settle can retry', async () => {
    const handle = await start(75);
    settleWithUsage(160_000);
    await waitForCompactCalls(1);
    knobs.onEvent?.({
      type: 'compaction_end',
      reason: 'threshold',
      result: null,
      aborted: true,
    });
    settleWithUsage(162_000);
    await waitForCompactCalls(2);
    await handle.close();
  });

  it('does not treat a failed compaction_end as a successful boundary', async () => {
    const handle = await start(75);
    settleWithUsage(160_000);
    await waitForCompactCalls(1);
    knobs.onEvent?.({
      type: 'compaction_end',
      reason: 'threshold',
      result: null,
      aborted: false,
      errorMessage: 'quota exceeded',
    });
    settleWithUsage(163_000);
    await waitForCompactCalls(2);
    await handle.close();
  });

  it('holds setModel until the in-flight compact RPC finishes', async () => {
    let release!: () => void;
    knobs.compactHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = await start(75);
    settleWithUsage(160_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    const setModelDone = handle.setModel!('n');
    await Promise.resolve();
    expect(knobs.rpcTypes.includes('set_model')).toBe(false);
    release();
    await setModelDone;
    const compactAt = knobs.rpcTypes.lastIndexOf('compact');
    const setModelAt = knobs.rpcTypes.lastIndexOf('set_model');
    expect(compactAt).toBeGreaterThan(-1);
    expect(setModelAt).toBeGreaterThan(compactAt);
    await handle.close();
  });

  it('holds prompt until the in-flight compact RPC finishes', async () => {
    let release!: () => void;
    knobs.compactHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = await start(75);
    settleWithUsage(160_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    const sendDone = handle.send({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(knobs.rpcTypes.includes('prompt')).toBe(false);
    release();
    await sendDone;
    const compactAt = knobs.rpcTypes.lastIndexOf('compact');
    const promptAt = knobs.rpcTypes.lastIndexOf('prompt');
    expect(promptAt).toBeGreaterThan(compactAt);
    await handle.close();
  });

  it('holds steer until the in-flight compact RPC finishes', async () => {
    let release!: () => void;
    knobs.compactHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = await start(75);
    settleWithUsage(160_000);
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    const steerDone = handle.steer!({
      role: 'user',
      content: [{ type: 'text', text: 'steer now' }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(knobs.rpcTypes.includes('steer')).toBe(false);
    release();
    await steerDone;
    const compactAt = knobs.rpcTypes.lastIndexOf('compact');
    const steerAt = knobs.rpcTypes.lastIndexOf('steer');
    expect(steerAt).toBeGreaterThan(compactAt);
    await handle.close();
  });
});
