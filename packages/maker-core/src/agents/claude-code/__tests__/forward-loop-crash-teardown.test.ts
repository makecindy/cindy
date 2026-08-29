/**
 * Claude Code forward loop 崩溃收尾（teardownDeadHandle）单测。
 *
 * 背景（2026-07-05 fork resume 失败实踩）：SDK 流抛错（典型：resume 找不到会话时
 * CLI 先吐 is_error result 再以非零码退出，SDK 把 exit error 替换成
 * "Claude Code returned an error result: ..." 抛进消息流）后，旧实现的 crash 分支
 * 只推 error + 清 turnInFlight，不置 closed / 不 end inputQueue / 不关 eventQueue，
 * 导致死 handle 对外装活：下次 send 把消息 push 进无消费者的 inputQueue 黑洞，
 * 用户看到"排队但无运行态、无法停止"。
 *
 * 覆盖:
 *  - turn 进行中流崩溃 → error(sdk_stream_crashed) + status Done + done 收尾,
 *    事件流结束, 后续 send 报 input queue closed
 *  - turn 已被 translator 正常收尾后流崩溃（事故原型）→ 不双发 done, 事件流结束
 *  - 流自然结束（U2 远端 daemon 突死路径）→ 行为回归不变（helper 重构等价性）
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

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
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
    ...overrides,
  };
}

/**
 * 可控 SDK 消息流：测试侧随时 emit 消息 / fail 抛错 / end 自然结束，
 * 模拟 CLI 子进程的三种退出形态。
 */
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-crash-'));
  tempDirs.push(dir);
  return dir;
}

async function startCrashableSession(depOverrides: Partial<AgentDeps> = {}) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const stream = createControlledStream();
  const fakeQuery = createFakeQuery(stream);
  // 真实 SDK 会拿 prompt (inputQueue) 作为 AsyncIterable 自己消费; fake 不接手
  // 消费的话, forward loop 的 pending-turn 判定 (onTurnEnd 检查 inputQueue.pending)
  // 会一直看到未被 shift 走的排队消息, 误以为还有下一 turn。启动一个 fire-and-forget
  // consumer 与真实 SDK 语义对齐: 用户 send 的消息 push 后立即被 drain, pending 归 0。
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

  const agent = new ClaudeCodeAgent(createDeps(depOverrides));
  const handle = await agent.startSession({
    sessionId: 'session-crash',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  // 先起 collector 再触发流事件：eventQueue 被 end 后迭代自然结束。
  const events: AgentEvent[] = [];
  const collected = (async () => {
    for await (const ev of handle.events()) {
      events.push(ev);
    }
  })();

  return { agent, handle, stream, fakeQuery, events, collected };
}

/** 带超时的等待：事件流没按预期结束时给出可读失败而不是挂死测试。 */
async function withTimeout(p: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    p,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${label}`)), 2000);
    }),
  ]);
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

describe('ClaudeCodeAgent forward loop crash teardown', () => {
  it('revokes proxy auth when query construction fails before a handle is returned', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const disposeProxySession = vi.fn();
    sdkMock.query.mockImplementation(() => {
      throw new Error('query startup failed');
    });
    const agent = new ClaudeCodeAgent(createDeps({
      getClaudeProxySessionAuth: () => ({
        sessionId: 'session-startup-failure',
        token: 'proxy-token',
        dispose: disposeProxySession,
      }),
    }));

    await expect(agent.startSession({
      sessionId: 'session-startup-failure',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
    })).rejects.toThrow('query startup failed');

    expect(disposeProxySession).toHaveBeenCalledTimes(1);
  });

  it('mid-turn stream crash tears the handle down with a full failure tail', async () => {
    const disposeProxySession = vi.fn();
    const { handle, stream, events, collected } = await startCrashableSession({
      getClaudeProxySessionAuth: () => ({
        sessionId: 'session-crash',
        token: 'proxy-token',
        dispose: disposeProxySession,
      }),
    });

    await handle.send({ type: 'user', content: 'hello' });
    expect(handle.isTurnRunning?.()).toBe(true);

    stream.fail(new Error('Claude Code returned an error result: No conversation found with session ID: dead-beef'));
    await withTimeout(collected, 'event stream should end after crash teardown');

    const errIdx = events.findIndex(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'sdk_stream_crashed',
    );
    expect(errIdx, 'crash must surface a structured terminal error').toBeGreaterThanOrEqual(0);
    expect(events[errIdx]?.data).toMatchObject({ isTerminal: true });
    expect((events[errIdx]?.data as { message: string }).message).toContain('No conversation found');

    // 与 translator 失败序列同构的收尾: error → status(isRunning=false) → done。
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.data).toMatchObject({ reason: 'sdk_stream_crashed' });
    const endStatusIdx = events.findIndex(
      (e, i) => i > errIdx && e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    );
    expect(endStatusIdx, 'running state must be closed out').toBeGreaterThan(errIdx);
    expect(events.findIndex((e) => e.type === 'done')).toBeGreaterThan(endStatusIdx);

    // handle 死透: turn 不再 in-flight, 后续 send 立刻失败而不是进黑洞排队。
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(disposeProxySession).toHaveBeenCalledTimes(1);
    await expect(handle.send({ type: 'user', content: 'are you there?' })).rejects.toThrow(
      /input queue is closed/i,
    );
  });

  it('stream crash after a translator-finalized turn does not double-emit done (incident shape)', async () => {
    const { handle, stream, events, collected } = await startCrashableSession();

    await handle.send({ type: 'user', content: 'hello' });

    // 事故原型: CLI 先吐 is_error result(translator 正常收尾), 再进程退出让流抛错。
    stream.emit({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    stream.fail(new Error('Claude Code returned an error result: No conversation found with session ID: dead-beef'));
    await withTimeout(collected, 'event stream should end after post-turn crash teardown');

    // translator 已发过 done, crash 分支不得再补一个（记账/通知链路只认一次终止）。
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0]?.data as { reason?: string }).reason).not.toBe('sdk_stream_crashed');

    // 崩溃本身仍要结构化上报。
    expect(
      events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'sdk_stream_crashed'),
    ).toBe(true);

    // handle 死透, 不再吞消息。
    await expect(handle.send({ type: 'user', content: 'follow-up' })).rejects.toThrow(/input queue is closed/i);
  });

  it('natural stream end without result keeps the U2 remote-daemon teardown behavior', async () => {
    const { handle, stream, events, collected } = await startCrashableSession();

    await handle.send({ type: 'user', content: 'hello' });
    stream.end();
    await withTimeout(collected, 'event stream should end after U2 teardown');

    expect(
      events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'remote_daemon_closed'),
    ).toBe(true);
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]?.data).toMatchObject({ reason: 'remote_daemon_closed' });
    await expect(handle.send({ type: 'user', content: 'follow-up' })).rejects.toThrow(/input queue is closed/i);
  });
});
