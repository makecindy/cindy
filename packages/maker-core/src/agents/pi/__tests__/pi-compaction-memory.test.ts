/**
 * PiAgent 压缩即记忆 —— compaction_end 带摘要正文时写 digest 记忆(mock pi 进程 + mock
 * makerMemory)。验证:开启时写 digest(字段正确)、关闭/无摘要时不写、写失败不阻断会话。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  onEvent: null as ((event: unknown) => void) | null,
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

describe('PiAgent compaction → memory digest', () => {
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

  it('writes a digest entry with correct fields when memory is enabled', async () => {
    const handle = await start(true);
    fireCompaction('The conversation covered the API redesign and the test plan.');
    await flush();
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [scopeKey, opts] = writeMock.mock.calls[0];
    expect(typeof scopeKey).toBe('string');
    expect(opts.type).toBe('digest');
    expect(opts.mode).toBe('create');
    expect(opts.title).toContain('threshold');
    expect(opts.description).toContain('API redesign');
    expect(opts.body).toContain('test plan');
    expect(opts.name).toMatch(/^[a-z0-9_-]{1,64}$/);
    await handle.close();
  });

  it('truncates a long CJK summary by UTF-8 bytes (≤ shard headroom), not chars', async () => {
    const handle = await start(true);
    // 5000 汉字 ≈ 15000 字节:按字符截断(阈值 7000 字符)不会触发,但会超存储 8192 字节硬上限。
    const bigCjk = '摘'.repeat(5000);
    fireCompaction(bigCjk);
    await flush();
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [, opts] = writeMock.mock.calls[0];
    expect(Buffer.byteLength(opts.body, 'utf8')).toBeLessThanOrEqual(7000);
    expect(opts.body.endsWith('…')).toBe(true);
    await handle.close();
  });

  it('keeps title within limit even if pi reports a long reason', async () => {
    const handle = await start(true);
    fireCompaction('summary', 'x'.repeat(300));
    await flush();
    const [, opts] = writeMock.mock.calls[0];
    expect(opts.title.length).toBeLessThanOrEqual(100);
    await handle.close();
  });

  it('does not write when memory is disabled', async () => {
    const handle = await start(false);
    fireCompaction('some summary');
    await flush();
    expect(writeMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it('does not write when there is no summary text', async () => {
    const handle = await start(true);
    fireCompaction(undefined);
    fireCompaction('   ');
    fireCompaction(42);
    await flush();
    expect(writeMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it('does not write when no manager is injected even if flag is on', async () => {
    const handle = await start(true, false);
    fireCompaction('summary');
    await flush();
    expect(writeMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it('a failing digest write does not throw into the event loop', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'));
    const handle = await start(true);
    expect(() => fireCompaction('summary that fails to persist')).not.toThrow();
    await flush();
    await handle.close();
  });

  it('resetMemory removes only Pi digests through the narrow manager API', async () => {
    const agent = new PiAgent(buildDeps(true));
    await expect(agent.resetMemory()).resolves.toEqual({ removedEntries: 2 });
    expect(resetDigestsMock).toHaveBeenCalledTimes(1);
  });
});
