/**
 * PrimeAgent 启动契约测试。
 *
 * 覆盖 docs/dev-rules/maker-core-and-agent-behavior.md「启动失败与工作目录占用」:
 * `--mode rpc` 子进程持有工作目录, 所以启动失败时必须区分「进程已确认退出」与
 * 「关闭未确认」—— 前者抛 `AgentStartupStoppedError`(Maker 释放目录租约), 后者抛
 * `AgentStartupCleanupPendingError`(Maker 继续持有租约, 不把可能仍占用目录的任务
 * 记成「尚未启动」)。
 *
 * transport 与 RPC 客户端都打桩: 这里测的是 startSession 的编排, 不是协议。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../rpc-client.js', () => ({
  PrimeAgentRpcProcess: class {
    request = mocks.request;
    close = mocks.close;
    get isClosed(): boolean {
      return false;
    }
  },
}));

vi.mock('../transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport.js')>();
  return {
    ...actual,
    createPrimeAgentStdioTransport: mocks.spawn.mockReturnValue({
      writeLine: vi.fn(async () => undefined),
      onLine: vi.fn(() => () => undefined),
      onClose: vi.fn(() => () => undefined),
      onStderr: vi.fn(() => () => undefined),
      onDisconnect: vi.fn(() => () => undefined),
      onOversizedFrame: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
      isClosed: () => false,
      pid: 1,
    }),
  };
});

const { PrimeAgent } = await import('../index.js');
const { AgentStartupCleanupPendingError, AgentStartupStoppedError } = await import(
  '../../base-agent.js'
);

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

let workDir: string | undefined;

function freshWorkDir(): string {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = mkdtempSync(path.join(tmpdir(), 'cindy-prime-agent-startup-'));
  return workDir;
}

function makeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    // 默认给一个真实存在的文件 —— startSession 会 stat 它。
    binaryPath: process.execPath,
    logger,
    // startSession 不读 auth; 给一个满足类型的桩即可。
    auth: {
      getState: async () => ({ authenticated: false }),
      triggerLogin: async () => undefined,
      logout: async () => undefined,
      cancelLogin: () => undefined,
    } as unknown as AgentDeps['auth'],
    runtimeConfig: {},
    ...overrides,
  };
}

afterEach(() => {
  mocks.request.mockReset();
  mocks.close.mockReset();
  mocks.close.mockResolvedValue(undefined);
  mocks.spawn.mockClear();
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe('PrimeAgent startup failure contract', () => {
  it('BaseAgent itself refuses an empty binaryPath at construction', () => {
    // 空 binaryPath 在 BaseAgent 构造期就被拒 —— 进程从未创建, 无需启动清理契约。
    expect(() => new PrimeAgent(makeDeps({ binaryPath: '' })))
      .toThrow(/binaryPath is required at construction/);
  });

  it('rejects a non-file binaryPath with AgentStartupStoppedError', async () => {
    const agent = new PrimeAgent(makeDeps({ binaryPath: freshWorkDir() }));
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'm' }))
      .rejects.toBeInstanceOf(AgentStartupStoppedError);
    // 二进制不是文件: spawn 从未发生。
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a get_state failure with AgentStartupStoppedError when close is confirmed', async () => {
    mocks.request.mockResolvedValue({
      type: 'response', command: 'get_state', success: false, error: 'boom',
    });
    const agent = new PrimeAgent(makeDeps());
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'm' }))
      .rejects.toBeInstanceOf(AgentStartupStoppedError);
    // 进程必须被回收, 不能留孤儿。
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('rejects with AgentStartupCleanupPendingError when the close stays unconfirmed', async () => {
    mocks.request.mockResolvedValue({
      type: 'response', command: 'get_state', success: false, error: 'boom',
    });
    mocks.close.mockRejectedValue(new Error('did not confirm exit after SIGKILL'));

    const agent = new PrimeAgent(makeDeps());
    const error = await agent.startSession({ workingDir: process.cwd(), model: 'm' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AgentStartupCleanupPendingError);
    expect((error as InstanceType<typeof AgentStartupCleanupPendingError>).whenStopped)
      .toBeInstanceOf(Promise);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('retries an unconfirmed startup cleanup on the next startSession', async () => {
    mocks.request.mockResolvedValue({
      type: 'response', command: 'get_state', success: false, error: 'boom',
    });
    // 第 1 次 close = 启动 1 的收口(未确认); 第 2 次 close = 启动 2 的重试(仍未确认);
    // 第 3 次 close = 启动 2 自己的收口(这次确认了)。
    mocks.close
      .mockRejectedValueOnce(new Error('did not confirm exit after SIGKILL'))
      .mockRejectedValueOnce(new Error('did not confirm exit after SIGKILL'))
      .mockResolvedValueOnce(undefined);

    const agent = new PrimeAgent(makeDeps());
    const sessionId = 'session-a';
    await expect(agent.startSession({ sessionId, workingDir: process.cwd(), model: 'm' }))
      .rejects.toBeInstanceOf(AgentStartupCleanupPendingError);

    // 第二次启动: 先重试确认上一次的进程(仍失败, 记录保留), 再走本次启动;
    // 本次启动的关闭确认了, 所以抛 AgentStartupStoppedError。
    await expect(agent.startSession({ sessionId, workingDir: process.cwd(), model: 'm' }))
      .rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });

  it('dispose() retries a still-unconfirmed startup cleanup', async () => {
    mocks.request.mockResolvedValue({
      type: 'response', command: 'get_state', success: false, error: 'boom',
    });
    mocks.close
      .mockRejectedValueOnce(new Error('did not confirm exit after SIGKILL'))
      .mockResolvedValueOnce(undefined);

    const agent = new PrimeAgent(makeDeps());
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'm' }))
      .rejects.toBeInstanceOf(AgentStartupCleanupPendingError);

    await agent.dispose();
    // 1 次启动失败关闭 + 1 次 dispose 重试。
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it('returns a handle whose id is the get_state sessionId', async () => {
    mocks.request.mockImplementation((command: { type: string }) => {
      switch (command.type) {
        case 'set_auto_compaction':
          return Promise.resolve({ type: 'response', command, success: true });
        case 'get_state':
          return Promise.resolve({
            type: 'response',
            command,
            success: true,
            data: {
              sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
              model: { id: 'faux-1', provider: 'faux', contextWindow: 100_000 },
              thinkingLevel: 'off',
              isStreaming: false,
              messageCount: 0,
            },
          });
        default:
          return Promise.resolve({ type: 'response', command, success: true });
      }
    });

    const agent = new PrimeAgent(makeDeps());
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'faux-1' });

    expect(handle.id).toBe('a1b2c3d4-0000-4000-8000-000000000000');
    expect(handle.model).toBe('faux-1');
    expect(handle.agentKind).toBe('prime-agent');
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(handle.hasPendingHostOperation?.()).toBe(false);
    // getUsageSnapshot 不抛, 且带 turn 计量字段。
    expect(handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 0, costUsd: 0 });

    await handle.close();
  });

  it('rejects an unsafe sessionId instead of adopting it', async () => {
    mocks.request.mockImplementation((command: { type: string }) => {
      if (command.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command,
          success: true,
          data: { sessionId: 'bad\nid', model: { id: 'faux-1' }, messageCount: 0 },
        });
      }
      return Promise.resolve({ type: 'response', command, success: true });
    });

    const agent = new PrimeAgent(makeDeps());
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'm' }))
      .rejects.toThrow(/unsafe sessionId/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('passes --mode rpc plus the resume/cwd/model/thinking args to the spawn', async () => {
    mocks.request.mockImplementation((command: { type: string }) => {
      if (command.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command,
          success: true,
          data: { sessionId: 'sid', model: { id: 'faux-1' }, messageCount: 0 },
        });
      }
      return Promise.resolve({ type: 'response', command, success: true });
    });

    const agent = new PrimeAgent(makeDeps());
    await agent.startSession({
      workingDir: process.cwd(),
      model: 'faux-1',
      effort: 'high',
      resumeSessionId: 'prev-session',
      userPrompt: 'be terse',
    });

    const call = mocks.spawn.mock.calls[0]?.[0] as
      | { args: string[]; binaryPath: string }
      | undefined;
    expect(call?.args).toEqual([
      '--mode', 'rpc',
      '--resume', 'prev-session',
      '--cwd', process.cwd(),
      '--model', 'faux-1',
      '--thinking', 'high',
      '--append-system-prompt', 'be terse',
    ]);
  });

  it('rejects effort=ultra with NotSupportedError before spawning', async () => {
    const agent = new PrimeAgent(makeDeps());
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'm', effort: 'ultra' }))
      .rejects.toThrow(/no thinking level above "max"|not supported/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('setModel refuses a model that is not in Prime Agent’s own catalog', async () => {
    mocks.request.mockImplementation((command: { type: string }) => {
      if (command.type === 'get_state') {
        return Promise.resolve({
          type: 'response',
          command,
          success: true,
          data: { sessionId: 'sid', model: { id: 'faux-1' }, messageCount: 0 },
        });
      }
      if (command.type === 'get_available_models') {
        return Promise.resolve({
          type: 'response',
          command,
          success: true,
          data: { models: [{ id: 'faux-1', provider: 'faux' }] },
        });
      }
      return Promise.resolve({ type: 'response', command, success: true });
    });

    const agent = new PrimeAgent(makeDeps());
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'faux-1' });
    // 让预热目录先落库。
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(handle.setModel?.('not-in-catalog')).rejects.toThrow(/not in Prime Agent/);
    // 目录里的模型则带上 (provider, modelId) 两元组。
    await handle.setModel?.('faux-1');
    const setModelCall = mocks.request.mock.calls
      .map((call) => call[0] as { type: string; provider?: string; modelId?: string })
      .find((command) => command.type === 'set_model');
    expect(setModelCall).toMatchObject({ type: 'set_model', provider: 'faux', modelId: 'faux-1' });

    await handle.close();
  });
});
