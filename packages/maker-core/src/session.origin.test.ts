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
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, SendOrigin } from './types/events.js';

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
function createControllableHandle(opts?: { sendError?: Error }) {
  let push: ((e: AgentEvent) => void) | null = null;
  let turnRunning = false;
  const buffered: AgentEvent[] = [];
  let interactionResolver: ((req: InteractionRequest) => Promise<InteractionDecision>) | null = null;

  const handle: AgentSessionHandle = {
    id: 'thread-1',
    agentKind: 'codex',
    model: 'gpt-5.4',
    async send() {
      if (opts?.sendError) throw opts.sendError; // 模拟 dispatch 失败(SESSION_RUNNING race)
      turnRunning = true;
    },
    async steer() {},
    async abort() {},
    async close() {},
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
      if ((e.type === 'done' || e.type === 'error') && !opts.keepRunning) turnRunning = false;
      if (push) push(e);
      else buffered.push(e);
      await new Promise((r) => setTimeout(r, 0)); // 让事件循环把它 fan-out 出去
    },
  };
}

function makeSession(handle: AgentSessionHandle): Session {
  return new Session({
    id: 'session-1',
    agentKind: 'codex',
    workDir: path.join('workspace', 'repo'),
    handle,
    capabilities: {} as never,
    logger: createLogger() as never,
  });
}

const SCHED_ORIGIN: SendOrigin = { kind: 'scheduler', scheduleId: 's1', scheduleName: 'PR 跟进' };

describe('Session interaction fallback', () => {
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
