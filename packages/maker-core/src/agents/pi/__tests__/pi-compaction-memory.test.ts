/**
 * PiAgent 与 Cindy 记忆里的压缩摘要 (digest) —— mock pi 进程 + mock makerMemory。
 * 验证: 压缩结束不再写 digest; 旧版本存下的 digest 仍可清空。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  onEvent: null as ((event: unknown) => void) | null,
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
    constructor(opts: { onEvent: (event: unknown) => void }) {
      captured.onEvent = opts.onEvent;
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200000 } } };
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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PiAgent compaction digests', () => {
  let agentHome = '';
  let cwd = '';
  let writeMock: ReturnType<typeof vi.fn>;
  let resetDigestsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captured.onEvent = null;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-cm-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-cm-cwd-'));
    writeMock = vi.fn(async () => ({ ok: true, filename: 'digest_x.md' }));
    resetDigestsMock = vi.fn(async () => ({ removedCount: 2 }));
  });
  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(memoryEnabled: boolean, withManager = true): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', makerMemoryEnabled: memoryEnabled },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      ...(withManager ? { makerMemory: { write: writeMock, resetDigests: resetDigestsMock } as never } : {}),
    };
  }

  async function start(memoryEnabled: boolean, withManager = true): Promise<AgentSessionHandle> {
    return new PiAgent(buildDeps(memoryEnabled, withManager)).startSession({
      sessionId: 'cm-session',
      workingDir: cwd,
      model: 'm',
    });
  }

  function fireCompaction(summary: unknown, reason = 'threshold'): void {
    captured.onEvent!({ type: 'compaction_end', reason, result: { summary, estimatedTokensAfter: 32000 } });
  }

  // 2026-11 起 Pi 的压缩摘要不再存进 Cindy 记忆 (docs/product-rules/cindy-memory.md §5):
  // 那是对话内容的一份看不见、删不掉的副本, 删除任务后仍留在记忆里。
  it('does not store the compaction summary in memory, even with Cindy memory on', async () => {
    const handle = await start(true);
    fireCompaction('用户在本轮讨论了发布流程与回滚方案。');
    await Promise.resolve();
    expect(writeMock).not.toHaveBeenCalled();
    await handle.close();
  });

  // 旧版本存下的摘要仍可经这个窄入口清掉, 不碰用户的四类记忆。
  it('resetMemory removes only Pi digests through the narrow manager API', async () => {
    const agent = new PiAgent(buildDeps(true));
    await expect(agent.resetMemory()).resolves.toEqual({ removedEntries: 2 });
    expect(resetDigestsMock).toHaveBeenCalledTimes(1);
  });
});
