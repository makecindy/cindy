/**
 * Session 的 per-turn origin 打标(turnOrigin)。
 *
 * 验证 send(opts.origin) → Session 把 origin 打到本轮每个 AgentEvent.turnOrigin,
 * turn 终止后清空、下一轮不被污染、多 listener 一致。这是 IM 转播自动任务的地基
 * (共享 session 下区分"这一轮是谁发起的")。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { Session } from './session.js';
import type { AgentSessionHandle, TurnContinuationState } from './agents/base-agent.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, SendOrigin } from './types/events.js';
import type { AgentKind } from './types/common.js';

function createLogger() {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

/**
 * 可控事件流的 fake handle:send 后通过 emit() 往事件流逐条推 AgentEvent。
 * isTurnRunning 跟随 send/terminal 翻转,模拟真实 turn 边界。
 */
function createControllableHandle(opts?: {
  sendError?: Error;
  sendErrorOnSend?: number;
  agentKind?: AgentKind;
  dispatchEvent?: AgentEvent;
  dispatchOnSend?: number;
  holdDispatch?: boolean;
  holdOnSend?: number;
}) {
  let push: ((e: AgentEvent) => void) | null = null;
  let turnRunning = false;
  let closeCalls = 0;
  let releaseDispatch: (() => void) | null = null;
  let sendCount = 0;
  const buffered: AgentEvent[] = [];
  const continuationStates = new Map<number, TurnContinuationState>();
  let interactionResolver: ((req: InteractionRequest) => Promise<InteractionDecision>) | null = null;

  const handle: AgentSessionHandle = {
    id: 'thread-1',
    agentKind: opts?.agentKind ?? 'codex',
    model: 'gpt-5.4',
    async send() {
      sendCount += 1;
      if (opts?.sendError && (opts.sendErrorOnSend ?? 1) === sendCount) {
        throw opts.sendError; // 模拟 dispatch 失败(SESSION_RUNNING race)
      }
      if (opts?.dispatchEvent && (opts.dispatchOnSend ?? 1) === sendCount) {
        if (push) push(opts.dispatchEvent);
        else buffered.push(opts.dispatchEvent);
      }
      if (opts?.holdDispatch && (opts.holdOnSend ?? 1) === sendCount) {
        await new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
      }
      turnRunning = true;
    },
    async steer() {},
    async abort() {},
    async close() {
      closeCalls += 1;
      turnRunning = false;
    },
    async *events() {
      for (const e of buffered) yield e;
      buffered.length = 0;
      for (;;) {
        const next = await new Promise<AgentEvent | null>((resolve) => {
          push = (e) => resolve(e);
        });
        if (next === null) return;
        yield next;
      }
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver(resolver: (req: InteractionRequest) => Promise<InteractionDecision>) {
      interactionResolver = resolver;
    },
    isTurnRunning: () => turnRunning,
    beginTurnContinuationWait(continuationId?: number) {
      return continuationId === undefined ? null : continuationStates.get(continuationId) ?? null;
    },
  } as unknown as AgentSessionHandle;

  return {
    handle,
    resolveInteraction(req: InteractionRequest): Promise<InteractionDecision> {
      if (!interactionResolver) throw new Error('missing interaction resolver');
      return interactionResolver(req);
    },
    /**
     * 推一条事件;done/终止型 error 自动把 turnRunning 翻回 false(对齐真实 handle)。
     * keepRunning=true 时不翻转,模拟 forward loop 的 "pending>0 保持 turnInFlight" 语义
     * (排队 turn 存在:例如 rewind rebuild 尾部先 push /compact 再 push 用户消息,
     * SDK 处理 /compact 后发 done 但 handle 端 turnInFlight 仍是 true)。
     */
    async emit(e: AgentEvent, opts: { keepRunning?: boolean } = {}) {
      const terminalError =
        e.type === 'error' &&
        (e.data as { isTerminal?: unknown } | null | undefined)?.isTerminal === true;
      if ((e.type === 'done' || terminalError) && !opts.keepRunning) turnRunning = false;
      if (push) push(e);
      else buffered.push(e);
      await new Promise((r) => setTimeout(r, 0)); // 让事件循环把它 fan-out 出去
    },
    setTurnRunning(running: boolean) {
      turnRunning = running;
    },
    setContinuationState(continuationId: number, state: TurnContinuationState) {
      continuationStates.set(continuationId, state);
    },
    releaseDispatch() {
      releaseDispatch?.();
    },
    queue(event: AgentEvent) {
      if (push) push(event);
      else buffered.push(event);
    },
    closeCalls: () => closeCalls,
  };
}

function makeSession(handle: AgentSessionHandle, agentKind: AgentKind = 'codex'): Session {
  return new Session({
    id: 'session-1',
    agentKind,
    workDir: path.join('workspace', 'repo'),
    handle,
    capabilities: {} as never,
    logger: createLogger() as never,
  });
}

const SCHED_ORIGIN: SendOrigin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'PR 跟进' };

describe('Session interaction fallback', () => {
  /**
   * `Session` 构造函数**必定**注入 interaction resolver(构造函数里那次
   * `this.handle.setInteractionResolver(...)`)。这是 harness
   * 侧 fail-closed 分支的前提:`canUseTool` 里 `interactionResolver === null` 只可能是
   * misconfiguration / 裸 handle 直用,**不是**「这个会话没有界面」。
   *
   * Telegram / 飞书 bot、scheduler 定时任务、Orca headless worker 都经 Session 创建,
   * 所以都**有** resolver;它们缺的是 interactionListener,安全默认由这一层给出 deny。
   * 两件事分清楚,才不会把 harness 的裸 handle 边界误当成 headless 缺陷去改
   * (见 issue #1577)。
   */
  it('injects a resolver at construction and denies listenerless permission requests', async () => {
    const { handle, resolveInteraction } = createControllableHandle();
    makeSession(handle);

    // 这里没抛 'missing interaction resolver' 本身就是断言:构造时已经注入。
    await expect(resolveInteraction({
      kind: 'permission',
      requestId: 'perm-1',
      toolName: 'mcp__cindy_memory__call_tool',
      input: {},
    })).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'no_listener_attached',
    });
  });

  it('marks listenerless plan review denial as dismissed', async () => {
    const { handle, resolveInteraction } = createControllableHandle();
    makeSession(handle);

    await expect(resolveInteraction({
      kind: 'plan_review',
      requestId: 'plan-1',
      plan: '1. do X',
    })).resolves.toEqual({
      kind: 'plan_review',
      behavior: 'deny',
      reason: 'no_listener_attached',
      dismissed: true,
    });
  });
});

describe('Session per-turn origin 打标', () => {
  it('host turn lease serializes a new send across a vendor idle edge', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    let releaseLease!: () => void;

    await session.send('first', {
      afterTurnReserved: () => {
        releaseLease = session.acquireTurnLease();
      },
    });
    await emit({ type: 'done', data: {} });

    let secondSettled = false;
    const second = session.send('second').then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);
    expect(session.isTurnRunning()).toBe(true);

    releaseLease();
    await second;
    expect(secondSettled).toBe(true);
  });

  it('already-aborted send does not wait for a host turn lease', async () => {
    const { handle } = createControllableHandle();
    const session = makeSession(handle);
    const releaseLease = session.acquireTurnLease();
    const controller = new AbortController();
    controller.abort();

    await expect(session.send('cancelled', { signal: controller.signal })).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });
    releaseLease();
  });

  it('send cancelled while waiting for a host turn lease settles before release', async () => {
    const { handle } = createControllableHandle();
    const session = makeSession(handle);
    const releaseLease = session.acquireTurnLease();
    const controller = new AbortController();
    const pending = session.send('cancelled', { signal: controller.signal });

    controller.abort();
    await expect(pending).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });
    releaseLease();
  });

  it('带 origin 的 send → 本轮每个事件都带同一 turnOrigin;done 后清空', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go', { origin: SCHED_ORIGIN });
    await emit({ type: 'text', data: { text: 'hi', isFinal: false } });
    await emit({ type: 'done', data: {} });

    expect(seen.map((e) => e.type)).toEqual(['text', 'done']);
    expect(seen[0]!.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[1]!.turnOrigin).toEqual(SCHED_ORIGIN); // 终止事件本身也带 origin

    // done 之后的事件(下一轮还没 send)不应再带 origin —— 已清空
    await emit({ type: 'status', data: { isRunning: false } });
    expect(seen[2]!.turnOrigin).toBeUndefined();
  });

  it('end-status(isRunning=false) 紧接 done:done 仍带 origin(回归 P1)', async () => {
    // translator 收尾顺序是先 push end-status(isRunning=false)、紧接着 push done
    // (claude/codex 同序)。清 origin 若发生在 end-status 上,done 就会丢 origin,
    // 而 IM 转播按 scheduler-origin 的 done 收口卡片 → 卡片永不 finalize。此用例锁死
    // "done 必须带 origin"。
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go', { origin: SCHED_ORIGIN });
    await emit({ type: 'status', data: { isRunning: false } });
    await emit({ type: 'done', data: {} });

    expect(seen.map((e) => e.type)).toEqual(['status', 'done']);
    expect(seen[0]!.turnOrigin).toEqual(SCHED_ORIGIN); // end-status 带 origin
    expect(seen[1]!.turnOrigin).toEqual(SCHED_ORIGIN); // ★ done 不能丢(转播按 done 收口)

    // done 之后才清:下一轮事件无 origin
    await emit({ type: 'status', data: { isRunning: false } });
    expect(seen[2]!.turnOrigin).toBeUndefined();
  });

  it('不带 origin 的 send → 事件全程无 turnOrigin', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go');
    await emit({ type: 'text', data: { text: 'hi', isFinal: true } });
    await emit({ type: 'done', data: {} });

    expect(seen.every((e) => e.turnOrigin === undefined)).toBe(true);
  });

  it('带 runtime turnAttemptToken 的 send → 每个事件带同一 token,终态后清空', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('auto retry', { turnAttemptToken: 7 });
    await emit({ type: 'text', data: { text: 'progress', isFinal: false } });
    await emit({ type: 'done', data: {} });
    await emit({ type: 'status', data: { isRunning: false } });

    expect(seen.slice(0, 2).map((event) => event.turnAttemptToken)).toEqual([7, 7]);
    expect(seen[2]?.turnAttemptToken).toBeUndefined();
  });

  it('Codex 在 provider 启动前报终态 error → 通过 event-loop generation 归属当前 attempt', async () => {
    const { handle, releaseDispatch } = createControllableHandle({
      dispatchEvent: {
        type: 'error',
        data: { message: 'dispatch failed', isTerminal: true },
        source: 'codex',
      },
      holdDispatch: true,
    });
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    const send = session.send('go', {
      origin: SCHED_ORIGIN,
      turnAttemptToken: 9,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen[0]).toEqual(expect.objectContaining({
      type: 'error',
      turnOrigin: SCHED_ORIGIN,
      turnAttemptToken: 9,
    }));
    releaseDispatch();
    await send;
    await session.close();
  });

  it('排队中的旧 Codex terminal error 不能冒领随后 dispatch 的 attempt token', async () => {
    const { handle, emit, queue, setTurnRunning, releaseDispatch } = createControllableHandle({
      dispatchEvent: {
        type: 'error',
        data: { message: 'second failed', isTerminal: true },
        source: 'codex',
      },
      dispatchOnSend: 2,
      holdDispatch: true,
      holdOnSend: 2,
    });
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('first');
    await emit({ type: 'text', data: { text: 'first progress', isFinal: false } });
    setTurnRunning(false);
    queue({
      type: 'error',
      data: { message: 'first late failure', isTerminal: true },
      source: 'codex',
    });
    const second = session.send('second', {
      origin: SCHED_ORIGIN,
      turnAttemptToken: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const late = seen.find((event) =>
      event.type === 'error' && (event.data as { message?: string }).message === 'first late failure');
    expect(late?.turnAttemptToken).toBeUndefined();
    expect(late?.turnOrigin).toBeUndefined();
    releaseDispatch();
    await second;
    await session.close();
  });

  it('terminal error 后先排空尾部，再允许新 attempt', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('first', { turnAttemptToken: 1 });
    await emit({ type: 'error', data: { message: 'first failed', isTerminal: true } });

    await expect(session.send('second', { turnAttemptToken: 2 })).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
    await emit({ type: 'done', data: { reason: 'first-tail' } });
    await session.send('second', { turnAttemptToken: 2 });
    await emit({ type: 'error', data: { message: 'second failed', isTerminal: true } });

    expect(seen.map((event) => event.type)).toEqual(['error', 'done', 'error']);
    expect(seen[0]?.turnAttemptToken).toBe(1);
    expect(seen[1]?.turnAttemptToken).toBeUndefined();
    expect(seen[2]?.turnAttemptToken).toBe(2);
  });

  it('terminal error 后的 Codex idle status 会清 drain，不会误关健康 session', async () => {
    const { handle, emit, closeCalls } = createControllableHandle();
    const session = makeSession(handle);

    await session.send('first');
    await emit({ type: 'error', data: { message: 'first failed', isTerminal: true } });
    await emit({ type: 'status', data: { isRunning: false } });

    await expect(session.send('second', { turnAttemptToken: 2 })).resolves.toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closeCalls()).toBe(0);
  });

  it('Claude terminal error 后的 idle status 不能越过 queued done 提前解锁', async () => {
    const { handle, emit } = createControllableHandle({ agentKind: 'claude-code' });
    const session = makeSession(handle, 'claude-code');

    await session.send('first');
    await emit({
      type: 'error',
      data: { message: 'first failed', isTerminal: true },
      source: 'claude-code',
    });
    await emit({ type: 'status', data: { isRunning: false }, source: 'claude-code' });

    await expect(session.send('second')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    await emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(session.send('second')).resolves.toEqual({ accepted: true });
    await session.close();
  });

  it('non-terminal error 不启动 terminal drain，也不打开 generation fence', async () => {
    const { handle, emit, setTurnRunning, closeCalls } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('first');
    await emit({ type: 'error', data: { message: 'retryable', isTerminal: false } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closeCalls()).toBe(0);

    await emit({ type: 'text', data: { text: 'still running', isFinal: false } });
    setTurnRunning(false);
    expect(session.isTurnRunning()).toBe(false);
    await session.send('second', { turnAttemptToken: 2 });
    await emit({ type: 'done', data: {} }, { keepRunning: true });
    await emit({ type: 'text', data: { text: 'second turn', isFinal: false } });

    expect(seen.find((event) => event.type === 'text' &&
      (event.data as { text?: string }).text === 'second turn')?.turnAttemptToken).toBe(2);
  });

  it('普通事件不能让旧 turn 的迟到 done 冒领下一代 token', async () => {
    const { handle, emit, setTurnRunning } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('first');
    await emit({ type: 'text', data: { text: 'first progress', isFinal: false } });
    setTurnRunning(false);
    expect(session.isTurnRunning()).toBe(false);
    await session.send('second', { turnAttemptToken: 2 });
    await emit({ type: 'done', data: { reason: 'late first tail' } }, { keepRunning: true });
    await emit({ type: 'text', data: { text: 'second progress', isFinal: false } });

    const lateDone = seen.find((event) => event.type === 'done');
    const secondText = seen.find(
      (event) => event.type === 'text' &&
        (event.data as { text?: string }).text === 'second progress',
    );
    expect(lateDone?.turnAttemptToken).toBeUndefined();
    expect(secondText?.turnAttemptToken).toBe(2);
  });

  it('event loop crash emits a terminal error and closes the poisoned session', async () => {
    let releaseCrash!: () => void;
    const crashReady = new Promise<void>((resolve) => {
      releaseCrash = resolve;
    });
    let turnRunning = false;
    const handle = {
      id: 'crashing-handle',
      agentKind: 'codex',
      model: 'gpt-5.4',
      async send() {
        turnRunning = true;
      },
      async steer() {},
      async abort() {},
      async close() {
        turnRunning = false;
      },
      async *events() {
        await crashReady;
        throw new Error('event stream crashed');
      },
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver() {},
      isTurnRunning: () => turnRunning,
    } as unknown as AgentSessionHandle;
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));
    const closed = new Promise<void>((resolve) => {
      session.onStatusChange((status) => {
        if (status === 'closed') resolve();
      });
    });

    await session.send('go', { turnAttemptToken: 1 });
    releaseCrash();
    await closed;

    expect(seen.at(-1)).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        reason: 'session_event_loop_crashed',
        isTerminal: true,
      }),
    }));
    expect(session.getStatus()).toBe('closed');
  });

  it('多 listener 拿到同一份 origin', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    session.onEvent((e) => a.push({ ...e }));
    session.onEvent((e) => b.push({ ...e }));

    await session.send('go', { origin: SCHED_ORIGIN });
    await emit({ type: 'text', data: { text: 'x', isFinal: true } });
    await emit({ type: 'done', data: {} });

    expect(a[0]!.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(b[0]!.turnOrigin).toEqual(SCHED_ORIGIN);
  });

  it('handle.send 抛错(dispatch 失败)→ 清掉本次乐观 origin,不污染后续(别的 turn)事件', async () => {
    // SESSION_RUNNING race:isTurnRunning 检查通过但 handle.send reject。此前 origin
    // 已在 dispatch 边界装好,若不清,事件循环里别的正在跑的 turn 的事件会被打 stale origin。
    const { handle, emit } = createControllableHandle({ sendError: new Error('boom-dispatch') });
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await expect(session.send('go', { origin: SCHED_ORIGIN })).rejects.toThrow('boom-dispatch');

    // 事件循环已起(startEventLoopIfNeeded 在 handle.send 前调),别的 turn 的事件流进来
    await emit({ type: 'text', data: { text: '别的 turn 的事件', isFinal: true } });
    expect(seen.at(-1)?.turnOrigin).toBeUndefined(); // origin 已清,不误打
  });

  it('dispatch 失败且没有旧尾事件时，drain 超时关闭歧义 session', async () => {
    const { handle, closeCalls } = createControllableHandle({
      sendError: new Error('boom-dispatch'),
      sendErrorOnSend: 1,
    });
    const session = makeSession(handle);

    await expect(session.send('failed', { turnAttemptToken: 1 })).rejects.toThrow('boom-dispatch');
    await expect(session.send('next', { turnAttemptToken: 2 })).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(closeCalls()).toBe(1);
    expect(session.getStatus()).toBe('closed');
  });

  it('dispatch 失败后的迟到终态不能冒领下一次 turn 的 token', async () => {
    const { handle, emit } = createControllableHandle({
      sendError: new Error('boom-dispatch'),
      sendErrorOnSend: 1,
    });
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await expect(session.send('failed', { turnAttemptToken: 1 })).rejects.toThrow('boom-dispatch');
    await expect(session.send('next', { turnAttemptToken: 2 })).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
    await emit({ type: 'done', data: { reason: 'late failed-dispatch tail' } });
    await session.send('next', { turnAttemptToken: 2 });
    await emit({ type: 'text', data: { text: 'next turn progress', isFinal: false } });

    expect(seen[0]?.turnAttemptToken).toBeUndefined();
    expect(seen[1]?.turnAttemptToken).toBe(2);
  });

  it('失败 send 还原(而非清空)正在跑 turn 的 origin —— turn1 的 done 仍带 origin(回归 Greptile P1)', async () => {
    // 场景:turn1(scheduler)还在跑、currentTurnOrigin=ORIGIN_1。turn2 在 turn1 的
    // done 尚未 fan-out 的窗口里发起(isTurnRunning 已翻 false → 越过 137 守卫),装上
    // ORIGIN_2 后 handle.send 抛 SESSION_RUNNING。若 finally 清 null,turn1 的 done 会
    // 丢 origin → 转播卡永不 finalize。还原语义保证 turn1 的 done 仍带 ORIGIN_1。
    const ORIGIN_1: SendOrigin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'turn1' };
    const ORIGIN_2: SendOrigin = { kind: 'scheduler', scheduleId: 's2', scheduleName: 'turn2' };
    let sendCalls = 0;
    let turnRunning = false;
    let push: ((e: AgentEvent) => void) | null = null;
    const handle = {
      id: 'h', agentKind: 'codex', model: 'gpt-5.4',
      async send() {
        sendCalls += 1;
        if (sendCalls === 1) { turnRunning = true; return; } // turn1 派发成功
        throw new Error('SESSION_RUNNING'); // turn2 撞忙
      },
      async steer() {}, async abort() {}, async close() {},
      async *events() {
        for (;;) {
          const next = await new Promise<AgentEvent | null>((r) => { push = r; });
          if (next === null) return;
          yield next;
        }
      },
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      setInteractionResolver() {},
      isTurnRunning: () => turnRunning,
    } as unknown as AgentSessionHandle;
    const emit = async (e: AgentEvent) => {
      push?.(e);
      await new Promise((r) => setTimeout(r, 0));
    };

    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go-1', { origin: ORIGIN_1 }); // turn1 派发,currentTurnOrigin=ORIGIN_1
    turnRunning = false; // 模拟 turn1 在 handle 层已结束、但 done 还没 fan-out
    await expect(session.send('go-2', { origin: ORIGIN_2 })).rejects.toThrow('SESSION_RUNNING');

    await emit({ type: 'done', data: {} }); // turn1 的 done 现在才到
    const done = seen.find((e) => e.type === 'done');
    expect(done?.turnOrigin).toEqual(ORIGIN_1); // 被还原,不是 undefined
  });

  it('standalone auto-compact after origin turn must not inherit origin', async () => {
    // 场景: goal/scheduler turn 的 done 到达时,agent 已经因普通 auto-compact 又把
    // isTurnRunning() 置回 true。Session 仍必须把到达自身的终止事件视作
    // 产品层 turn 结束并清 origin,否则后台 /compact 事件会被 goal/scheduler 误收口。
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go', { origin: SCHED_ORIGIN });
    await emit({ type: 'text', data: { text: 'goal answer', isFinal: true } }, { keepRunning: true });
    await emit({ type: 'done', data: { reason: 'user-turn-done' } }, { keepRunning: true });
    await emit({ type: 'text', data: { text: 'standalone compact', isFinal: true } }, { keepRunning: true });
    await emit({ type: 'done', data: { reason: 'compact' } });

    expect(seen[0]!.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[1]!.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[2]!.turnOrigin).toBeUndefined();
    expect(seen[3]!.turnOrigin).toBeUndefined();
  });

  it('continuation-bearing done keeps origin/token until the automatic continuation really ends', async () => {
    const { handle, emit, setContinuationState } = createControllableHandle({
      agentKind: 'claude-code',
    });
    const session = makeSession(handle, 'claude-code');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('go', { origin: SCHED_ORIGIN, turnAttemptToken: 42 });
    setContinuationState(1, 'awaiting');
    await emit(
      { type: 'done', data: { reason: 'foreground-done' }, turnContinuationId: 1 },
      { keepRunning: true },
    );

    // The provider claim is still the same product turn. Session must keep
    // attribution for the auto-continuation instead of clearing it at the
    // foreground SDK boundary.
    await emit(
      { type: 'text', data: { text: 'background result', isFinal: true } },
      { keepRunning: true },
    );
    setContinuationState(1, 'active');
    await emit({ type: 'done', data: { reason: 'continuation-done' } });
    await emit({ type: 'status', data: { status: 'idle', isRunning: false } });

    expect(seen[0]?.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[0]?.turnAttemptToken).toBe(42);
    expect(seen[1]?.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[1]?.turnAttemptToken).toBe(42);
    expect(seen[2]?.turnOrigin).toEqual(SCHED_ORIGIN);
    expect(seen[2]?.turnAttemptToken).toBe(42);
    expect(seen[3]?.turnOrigin).toBeUndefined();
    expect(seen[3]?.turnAttemptToken).toBeUndefined();
  });

  it('cancelled continuation closes on the ordered terminal done before the next result-only turn', async () => {
    const origin1: SendOrigin = {
      kind: 'scheduler',
      scheduleId: 'cancelled-turn-1',
      scheduleName: 'cancelled turn 1',
    };
    const origin2: SendOrigin = {
      kind: 'scheduler',
      scheduleId: 'result-only-turn-2',
      scheduleName: 'result-only turn 2',
    };
    const { handle, emit, setContinuationState } = createControllableHandle({
      agentKind: 'claude-code',
    });
    const session = makeSession(handle, 'claude-code');
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push({ ...event }));

    await session.send('go-1', { origin: origin1, turnAttemptToken: 11 });
    // Cancellation may win before Session consumes the original foreground
    // done. The claim-bearing event remains an SDK boundary; the stopped task
    // and provider's following unclaimed done still belong to turn 1.
    setContinuationState(7, 'cancelled');
    await emit(
      { type: 'done', data: { reason: 'foreground-done' }, turnContinuationId: 7 },
      { keepRunning: true },
    );
    await emit(
      {
        type: 'agent_task_update',
        data: { taskId: 'task-1', status: 'stopped', taskType: 'local_agent' },
      },
      { keepRunning: true },
    );
    await emit({ type: 'done', data: { reason: 'turn_continuation_cancelled' } });

    await session.send('go-2', { origin: origin2, turnAttemptToken: 22 });
    // No text event: a result-only provider turn must still be adopted as the
    // new generation instead of inheriting turn 1's origin/token.
    await emit({ type: 'done', data: { reason: 'result-only' } });

    expect(seen[0]?.turnOrigin).toEqual(origin1);
    expect(seen[0]?.turnAttemptToken).toBe(11);
    expect(seen[1]?.turnOrigin).toEqual(origin1);
    expect(seen[1]?.turnAttemptToken).toBe(11);
    expect(seen[2]?.turnOrigin).toEqual(origin1);
    expect(seen[2]?.turnAttemptToken).toBe(11);
    expect(seen[3]?.turnOrigin).toEqual(origin2);
    expect(seen[3]?.turnAttemptToken).toBe(22);
  });

  it('终止型 error 也触发清空,下一轮不被污染', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((e) => seen.push({ ...e }));

    await session.send('go', { origin: SCHED_ORIGIN });
    await emit({ type: 'error', data: { message: 'boom', isTerminal: true } });
    expect(seen[0]!.turnOrigin).toEqual(SCHED_ORIGIN);

    await emit({ type: 'status', data: { isRunning: false } });
    expect(seen[1]!.turnOrigin).toBeUndefined();
  });

  it('在所有 listener 收到事件前脱敏 terminal error 与 failed done 载荷', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];
    session.onEvent((event) => first.push(event));
    session.onEvent((event) => second.push(event));

    await session.send('go');
    await emit({
      type: 'error',
      data: { message: 'Authorization: Bearer secret-token', isTerminal: true },
    });
    await emit({
      type: 'done',
      data: {
        raw: {
          error: {
            message: 'client_secret=oauth-secret',
            additionalDetails: 'key=opaque-secret',
          },
        },
      },
    });

    for (const events of [first, second]) {
      expect((events[0]!.data as { message: string }).message).toBe('Authorization: [REDACTED]');
      const rawError = (events[1]!.data as { raw: { error: Record<string, string> } }).raw.error;
      expect(rawError.message).toBe('client_secret=[REDACTED]');
      expect(rawError.additionalDetails).toBe('key=[REDACTED]');
    }
  });

  it('preserves a non-secret auth status and redacts nested Codex error details', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'error',
      data: { message: 'Authorization: Bearer secret-token, status=401', isTerminal: true },
    });
    await emit({
      type: 'done',
      data: {
        raw: {
          error: {
            codexErrorInfo: {
              message: 'upstream Authorization: Bearer nested-secret',
              details: [{ retry: 'client_secret=oauth-secret' }],
            },
          },
        },
      },
    });

    expect((seen[0]!.data as { message: string; errorStatus: number }).message).toBe(
      'Authorization: [REDACTED]',
    );
    expect((seen[0]!.data as { errorStatus: number }).errorStatus).toBe(401);
    expect(JSON.stringify(seen[1])).not.toMatch(/nested-secret|oauth-secret/);
    expect(
      (seen[1]!.data as { raw: { error: { codexErrorInfo: { message: string } } } }).raw.error.codexErrorInfo
        .message,
    ).toBe('upstream Authorization: [REDACTED]');
  });

  it('preserves a rate-limit status after redacting the error message', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'error',
      data: { message: 'Authorization: Bearer secret-token, status=429', isTerminal: true },
    });

    expect((seen[0]!.data as { errorStatus: number }).errorStatus).toBe(429);
    expect((seen[0]!.data as { message: string }).message).toBe('Authorization: [REDACTED]');
  });

  it('does not derive a status from a credential fragment', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'error',
      data: { message: 'Authorization: Bearer tok-401-x; upstream 500', isTerminal: true },
    });

    expect((seen[0]!.data as { errorStatus?: number }).errorStatus).toBeUndefined();
    expect((seen[0]!.data as { message: string }).message).toBe(
      'Authorization: [REDACTED]; upstream 500',
    );
  });

  it('preserves a quota marker after redacting the error message', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'error',
      data: { message: 'Authorization: Bearer secret-token, quota exhausted', isTerminal: true },
    });

    expect((seen[0]!.data as { usageLimit?: boolean }).usageLimit).toBe(true);
    expect((seen[0]!.data as { message: string }).message).toBe('Authorization: [REDACTED]');
  });

  it('redacts failed task summaries before listener fan-out', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'agent_task_update',
      data: {
        provider: 'claude-code',
        taskId: 'task-1',
        status: 'failed',
        summary: 'task failed: password=task-secret',
      },
    });

    expect((seen[0]!.data as { summary: string }).summary).toBe('task failed: password=[REDACTED]');
    expect(JSON.stringify(seen[0])).not.toContain('task-secret');
  });

  it('redacts failed task raw state before listener fan-out', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'agent_task_update',
      data: {
        provider: 'codex',
        taskId: 'task-1',
        status: 'failed',
        raw: {
          agentsStates: {
            child: {
              error: 'Authorization: Bearer nested-task-secret',
            },
          },
        },
      },
    });

    expect(JSON.stringify(seen[0])).not.toContain('nested-task-secret');
    expect(
      (
        seen[0]!.data as {
          raw: { agentsStates: { child: { error: string } } };
        }
      ).raw.agentsStates.child.error,
    ).toBe('Authorization: [REDACTED]');
  });

  it('redacts failed Codex raw item snapshots before listener fan-out', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'done',
      data: {
        raw: {
          status: 'failed',
          error: { message: 'turn failed' },
          items: [
            {
              type: 'error',
              message: 'Authorization: Bearer nested-item-secret',
            },
          ],
        },
      },
    });

    expect(JSON.stringify(seen[0])).not.toContain('nested-item-secret');
    expect(
      (
        seen[0]!.data as {
          raw: { items: Array<{ message: string }> };
        }
      ).raw.items[0]!.message,
    ).toBe('Authorization: [REDACTED]');
  });

  it('redacts failed tool result full text before listener fan-out', async () => {
    const { handle, emit } = createControllableHandle();
    const session = makeSession(handle);
    const seen: AgentEvent[] = [];
    session.onEvent((event) => seen.push(event));

    await session.send('go');
    await emit({
      type: 'tool_result_full',
      data: {
        toolUseId: 'collab-1',
        fullText: 'sub-agent failed: Authorization: Bearer upstream-secret',
        isError: true,
      },
    });

    expect((seen[0]!.data as { fullText: string }).fullText).toBe(
      'sub-agent failed: Authorization: [REDACTED]',
    );
    expect(JSON.stringify(seen[0])).not.toContain('upstream-secret');
  });
});
