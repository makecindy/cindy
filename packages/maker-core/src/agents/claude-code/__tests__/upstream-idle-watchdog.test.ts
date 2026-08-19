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

async function startSessionWithStream(model = 'claude-opus-4-6') {
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
    model,
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

function assistantToolUse(
  id: string,
  command = 'sleep 999',
  parentToolUseId?: string,
  model?: string,
): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId ?? null,
    message: {
      role: 'assistant',
      ...(model ? { model } : {}),
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function assistantTaskOutput(id: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'TaskOutput',
          input: { task_id: 'task-1', block: true, timeout: 30_000 },
        },
      ],
    },
  };
}

function userToolResult(
  id: string,
  content = 'done',
  parentToolUseId?: string,
): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: parentToolUseId ?? null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
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

function toolLoopError(events: AgentEvent[]): AgentEvent | undefined {
  return events.find(
    (e) =>
      e.type === 'error' &&
      (e.data as Record<string, unknown> | undefined)?.reason === 'tool_use_loop_detected',
  );
}

async function runStableAbabLoop(
  session: Awaited<ReturnType<typeof startSessionWithStream>>,
  userContent: string,
  idPrefix: string,
  sidechain?: { parentToolUseId: string; model?: string },
): Promise<{ loopError: AgentEvent | undefined; interruptCalls: number }> {
  const { handle, stream, events, fakeQuery, collected } = session;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    await handle.send({ type: 'user', content: userContent });
    for (let i = 0; i < 12; i += 1) {
      const id = `${idPrefix}_${i}`;
      const isA = i % 2 === 0;
      stream.emit(
        assistantToolUse(
          id,
          isA
            ? 'grep -R "getShellCommandPolicy" packages apps'
            : 'grep -R "shell-command-policy" packages apps',
          sidechain?.parentToolUseId,
          sidechain?.model,
        ),
      );
      stream.emit(
        userToolResult(id, isA ? 'base-agent.ts:731' : 'not found', sidechain?.parentToolUseId),
      );
    }

    await pumpUntil(
      () => events.filter((event) => event.type === 'tool_result_full').length === 12,
      `${idPrefix} tool results processed`,
    );
    await vi.advanceTimersByTimeAsync(1);
    const result = {
      loopError: toolLoopError(events),
      interruptCalls: fakeQuery.interrupt.mock.calls.length,
    };

    if (handle.isTurnRunning?.()) {
      stream.emit(successResult());
      await pumpUntil(() => handle.isTurnRunning?.() === false, `${idPrefix} turn done`);
    }
    return result;
  } finally {
    vi.useRealTimers();
    stream.end();
    await handle.close().catch(() => undefined);
    await collected;
  }
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
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream();

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
    await collected;
  });

  it('工具执行期间停表不开火;tool_result 配对完重新起表、走满才开火', async () => {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '120000';
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream();

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
    await collected;
  });

  it('turn 正常结束 → 清表,不再开火', async () => {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '100000';
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream();

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
    await collected;
  });
});

describe('Claude Code tool-loop guard runtime integration', () => {
  it('并发 subagent 的相同调用按 parent 隔离，不会聚合成会话级死循环', async () => {
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream(
      'claude-opus-5',
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await handle.send({ type: 'user', content: 'run four independent subagents' });

      for (let round = 0; round < 3; round += 1) {
        for (let agent = 0; agent < 4; agent += 1) {
          const parentToolUseId = `toolu_agent_${agent}`;
          const id = `${parentToolUseId}_bash_${round}`;
          stream.emit(assistantToolUse(id, 'git status --short', parentToolUseId));
          stream.emit(userToolResult(id, 'clean', parentToolUseId));
        }
      }
      stream.emit(successResult());

      await pumpUntil(() => handle.isTurnRunning?.() === false, 'parallel subagent turn done');
      expect(toolLoopError(events)).toBeUndefined();
      expect(fakeQuery.interrupt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      stream.end();
      await handle.close().catch(() => undefined);
      await collected;
    }
  });

  it('claude-opus-5 的稳定 ABAB Bash 循环在第 12 个结果处中断', async () => {
    const result = await runStableAbabLoop(
      await startSessionWithStream('claude-opus-5'),
      'find the missing implementation',
      'toolu_issue_2721',
    );

    expect(result.loopError).toMatchObject({
      type: 'error',
      data: {
        reason: 'tool_use_loop_detected',
        loopKind: 'pingpong',
        loopCount: 12,
        model: 'claude-opus-5',
        isTerminal: true,
      },
      source: 'claude-code',
    });
    expect(result.interruptCalls).toBe(1);
  });

  it('热切到 claude-opus-5 后稳定 ABAB Bash 循环仍会中断', async () => {
    const session = await startSessionWithStream(
      'deepseek/deepseek-v4-flash',
    );
    await session.handle.setModel?.('claude-opus-5');
    const result = await runStableAbabLoop(
      session,
      'find the missing implementation after switching models',
      'toolu_issue_2721_switch',
    );

    expect(session.fakeQuery.setModel).toHaveBeenCalledWith('claude-opus-5[1m]');
    expect(result.loopError).toMatchObject({
      type: 'error',
      data: {
        reason: 'tool_use_loop_detected',
        loopKind: 'pingpong',
        loopCount: 12,
        model: 'claude-opus-5',
        isTerminal: true,
      },
      source: 'claude-code',
    });
    expect(result.interruptCalls).toBe(1);
  });

  it('未确认的 provider-routed 模型不扩展自动硬中断范围', async () => {
    const result = await runStableAbabLoop(
      await startSessionWithStream('codex/gpt-5.5'),
      'run a provider-routed investigation',
      'toolu_provider_boundary',
    );

    expect(result.loopError).toBeUndefined();
    expect(result.interruptCalls).toBe(0);
  });

  it('claude 会话下 provider-routed 模型 sidechain 的稳定 ABAB 循环不触发硬中断', async () => {
    // sidechain 流内消息报的是 SDK 原始 id(无 codex/ 前缀),guard 适用性按它判。
    const result = await runStableAbabLoop(
      await startSessionWithStream('claude-opus-5'),
      'delegate the investigation to a codex subagent',
      'toolu_codex_sidechain',
      { parentToolUseId: 'toolu_agent_codex', model: 'gpt-5.6-sol' },
    );

    expect(result.loopError).toBeUndefined();
    expect(result.interruptCalls).toBe(0);
  });

  it('provider-routed 会话下 claude 模型 sidechain 的稳定 ABAB 循环仍会中断', async () => {
    const result = await runStableAbabLoop(
      await startSessionWithStream('codex/gpt-5.5'),
      'delegate the investigation to a claude subagent',
      'toolu_claude_sidechain',
      { parentToolUseId: 'toolu_agent_claude', model: 'claude-opus-5-20260115' },
    );

    expect(result.loopError).toMatchObject({
      type: 'error',
      data: {
        reason: 'tool_use_loop_detected',
        loopKind: 'pingpong',
        loopCount: 12,
        model: 'claude-opus-5-20260115',
        isTerminal: true,
      },
      source: 'claude-code',
    });
    expect(result.interruptCalls).toBe(1);
  });

  it('xai/grok 会话下 4 个不同 Grep 的 ABCD 轮转在第 16 个结果处中断', async () => {
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream(
      'xai/grok-4.5',
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await handle.send({ type: 'user', content: 'find the missing implementation' });

      const greps = [
        'grep -R "planA" packages',
        'grep -R "planB" packages',
        'grep -R "planC" packages',
        'grep -R "planD" packages',
      ];
      for (let i = 0; i < 16; i += 1) {
        const id = `toolu_grok_rotation_${i}`;
        stream.emit(assistantToolUse(id, greps[i % 4]));
        stream.emit(userToolResult(id, `no result ${i}`));
      }

      await pumpUntil(
        () => events.filter((event) => event.type === 'tool_result_full').length === 16,
        'grok rotation tool results processed',
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(toolLoopError(events)).toMatchObject({
        type: 'error',
        data: {
          reason: 'tool_use_loop_detected',
          loopKind: 'rotation',
          loopCount: 16,
          model: 'xai/grok-4.5',
          isTerminal: true,
        },
        source: 'claude-code',
      });
      expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      stream.end();
      await handle.close().catch(() => undefined);
      await collected;
    }
  });

  it('x-ai/grok 网关形态会话下 4 个不同 Grep 的 ABCD 轮转同样会被中断', async () => {
    // x-ai/ 是网关侧 grok 命名空间(classification.ts 与 xai/ 分开登记),
    // toSdkModelString 原样透传,顶层会话模型即该形态 —— 不得漏出 guard 覆盖。
    const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream(
      'x-ai/grok-4.6',
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await handle.send({ type: 'user', content: 'find the missing implementation' });

      const greps = [
        'grep -R "planA" packages',
        'grep -R "planB" packages',
        'grep -R "planC" packages',
        'grep -R "planD" packages',
      ];
      for (let i = 0; i < 16; i += 1) {
        const id = `toolu_gateway_grok_rotation_${i}`;
        stream.emit(assistantToolUse(id, greps[i % 4]));
        stream.emit(userToolResult(id, `no result ${i}`));
      }

      await pumpUntil(
        () => events.filter((event) => event.type === 'tool_result_full').length === 16,
        'gateway grok rotation tool results processed',
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(toolLoopError(events)).toMatchObject({
        type: 'error',
        data: {
          reason: 'tool_use_loop_detected',
          loopKind: 'rotation',
          loopCount: 16,
          model: 'x-ai/grok-4.6',
          isTerminal: true,
        },
        source: 'claude-code',
      });
      expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      stream.end();
      await handle.close().catch(() => undefined);
      await collected;
    }
  });

  it('claude 会话下裸 id 形态的 grok sidechain 同样受 guard 保护', async () => {
    const result = await runStableAbabLoop(
      await startSessionWithStream('claude-opus-5'),
      'delegate the investigation to a grok subagent',
      'toolu_grok_sidechain',
      { parentToolUseId: 'toolu_agent_grok', model: 'grok-4.5' },
    );

    expect(result.loopError).toMatchObject({
      type: 'error',
      data: {
        reason: 'tool_use_loop_detected',
        loopKind: 'pingpong',
        loopCount: 12,
        model: 'grok-4.5',
        isTerminal: true,
      },
      source: 'claude-code',
    });
    expect(result.interruptCalls).toBe(1);
  });

  it('deepseek 会话下裸 id 形态的 deepseek sidechain 仍受 guard 保护', async () => {
    // 流内原始 id 是 deepseek-v4-flash(无 deepseek/ 前缀),家族前缀匹配不得漏判。
    const result = await runStableAbabLoop(
      await startSessionWithStream('deepseek/deepseek-v4-flash'),
      'delegate the investigation to a deepseek subagent',
      'toolu_deepseek_sidechain',
      { parentToolUseId: 'toolu_agent_deepseek', model: 'deepseek-v4-flash' },
    );

    expect(result.loopError).toMatchObject({
      type: 'error',
      data: {
        reason: 'tool_use_loop_detected',
        loopKind: 'pingpong',
        loopCount: 12,
        model: 'deepseek-v4-flash',
        isTerminal: true,
      },
      source: 'claude-code',
    });
    expect(result.interruptCalls).toBe(1);
  });

  it.each(['deepseek/deepseek-v4-flash', 'claude-opus-5', 'xai/grok-4.5'])(
    '%s 真实 SDK 事件流中的 150 次不同调用与空结果可以完成同一个 turn',
    async (model) => {
      const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream(model);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await handle.send({ type: 'user', content: 'analyze 150 different projects' });

      for (let i = 0; i < 150; i += 1) {
        const id = `toolu_project_${i}`;
        stream.emit(assistantToolUse(id, `read-project-${i}`));
        stream.emit(userToolResult(id, ''));
      }
      stream.emit(successResult());

      await pumpUntil(() => handle.isTurnRunning?.() === false, `long ${model} turn done`);
      expect(toolLoopError(events)).toBeUndefined();
      expect(fakeQuery.interrupt).not.toHaveBeenCalled();

      vi.useRealTimers();
      stream.end();
      await handle.close().catch(() => undefined);
      await collected;
    },
  );

  it.each(['deepseek/deepseek-v4-flash', 'claude-opus-5', 'xai/grok-4.5'])(
    '%s 真实 SDK 事件流中的稳定 TaskOutput 轮询不会中断 turn',
    async (model) => {
      const { handle, stream, events, fakeQuery, collected } = await startSessionWithStream(model);

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await handle.send({ type: 'user', content: 'wait for the background task' });

      for (let i = 0; i < 30; i += 1) {
        const id = `toolu_task_output_${i}`;
        stream.emit(assistantTaskOutput(id));
        stream.emit(userToolResult(id, 'still running'));
      }
      stream.emit(successResult());

      await pumpUntil(() => handle.isTurnRunning?.() === false, `${model} TaskOutput polling turn done`);
      expect(toolLoopError(events)).toBeUndefined();
      expect(fakeQuery.interrupt).not.toHaveBeenCalled();

      vi.useRealTimers();
      stream.end();
      await handle.close().catch(() => undefined);
      await collected;
    },
  );
});
