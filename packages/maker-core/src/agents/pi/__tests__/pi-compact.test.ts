/**
 * PiAgent.compactSession 单测(mock PiRpcProcess)—— 验证 compact RPC 的命令组装、
 * customInstructions 透传、结果解析,以及良性拒绝 → noop 的映射。真实压缩(LLM 摘要
 * + compact_boundary 事件)靠集成测试的 noop 契约兜底;happy-path 数值解析在此确定性验证。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knobs = vi.hoisted(() => ({
  compactResponse: null as null | { success: boolean; data?: unknown; error?: string },
  lastCompactCommand: null as null | Record<string, unknown>,
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
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown; error?: string }> {
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200000 } } };
      }
      if (cmd.type === 'compact') {
        knobs.lastCompactCommand = cmd as Record<string, unknown>;
        return knobs.compactResponse ?? { success: true, data: {} };
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

describe('PiAgent.compactSession (mocked pi process)', () => {
  let agentHome = '';
  let cwd = '';

  beforeEach(() => {
    knobs.compactResponse = null;
    knobs.lastCompactCommand = null;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-compact-unit-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-compact-unit-cwd-'));
  });
  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
    };
  }

  async function start(): Promise<AgentSessionHandle> {
    return new PiAgent(buildDeps()).startSession({ sessionId: 's1', workingDir: cwd, model: 'm' });
  }

  it('declares manualCompact capability', () => {
    expect(new PiAgent(buildDeps()).capabilities.manualCompact?.supported).toBe(true);
  });

  it('parses tokensBefore/estimatedTokensAfter and omits missing numbers', async () => {
    knobs.compactResponse = {
      success: true,
      data: { summary: 'x', tokensBefore: 150000, estimatedTokensAfter: 32000, extra: 'ignored' },
    };
    const handle = await start();
    const result = await handle.compactSession?.();
    expect(result).toEqual({ tokensBefore: 150000, estimatedTokensAfter: 32000 });
    await handle.close();
  });

  it('passes customInstructions through when provided, omits when blank', async () => {
    const handle = await start();
    await handle.compactSession?.('  keep the API design decisions  ');
    expect(knobs.lastCompactCommand).toEqual({ type: 'compact', customInstructions: 'keep the API design decisions' });
    knobs.lastCompactCommand = null;
    await handle.compactSession?.('   ');
    expect(knobs.lastCompactCommand).toEqual({ type: 'compact' });
    await handle.close();
  });

  it('maps benign "nothing to compact / too small" refusal to noop (not throw)', async () => {
    const handle = await start();
    knobs.compactResponse = { success: false, error: 'Nothing to compact (session too small)' };
    await expect(handle.compactSession?.()).resolves.toEqual({ noop: true });
    knobs.compactResponse = { success: false, error: 'context too small' };
    await expect(handle.compactSession?.()).resolves.toEqual({ noop: true });
    await handle.close();
  });

  it('throws on a genuine compact failure', async () => {
    const handle = await start();
    knobs.compactResponse = { success: false, error: 'gateway 500' };
    await expect(handle.compactSession?.()).rejects.toThrow(/gateway 500/);
    await handle.close();
  });
});
