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
});
