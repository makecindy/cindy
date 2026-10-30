import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent, setClaudeSupportedModelsListener } from '../index.js';

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createAgent(authenticated: boolean): { agent: ClaudeCodeAgent; getState: ReturnType<typeof vi.fn> } {
  const getState = vi.fn(async () => (authenticated ? { authenticated: true } : { authenticated: false }));
  const auth: AuthAdapter = {
    getState,
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  const deps: AgentDeps = {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
  return { agent: new ClaudeCodeAgent(deps), getState };
}

function fakeQuery(supportedModels: () => Promise<unknown[]>) {
  return { supportedModels: vi.fn(supportedModels), close: vi.fn() };
}

afterEach(() => {
  setClaudeSupportedModelsListener(null);
  sdkMock.query.mockReset();
});

describe('ClaudeCodeAgent.refreshLocalModels(主动读取订阅模型清单)', () => {
  it('用订阅登录起空闲 Query 只读 supportedModels,交给 host 后关闭,不发送任何消息', async () => {
    const listener = vi.fn();
    setClaudeSupportedModelsListener(listener);
    const models = [{ value: 'claude-fable-5-1', displayName: 'Fable' }];
    const q = fakeQuery(async () => models);
    sdkMock.query.mockReturnValue(q);
    const { agent, getState } = createAgent(true);

    await expect(agent.refreshLocalModels()).resolves.toBe(true);

    expect(getState).toHaveBeenCalledWith({ credentialMode: 'oauth-bearer' });
    expect(listener).toHaveBeenCalledWith(models);
    expect(q.close).toHaveBeenCalledTimes(1);
    const [{ prompt, options }] = sdkMock.query.mock.calls[0] as [
      { prompt: AsyncIterable<unknown>; options: Record<string, unknown> },
    ];
    expect(options.pathToClaudeCodeExecutable).toBe(process.execPath);
    // 输入队列在探测结束时关闭且从未写入:没有任何用户消息发往模型。
    const received: unknown[] = [];
    for await (const item of prompt) received.push(item);
    expect(received).toEqual([]);
  });

  it('未登录订阅或 host 未接监听器时不起 CLI', async () => {
    const { agent: unauthed } = createAgent(false);
    setClaudeSupportedModelsListener(vi.fn());
    await expect(unauthed.refreshLocalModels()).resolves.toBe(false);

    setClaudeSupportedModelsListener(null);
    const { agent: noListener } = createAgent(true);
    await expect(noListener.refreshLocalModels()).resolves.toBe(false);

    expect(sdkMock.query).not.toHaveBeenCalled();
  });

  it('调用方传入 onSupportedModels 时结果只交给它,不经全局监听器', async () => {
    const listener = vi.fn();
    setClaudeSupportedModelsListener(listener);
    const models = [{ value: 'sonnet', displayName: 'Sonnet' }];
    sdkMock.query.mockReturnValue(fakeQuery(async () => models));
    const { agent } = createAgent(true);
    const onSupportedModels = vi.fn();

    await expect(agent.refreshLocalModels({ onSupportedModels })).resolves.toBe(true);
    expect(onSupportedModels).toHaveBeenCalledWith(models);
    expect(listener).not.toHaveBeenCalled();
  });

  it('在新建的空目录里启动,结束后删除该目录', async () => {
    setClaudeSupportedModelsListener(vi.fn());
    sdkMock.query.mockReturnValue(fakeQuery(async () => []));
    const { agent } = createAgent(true);

    await agent.refreshLocalModels();
    const [{ options }] = sdkMock.query.mock.calls[0] as [{ options: { cwd: string } }];
    expect(path.dirname(options.cwd)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(options.cwd)).toMatch(/^cindy-claude-models-/);
    await expect(fs.access(options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('启动阶段失败(读取登录态出错)返回 false 而不是抛错', async () => {
    setClaudeSupportedModelsListener(vi.fn());
    const { agent, getState } = createAgent(true);
    getState.mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(agent.refreshLocalModels()).resolves.toBe(false);
    expect(sdkMock.query).not.toHaveBeenCalled();
  });

  it('读取失败返回 false 并仍关闭 Query', async () => {
    const listener = vi.fn();
    setClaudeSupportedModelsListener(listener);
    const q = fakeQuery(async () => {
      throw new Error('cli exited');
    });
    sdkMock.query.mockReturnValue(q);
    const { agent } = createAgent(true);

    await expect(agent.refreshLocalModels()).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
