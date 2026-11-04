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
 *  - turn 已被 translator 正常收尾后流崩溃（事故原型）→ 不双发 done,
 *    空闲态崩溃不再上报终态错误 (#8831)
 *  - 成功轮次完成后进程被外部强杀（#8831 退出时 reap-claude-children 原型）
 *    → 无终态错误、无额外 done, 只回收死句柄
 *  - 续跑终态已入队未派发时流崩溃 → 不补发同一轮的第二个 done / error
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

async function startCrashableSession(opts?: { collect?: boolean }) {
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

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-crash',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  // 先起 collector 再触发流事件：eventQueue 被 end 后迭代自然结束。
  // collect:false 时把消费节奏交给测试 —— 需要把事件留在「已入队未派发」窗口的
  // 用例(续跑终态在途时进程死亡)必须自己驱动 handle.events() 迭代器。
  const events: AgentEvent[] = [];
  const collected = opts?.collect === false
    ? Promise.resolve()
    : (async () => {
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
  it('mid-turn stream crash tears the handle down with a full failure tail', async () => {
    const { handle, stream, events, collected } = await startCrashableSession();

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

    // 轮次已收尾后进程死亡不再有终态错误上报（#8831: 空闲会话被强杀时派发
    // sdk_stream_crashed 会落伪造的 role:'error' 记录, 重启误读成「上轮未完成」）。
    // 轮次自身的失败事件由 translator 在 result 阶段已派发, 不随崩溃重复。
    expect(
      events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'sdk_stream_crashed'),
    ).toBe(false);

    // handle 死透, 不再吞消息。
    await expect(handle.send({ type: 'user', content: 'follow-up' })).rejects.toThrow(/input queue is closed/i);
  });

  it('idle process kill after a completed turn emits no terminal error (#8831)', async () => {
    const { handle, stream, events, collected } = await startCrashableSession();

    await handle.send({ type: 'user', content: 'hello' });

    // #8831 事故原型: 轮次正常完成后 claude.exe 驻留; 退出 Cindy 时
    // reap-claude-children 把空闲进程 taskkill, SDK 流抛错。
    stream.emit({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    stream.fail(new Error('Claude Code process exited with code 1'));
    await withTimeout(collected, 'event stream should end after idle kill teardown');

    // 没有任何轮次可被终结: 不得派发终态错误(否则落库成伪造的「上轮失败」记录)。
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0]?.data as { reason?: string }).reason).not.toBe('sdk_stream_crashed');

    // handle 死透: 事件流已结束, 后续 send 立刻失败而不是进黑洞排队。
    expect(handle.isTurnRunning?.()).toBe(false);
    await expect(handle.send({ type: 'user', content: 'follow-up' })).rejects.toThrow(/input queue is closed/i);
  });

  it('does not re-emit a queued continuation terminal when the stream dies mid-dispatch', async () => {
    // PR#8843 复核: 续跑取消边界(turn_continuation_cancelled)已入队、Session
    // 尚未消费时, pendingContinuationTerminalBoundaries > 0 会让 busy 判据
    // 把轮次误当「仍在执行」, emitTurnBoundary 补发同一轮的第二个 done →
    // 监听方与 onTerminal 收两次结束通知。最小失败输入: 后台 wake 任务 +
    // result 铸 awaiting claim + task_notification(stopped) 推取消边界 +
    // 消费停在该 done 处 + 流崩溃。
    const { handle, stream } = await startCrashableSession({ collect: false });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    const pullNext = async (): Promise<boolean> => {
      const step = await iterator.next();
      if (step.done) return true;
      events.push(step.value);
      return false;
    };

    await handle.send({ type: 'user', content: 'kick off background work' });
    stream.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg-1',
      task_type: 'local_agent',
      tool_use_id: 'toolu-bg',
      description: 'background work',
    });
    // 本轮收尾: done 铸 awaiting continuation claim(后台 wake 任务仍 running)。
    stream.emit({
      type: 'result',
      is_error: false,
      subtype: 'success',
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    // 后台任务停止 → 取消续跑 → 同步推入 turn_continuation_cancelled 终态边界。
    stream.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bg-1',
      status: 'stopped',
    });

    // 消费到第二个 done(取消边界)为止并停住: 终态留在「已入队未派发」窗口
    // (生成器挂在 yield 处, releaseEventAccounting 尚未跑, pending 仍为 1)。
    while (events.filter((e) => e.type === 'done').length < 2) {
      if (await pullNext()) throw new Error('stream ended before cancelled-continuation done');
    }
    expect(handle.isTurnRunning?.()).toBe(true);

    // 进程此刻被杀: 终态已在路上,不得再补 error/done。
    stream.fail(new Error('Claude Code process exited with code 1'));
    // 先让 crash 分支在「boundary 未派发」窗口内完成快照,再恢复消费 —— 下一次
    // pull 会触发 releaseEventAccounting 把 pending 清零,次序颠倒就变成另一个
    // 交错(等价于终态已交付后崩溃)。
    await new Promise((r) => setTimeout(r, 0));
    await withTimeout(
      (async () => {
        while (!(await pullNext())) { /* drain teardown tail */ }
      })(),
      'event stream should end after mid-dispatch crash teardown',
    );

    expect(events.filter((e) => e.type === 'done')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(handle.isTurnRunning?.()).toBe(false);
    // 取消边界的 query 重建 tombstone 让下一次 send 走替换-query 受理路径 —
    // 断言它确实被受理(而非吞进死队列),验证崩溃收尾没有留下不可恢复状态。
    await handle.send({ type: 'user', content: 'follow-up' });
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
