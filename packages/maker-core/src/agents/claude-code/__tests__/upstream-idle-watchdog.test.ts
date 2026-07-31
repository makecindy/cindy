/**
 * upstream-response-idle 看门狗的挂起感知回归测试(#1015,分层自愈不变量第 6 处)。
 *
 * 背景:PR #944 确立「壁钟差 ≠ 清醒时间」——系统挂起(合盖睡眠)期间进程被冻结,
 * 裸 setTimeout 在唤醒后立刻到期,会把一条其实还健康的 turn 判死。前 5 处已按
 * 分片计时修复,claude-code 的 armUpstreamResponseIdle 是漏下的第 6 处:合盖
 * 40 分钟再打开,SDK 连接其实还活着,旧实现的 30min 裸定时器却立刻开火,推
 * upstream_response_idle_timeout 终态 error 并 interrupt 一条健康 turn。
 *
 * 覆盖(假时钟 + 可控 SDK 流):
 *  - 正常清醒静默满阈值 → 开火(interrupt + 终态 error);
 *  - 系统挂起 8 小时 → 不开火(该片作废、额度重开);随后清醒走满仍开火
 *    (吸收不等于豁免);
 *  - 工具执行期间(pendingToolIds 非空)→ 停表不开火;tool_result 配对完
 *    重新起表、走满开火;
 *  - turn 正常结束 → 清表,不再开火。
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
const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

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

/** 可控 SDK 消息流(与 auto-continued-turn-in-flight.test.ts 同款 harness)。 */
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-idle-watchdog-'));
  tempDirs.push(dir);
  return dir;
}

async function startSessionWithStream() {
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
    sessionId: 'session-idle-watchdog',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  const events: AgentEvent[] = [];
  const collected = (async () => {
    for await (const ev of handle.events()) {
      events.push(ev);
    }
  })();

  return { agent, handle, stream, fakeQuery, events, collected };
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

function assistantToolUse(id: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 999' } }],
    },
  };
}

function userToolResult(id: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }],
    },
  };
}

/** 假时钟下的条件等待:每步推 1ms 假时间并排空微任务(累计消耗可忽略)。 */
async function pumpUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error(`timed out: ${label}`);
}

function idleTimeoutError(events: AgentEvent[]): AgentEvent | undefined {
  return events.find(
    (e) =>
      e.type === 'error' &&
      (e.data as Record<string, unknown> | undefined)?.reason === 'upstream_response_idle_timeout',
  );
}

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  if (originalIdleTimeout === undefined) {
    delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  } else {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('upstream-response-idle watchdog suspend awareness', () => {
  it('清醒静默满阈值 → 开火;系统挂起 8 小时 → 不开火,随后清醒走满仍开火', async () => {
    // 150s = 60s + 60s + 30s 三个分片,覆盖"满片消耗"与"尾片短于片长"两种形态。
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '150000';
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await handle.send({ type: 'user', content: 'long silent turn' });
    expect(handle.isTurnRunning?.()).toBe(true);

    // 模拟合盖 8 小时:壁钟猛跳但定时器只"走"一个分片 —— 片尾发现真实耗时远超
    // 片长,判为被冻结,该片作废、完整重判(不开火、额度重开)。
    vi.setSystemTime(Date.now() + 8 * 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idleTimeoutError(events)).toBeUndefined();
    expect(fakeQuery.interrupt).not.toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(true);

    // 吸收不等于豁免:醒来后清醒地连续静默满 150s(60+60+30)→ 仍然开火。
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idleTimeoutError(events)).toBeUndefined(); // 120s < 150s,还差尾片
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpUntil(() => idleTimeoutError(events) !== undefined, 'watchdog fired after awake quota');
    expect(fakeQuery.interrupt).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    vi.useRealTimers();
    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('工具执行期间停表不开火;tool_result 配对完重新起表、走满才开火', async () => {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '120000';
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await handle.send({ type: 'user', content: 'run a long tool' });

    // assistant 发起 tool_use → ball 交回客户端,watchdog 停表。
    stream.emit(assistantToolUse('toolu_long'));
    await vi.advanceTimersByTimeAsync(5);
    // 远超阈值的工具执行(20 分钟)也不开火。
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(idleTimeoutError(events)).toBeUndefined();
    expect(fakeQuery.interrupt).not.toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(true);

    // tool_result 配对完 → ball 回上游,立即重新起表(完整额度)。
    stream.emit(userToolResult('toolu_long'));
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idleTimeoutError(events)).toBeUndefined(); // 60s < 120s
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpUntil(() => idleTimeoutError(events) !== undefined, 'watchdog fired after tool completion');
    expect(fakeQuery.interrupt).toHaveBeenCalled();

    vi.useRealTimers();
    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('turn 正常结束 → 清表,不再开火', async () => {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '100000';
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await handle.send({ type: 'user', content: 'quick turn' });
    stream.emit(successResult());
    await pumpUntil(() => handle.isTurnRunning?.() === false, 'turn done');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(idleTimeoutError(events)).toBeUndefined();
    expect(fakeQuery.interrupt).not.toHaveBeenCalled();

    vi.useRealTimers();
    stream.end();
    await handle.close().catch(() => undefined);
  });
});
