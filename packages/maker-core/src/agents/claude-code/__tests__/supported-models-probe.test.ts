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
import { OneShotError } from '../../base-agent.js';

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
  vi.unstubAllEnvs();
  setClaudeSupportedModelsListener(null);
  sdkMock.query.mockReset();
});

describe('ClaudeCodeAgent.refreshLocalModels(主动读取订阅模型清单)', () => {
  it('用订阅登录起空闲 Query 只读 supportedModels,交给 host 后关闭,不发送任何消息', async () => {
    vi.stubEnv('DISABLE_TELEMETRY', undefined);
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
    expect((options.env as Record<string, string>).DISABLE_TELEMETRY).toBeUndefined();
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
    const failure = new Error('Connection error');
    const q = fakeQuery(async () => { throw failure; });
    sdkMock.query.mockReturnValue(q);
    const { agent } = createAgent(true);

    await expect(agent.refreshLocalModels()).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(q.close).toHaveBeenCalledTimes(1);
    // Unit #11880: hosts need the original failure to classify it; legacy callers keep false.
    await expect(agent.refreshLocalModels({ throwOnError: true })).rejects.toBe(failure);
    expect(q.close).toHaveBeenCalledTimes(2);
  });
});

// 测试价值:伙伴语音通话选 Claude 订阅时,回复只能由 Claude Code CLI 用自己的登录作答
// (Cindy 不经手订阅凭证)。经公开入口 nativeSubscriptionText 断言:CLI 在空目录里无工具、
// 无设置、无 MCP、不落盘地跑一轮,流式文本与最终结果交回调用方;未登录或派发守卫拒绝时
// 不起 CLI;CLI 报错结果映射为 OneShotError。unit:SDK query 为内存 fake。
function fakeTextQuery(messages: unknown[]) {
  return Object.assign((async function* () { yield* messages; })(), { close: vi.fn() });
}

describe('ClaudeCodeAgent.nativeSubscriptionText(订阅登录的无状态文本请求)', () => {
  it('隔离运行一轮:无工具/设置/MCP/会话落盘,流式文本与结果交回,结束后清理', async () => {
    const q = fakeTextQuery([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"say":' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '"hi"}' } } },
      { type: 'result', subtype: 'success', is_error: false, result: ' {"say":"hi"} ' },
    ]);
    sdkMock.query.mockReturnValue(q);
    const { agent, getState } = createAgent(true);
    const onText = vi.fn();
    const beforeDispatch = vi.fn(async () => true);

    await expect(agent.nativeSubscriptionText('user words', {
      model: 'claude-opus-4-5', systemPrompt: 'call rules', disableReasoning: true, onText, beforeDispatch,
    })).resolves.toBe('{"say":"hi"}');

    expect(getState).toHaveBeenCalledWith({ credentialMode: 'oauth-bearer' });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['{"say":', '{"say":"hi"}']);
    const [{ prompt, options }] = sdkMock.query.mock.calls[0] as [{ prompt: string; options: Record<string, unknown> }];
    expect(prompt).toBe('user words');
    expect(options).toMatchObject({
      model: 'claude-opus-4-5',
      systemPrompt: 'call rules',
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      includePartialMessages: true,
      thinking: { type: 'disabled' },
      pathToClaudeCodeExecutable: process.execPath,
    });
    expect(path.basename(options.cwd as string)).toMatch(/^cindy-claude-text-/);
    await expect(fs.access(options.cwd as string)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(q.close).toHaveBeenCalledTimes(1);
  });

  it('未登录订阅或派发守卫拒绝时不起 CLI', async () => {
    const { agent: unauthed } = createAgent(false);
    await expect(unauthed.nativeSubscriptionText('x', { model: 'claude-opus-4-5' }))
      .rejects.toMatchObject({ name: 'OneShotError', reason: 'auth' });

    const { agent } = createAgent(true);
    await expect(agent.nativeSubscriptionText('x', { model: 'claude-opus-4-5', beforeDispatch: async () => false }))
      .rejects.toBeInstanceOf(OneShotError);

    expect(sdkMock.query).not.toHaveBeenCalled();
  });

  it('CLI 以错误结果结束时抛 OneShotError,不返回空文本', async () => {
    const q = fakeTextQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true }]);
    sdkMock.query.mockReturnValue(q);
    const { agent } = createAgent(true);

    await expect(agent.nativeSubscriptionText('x', { model: 'claude-opus-4-5' }))
      .rejects.toMatchObject({ name: 'OneShotError', reason: 'network' });
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
