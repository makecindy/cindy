/**
 * turnState.turnStartModel 快照时机回归测试。
 *
 * 背景（PR review P2）:beginNewTurn() 在 send() 的 `await toClaudeSdkContent(...)`
 * 之前打第一次快照；多模态内容转换（图片 resize）可异步等数百毫秒~几秒，这段空窗内
 * runtimeSetModel 仍可通过 q.setModel() 热切模型——实际发出的请求会用新模型，但那次
 * 快照仍是旧模型。若该请求随后以无 envelope 的 api_retry 终止，translator 会用错误的
 * turnStartModel 判定 bridge 来源，导致计费归因判断到错误模型。
 *
 * 修复：在真正 inputQueue.push(sdkInput)（内容转换已完成、请求已确定）之前重新打一次
 * 快照，覆盖掉可能过期的 beginNewTurn 时刻旧值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { ModelDescriptor } from '../../../types/capabilities.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

const imageResizerMock = vi.hoisted(() => ({
  process: vi.fn(async (p: string) => p),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => imageResizerMock,
}));

import { ClaudeCodeAgent } from '../index.js';

const TEST_MODELS: ModelDescriptor[] = [
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
];

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

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };

  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

/** 可控挂起流：默认不吐消息；测试可按需 emit SDK 消息喂给 forward loop。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void } | null = null;
  let ended = false;

  function pump(): void {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
      return;
    }
    if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  }

  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            waiter = { resolve };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(stream = createControlledStream()) {
  return {
    stream,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    rewindFiles: vi.fn(async () => ({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })),
  };
}

const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  imageResizerMock.process.mockReset();
  imageResizerMock.process.mockImplementation(async (p: string) => p);
  if (originalIdleTimeout === undefined) {
    delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  } else {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  }
});

describe('turnState.turnStartModel snapshot timing (no rewind)', () => {
  it('re-snapshots the model right before enqueue, picking up a hot-switch made during async image resize', async () => {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const agent = new ClaudeCodeAgent({
      ...createDeps(),
      capabilityAdditions: { availableModels: TEST_MODELS },
    });
    const handle = await agent.startSession({
      sessionId: 'session-turn-start-model',
      model: 'claude-opus-4-6',
      workingDir: '/tmp',
      permissionMode: 'acceptEdits',
    });

    const events: AgentEvent[] = [];
    void (async () => {
      try {
        for await (const ev of handle.events()) events.push(ev);
      } catch {
        /* ignore */
      }
    })();

    // 图片 resize 挂起 —— 制造 beginNewTurn() 与真正 inputQueue.push 之间的异步空窗。
    let resolveResize!: (p: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveResize = resolve; }),
    );
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: '/tmp/slow.png' }],
    });

    // 空窗期内热切模型 —— 这次请求最终应该用新模型发出。
    await vi.waitFor(() => {
      expect(imageResizerMock.process).toHaveBeenCalled();
    });
    await handle.setModel?.('claude-sonnet-5');

    resolveResize('/tmp/slow.png');
    await sendPromise;

    // 无 assistant envelope 的连接失败:先 api_retry 耗尽重试,再 is_error 终态。
    firstQuery.stream.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: null,
      error: 'unknown',
    });
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
    const error = events.find((e) => e.type === 'error');
    // 归因必须是热切之后的新模型,而不是 beginNewTurn() 时刻的旧模型——否则
    // register.ts 会用错误的模型判定 bridge 来源(PR review P2)。
    expect(error?.agentMeta).toMatchObject({ model: 'claude-sonnet-5' });

    await handle.close();
  });

  it('does not let a post-dispatch setModel change the attribution before the first api_retry ever arrives', async () => {
    // q.setModel() 改不了已经发出的旧请求;send() resolve 时消息已经真正入队
    // (真实网络请求已经用旧模型发出),哪怕这之后、第一条 api_retry 到达之前
    // 就热切模型,turnStartModel 也不该被这次热切覆盖——index.ts 不再尝试在
    // setModel 里同步刷新它,因为无法区分"热切影响的是尚未发出的下一次调用"
    // 还是"影响的是已经发出、正在无 envelope 重试的这一次调用"(PR review P2 ×4)。
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const agent = new ClaudeCodeAgent({
      ...createDeps(),
      capabilityAdditions: { availableModels: TEST_MODELS },
    });
    const handle = await agent.startSession({
      sessionId: 'session-post-dispatch-model-switch',
      model: 'claude-opus-4-6',
      workingDir: '/tmp',
      permissionMode: 'acceptEdits',
    });

    const events: AgentEvent[] = [];
    void (async () => {
      try {
        for await (const ev of handle.events()) events.push(ev);
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hello' });
    // send() 已 resolve(消息已入队、请求已用旧模型发出),第一条 api_retry
    // 到达前热切模型。
    await handle.setModel?.('claude-sonnet-5');

    // 无 assistant envelope 的连接失败:先 api_retry 耗尽重试,再 is_error 终态。
    firstQuery.stream.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: null,
      error: 'unknown',
    });
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
    const error = events.find((e) => e.type === 'error');
    // 归因必须保持请求实际发出时用的旧模型,不能被之后的热切覆盖。
    expect(error?.agentMeta).toMatchObject({ model: 'claude-opus-4-6' });

    await handle.close();
  });

  it('does not guess an attribution for a no-envelope failure past the first API call of the turn', async () => {
    // apiCalls > 0 说明本 turn 已经有至少一次 API call 成功推进到过
    // message_start——之后工具调用触发的下一次 API call 没有等效 beginNewTurn
    // 的 dispatch 边界可以挂快照,turnStartModel 只反映 turn 起点那一次调用。
    // 没有可靠信号时宁可不归因,也不能拿 turn 起点的旧快照去猜(PR review P2 ×4)。
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const agent = new ClaudeCodeAgent({
      ...createDeps(),
      capabilityAdditions: { availableModels: TEST_MODELS },
    });
    const handle = await agent.startSession({
      sessionId: 'session-mid-turn-no-envelope-no-guess',
      model: 'claude-opus-4-6',
      workingDir: '/tmp',
      permissionMode: 'acceptEdits',
    });

    const events: AgentEvent[] = [];
    void (async () => {
      try {
        for await (const ev of handle.events()) events.push(ev);
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hello' });

    // 第一次 API call 成功推进到 message_start(apiCalls 变成 1),随后工具调用
    // 触发的下一次 API call 以无 envelope 的 api_retry 终止。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { model: 'claude-opus-4-6', usage: { input_tokens: 10 } } },
    });
    firstQuery.stream.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: null,
      error: 'unknown',
    });
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
    const error = events.find((e) => e.type === 'error');
    // 没有可靠信号时不归因,不能猜成 turn 起点的旧模型。
    expect(error?.agentMeta?.model).toBeUndefined();

    await handle.close();
  });

  it('does not let a mid-turn setModel overwrite the attribution of a request already retrying without envelope', async () => {
    // q.setModel() 改不了已经发出、正在无 envelope 重试的旧请求——它只能影响
    // 尚未发出的下一次 API call。若旧请求的第一条 api_retry 已经到达(说明它
    // 已经在网络层失败过至少一次,turnState.pendingApiError 非空),此时再热切
    // 模型不应该覆盖这次失败最终的归因,否则 register.ts 会把旧请求的失败错误
    // 挂到切换后的新模型上(PR review P2 ×2)。
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const agent = new ClaudeCodeAgent({
      ...createDeps(),
      capabilityAdditions: { availableModels: TEST_MODELS },
    });
    const handle = await agent.startSession({
      sessionId: 'session-in-flight-retry-not-overwritten',
      model: 'claude-opus-4-6',
      workingDir: '/tmp',
      permissionMode: 'acceptEdits',
    });

    const events: AgentEvent[] = [];
    void (async () => {
      try {
        for await (const ev of handle.events()) events.push(ev);
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hello' });

    // 旧请求(model A)已经在网络层失败过一次,进入无 envelope 的重试序列。
    firstQuery.stream.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: null,
      error: 'unknown',
    });

    // 用户在这条重试序列尚未收口期间热切模型——不该追溯改写它的归因。
    await handle.setModel?.('claude-sonnet-5');

    firstQuery.stream.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 3,
      retry_delay_ms: 1_000,
      error_status: null,
      error: 'unknown',
    });
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
    const error = events.find((e) => e.type === 'error');
    // 归因必须保持旧模型(请求实际发出时用的模型),不能被之后的热切覆盖。
    expect(error?.agentMeta).toMatchObject({ model: 'claude-opus-4-6' });

    await handle.close();
  });
});
