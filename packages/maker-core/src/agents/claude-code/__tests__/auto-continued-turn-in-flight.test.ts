/**
 * 自动续跑 turn 的 in-flight 补登记回归测试。
 *
 * 背景(2026-07-14 实踩,会话 0686cfa0):agent 在 turn 内派出后台 subagent
 * (Agent tool run_in_background)时,主 turn 先收 done(turnInFlight 清 false),
 * subagent 完成后 SDK 经 task_notification **自动续跑新 turn,不经过 handle.send**,
 * turnInFlight 停留在 false → isTurnRunning() 误报空闲 → session.send 的
 * SESSION_RUNNING 守卫失守,scheduler 心跳把 prompt 直接注入了运行中的 turn。
 *
 * 覆盖:
 *  - 无 send 的 assistant 消息(自动续跑证据)→ isTurnRunning 翻 true
 *  - 续跑 turn 的 result → isTurnRunning 回 false(既有清理路径不回归)
 *  - watchdog/tool-loop interrupt 后的残留 assistant 消息 → **不**触发补登记
 *    (否则 beginNewTurn 的 generation++ 会吞掉 interrupted result 的终态)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';
import { Session } from '../../../session.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

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

/** 可控 SDK 消息流(与 forward-loop-crash-teardown.test.ts 同款 harness)。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  let ended = false;
  let failure: unknown = null;

  function pump(): void {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
    } else if (failure !== null) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    } else if (ended) {
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
    fail(err: unknown): void {
      failure = err;
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(stream: ReturnType<typeof createControlledStream>) {
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-autoturn-'));
  tempDirs.push(dir);
  return dir;
}

async function startSessionWithStream(throughSession = false) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const stream = createControlledStream();
  const fakeQuery = createFakeQuery(stream);
  sdkMock.query.mockImplementation((options: unknown) => {
    const prompt = (options as { prompt?: AsyncIterable<unknown> } | undefined)?.prompt;
    if (prompt) {
      void (async () => {
        try {
          for await (const _ of prompt) { /* discard — 只对齐 pending 语义 */ }
        } catch { /* end / abort 都算正常收尾 */ }
      })();
    }
    return fakeQuery;
  });

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-auto-turn',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  const events: AgentEvent[] = [];
  const session = throughSession ? new Session({
    id: 'session-auto-turn', agentKind: 'claude-code', workDir: workingDir,
    handle, capabilities: {} as never, logger: createNoopLogger(),
  }) : undefined;
  session?.onEvent((event) => events.push(event));
  const collected = session ? Promise.resolve() : (async () => {
    for await (const ev of handle.events()) {
      events.push(ev);
    }
  })();

  return { agent, handle, stream, fakeQuery, events, collected, session };
}

function successResult(): Record<string, unknown> {
  return {
    type: 'result',
    is_error: false,
    subtype: 'success',
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function assistantText(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/** 等待条件成立(事件经 AsyncQueue 异步 fan-out,不能同步断言)。 */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent auto-continued turn in-flight tracking', () => {
  // Regression: SDK -> Session must deliver a zero-output wake failure to the
  // host, with its quota deadline. Existing tests only observed the raw handle
  // or woke the Session with text first. Unit tier; no network/model requests.
  it('delivers a quota failure and reset deadline when an automatic turn produces no text', async () => {
    const { session, stream, events } = await startSessionWithStream(true);
    const resetAtSec = Math.floor(Date.now() / 1000) + 3600;
    const message = "You've reached your Fable limit. Switch to another model to continue.";
    try {
      await session!.send('kick off background work');
      stream.emit(successResult());
      await waitFor(() => events.some(e => e.type === 'done'), 'initial success');
      events.length = 0;
      stream.emit({ type: 'rate_limit_event', rate_limit_info: {
        status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: resetAtSec,
      } });
      stream.emit({ ...assistantText(message), error: 'rate_limit' });
      stream.emit({ ...successResult(), is_error: true, terminal_reason: 'api_error', result: message });
      await waitFor(() => events.some(e => e.type === 'done'), 'quota turn done');
      expect(events.filter(e => e.type === 'error').map(e => e.data)).toEqual([
        expect.objectContaining({ message, sdkError: 'rate_limit', isTerminal: true,
          usageResetAt: resetAtSec * 1000 }),
      ]);
      expect(events.some(e => e.type === 'text')).toBe(false);
    } finally {
      stream.end();
      await session!.close();
    }
  });

  it('marks the turn in-flight when assistant activity arrives without a send, and clears on result', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    // 常规 turn:send → in-flight → result → idle(基线不回归)。
    await handle.send({ type: 'user', content: 'kick off background work' });
    expect(handle.isTurnRunning?.()).toBe(true);
    stream.emit(successResult());
    await waitFor(() => events.some((e) => e.type === 'done'), 'first turn done');
    expect(handle.isTurnRunning?.()).toBe(false);

    // 自动续跑:SDK 直接推 assistant 消息,没有任何 send。
    stream.emit(assistantText('background task finished, continuing'));
    await waitFor(() => handle.isTurnRunning?.() === true, 'auto-continued turn marked in-flight');

    // in-flight 期间 send 必须被 Session 层的 SESSION_RUNNING 守卫看见 —— 这里只
    // 验证 handle 层事实(isTurnRunning=true);Session 守卫读的就是它。

    // 续跑 turn 结束 → 既有清理路径把 in-flight 清回 false。
    stream.emit(successResult());
    await waitFor(() => handle.isTurnRunning?.() === false, 'auto-continued turn cleared on result');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('does not re-arm in-flight for residual assistant messages after a watchdog interrupt', async () => {
    // upstream-idle watchdog 是唯一"先清 turnInFlight、再置 interruptRequested、
    // interrupt 后仍可能 drain 出残留 assistant 消息"的路径 —— 补登记若不排除
    // interruptRequested,beginNewTurn 的 generation++ 会吞掉 interrupted result。
    const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '80';
    try {
      const { handle, stream, events, fakeQuery } = await startSessionWithStream();

      await handle.send({ type: 'user', content: 'long turn' });
      expect(handle.isTurnRunning?.()).toBe(true);

      // 上游静默 80ms → watchdog 触发:turnInFlight=false + interruptRequested=true。
      await waitFor(() => fakeQuery.interrupt.mock.calls.length > 0, 'watchdog interrupt fires');
      expect(handle.isTurnRunning?.()).toBe(false);

      // SDK 残留的 assistant 消息随后 drain 出来 —— 不得触发补登记。
      stream.emit(assistantText('late residual output'));
      await new Promise((r) => setTimeout(r, 100));
      expect(handle.isTurnRunning?.()).toBe(false);

      // interrupted result 正常被消费(终态不被 generation++ 吞掉)。
      stream.emit({
        type: 'result',
        is_error: true,
        subtype: 'error_during_execution',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      await waitFor(
        () => events.some((e) => e.type === 'done' || (e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal)),
        'interrupted turn reaches a terminal event',
      );
      expect(handle.isTurnRunning?.()).toBe(false);

      stream.end();
      await handle.close().catch(() => undefined);
    } finally {
      if (originalIdleTimeout === undefined) delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
      else process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
  });
});
