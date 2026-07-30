/**
 * Session 层 turn 零事件看门狗。
 *
 * 兜的是各 agent 内部 upstream-idle watchdog 结构上抓不到的洞:那些 watchdog 在
 * **工具执行期间刻意不计时**,所以工具自己 hang(MCP 卡住 / stdio 通道 wedge)时
 * turn 可以永久挂着。这一层不区分球在谁手里,只看"还有没有动静"。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MANUAL_ABORT_RECOVERY_GRACE_MS,
  STALL_ABORT_RECOVERY_GRACE_MS,
  Session,
} from './session.js';
import type { AgentEvent, SendOrigin } from './types/events.js';
import type { AgentSessionHandle, BackgroundTaskSnapshot } from './agents/base-agent.js';

type LoggedError = { msg: string; meta?: Record<string, unknown> };

function createLogger(sink?: LoggedError[]) {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, fatal() {},
    error(msg: string, meta?: Record<string, unknown>) {
      sink?.push({ msg, meta });
    },
    child() { return logger; },
  };
  return logger;
}

const STALL_MS = 60_000;

interface StubOptions {
  backgroundTasks?: BackgroundTaskSnapshot[];
  /** true = abort 不生效（turn 仍在跑），复刻中断失败的真实形态。 */
  abortIneffective?: boolean;
  /**
   * true = abort() 返回的 promise 永不 settle，复刻"中断请求本身也悬挂"的形态
   * （codex 的 turn/interrupt RPC 永不返回、claude 的 q.interrupt() 卡在 stdio）。
   */
  abortHangs?: boolean;
}

/**
 * 最小 handle:手动喂事件 + 可控 isTurnRunning。events() 是个永不自然结束的
 * async iterator(真实 agent 同款),事件经 push 进来。
 */
function createStubHandle(opts?: StubOptions) {
  let turnRunning = false;
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  // abortIneffective 模拟各 agent 的真实失败形态:中断请求失败(claude 的
  // q.interrupt() 抛错 / codex 的 app-server 两次 ack 超时)时它们只记日志,
  // **不**清 turn-in-flight 状态 —— isTurnRunning() 因此恒为 true。
  const abort = vi.fn(async () => {
    if (opts?.abortHangs) return new Promise<never>(() => {});
    if (opts?.abortIneffective) return;
    turnRunning = false;
  });
  let interactionResolver:
    | ((req: unknown) => Promise<unknown>)
    | null = null;

  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const next = pending.shift();
      if (next) yield next;
    }
  }

  const handle = {
    id: 'thread-1',
    agentKind: 'claude-code',
    model: 'claude-opus-5',
    events,
    send: vi.fn(async () => {
      turnRunning = true;
    }),
    abort,
    close: vi.fn(async () => {}),
    isTurnRunning: () => turnRunning,
    listBackgroundTasks: () => opts?.backgroundTasks ?? [],
    setInteractionResolver(resolver: (req: unknown) => Promise<unknown>) {
      interactionResolver = resolver;
    },
  } as unknown as AgentSessionHandle;

  return {
    handle,
    abort,
    pushEvent(event: AgentEvent) {
      pending.push(event);
      notify?.();
      notify = null;
    },
    endTurn() {
      turnRunning = false;
    },
    callInteraction(): Promise<unknown> {
      if (!interactionResolver) throw new Error('no interaction resolver installed');
      return interactionResolver({ kind: 'permission', requestId: 'req-1' });
    },
  };
}

function createSession(
  stub: ReturnType<typeof createStubHandle>,
  opts?: { turnStallMs?: number; errorSink?: LoggedError[] },
) {
  return new Session({
    id: 'session-1',
    agentKind: 'claude-code',
    workDir: '/repo',
    handle: stub.handle,
    capabilities: {} as never,
    logger: createLogger(opts?.errorSink) as never,
    turnStallMs: opts?.turnStallMs ?? STALL_MS,
  });
}

describe('Session turn stall watchdog', () => {
  it('turn 零事件超阈值 → 推终态 error 并中断 turn', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      const terminal = seen.find((ev) => ev.type === 'error');
      expect(terminal).toBeDefined();
      const data = terminal!.data as { isTerminal?: boolean; reason?: string };
      expect(data.isTerminal).toBe(true);
      expect(data.reason).toBe('turn_no_event_timeout');
      expect(stub.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('每个事件都重置计时:持续有动静的长 turn 不被中断', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      // 总时长远超阈值,但每次都在阈值内来了新事件
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
        stub.pushEvent({ type: 'text', data: { text: `chunk ${i}` }, source: 'claude-code' } as AgentEvent);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('等用户回应交互期间不计时(离开电脑不该被判卡死)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));
      // listener 永不回应 —— 模拟用户离开
      session.setInteractionListener(() => new Promise(() => {}) as never);

      await session.send('go');
      void stub.callInteraction();
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('交互回应之后重新起表(排除项不能变成永久豁免)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));
      let answer!: (decision: unknown) => void;
      session.setInteractionListener(
        () => new Promise((resolve) => { answer = resolve as (d: unknown) => void; }) as never,
      );

      await session.send('go');
      const interaction = stub.callInteraction();
      await vi.advanceTimersByTimeAsync(STALL_MS * 3);
      expect(stub.abort).not.toHaveBeenCalled();

      // 用户回应了 → 球又回到 agent 手里,计时必须恢复
      answer({ kind: 'permission', behavior: 'allow' });
      await interaction;
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      expect(seen.some((ev) => ev.type === 'error')).toBe(true);
      expect(stub.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('有后台任务在跑时不计时(后台 Bash / subagent 期间安静是正常的)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({
        backgroundTasks: [{ taskId: 'task-1' } as unknown as BackgroundTaskSnapshot],
      });
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('turn 正常收 done 之后收表,空闲会话不再被判卡死', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      stub.endTurn();
      stub.pushEvent({ type: 'done', data: {}, source: 'claude-code' } as AgentEvent);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('合成的超时 error 带 turnOrigin,并在 fan-out 后清空(review 第二轮)', async () => {
    // 不带 origin 的话:goal-host 把它归类成 origin:'other' 并像用户插话一样暂停 goal,
    // scheduler 的 IM 转播则直接忽略这条终态,卡片永不 finalize。
    vi.useFakeTimers();
    try {
      const origin: SendOrigin = {
        kind: 'scheduler',
        scheduleId: 'sch-1',
        scheduleName: 'PR #944 心跳',
      };
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go', { origin });
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      const terminal = seen.find((ev) => ev.type === 'error');
      expect(terminal).toBeDefined();
      expect(terminal!.turnOrigin).toEqual(origin);

      // 终态之后 origin 必须清空:下一轮无 origin 的 turn 不该继承它
      stub.pushEvent({ type: 'status', data: { isRunning: false }, source: 'claude-code' } as AgentEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.at(-1)!.turnOrigin).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort 不生效时关闭会话以真正恢复(review 第三轮)', async () => {
    // 各 agent 在中断失败时都只记日志、不清 turn-in-flight 状态,于是 isTurnRunning()
    // 恒 true、后续 send 全被 SESSION_RUNNING 拒 —— 看门狗"报告已恢复"实际什么都没恢复。
    // 复核发现 turn 仍在跑就关掉会话,下次 send 由 Maker 的 lazy create 重建 handle。
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({ abortIneffective: true });
      const session = createSession(stub);
      session.onEvent(() => {});

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      expect(stub.abort).toHaveBeenCalledTimes(1);
      // 宽限期内不急着关:interrupt 成功后 turn 的终态事件要走一圈才让 isTurnRunning 翻假
      expect(session.getStatus()).not.toBe('closed');

      await vi.advanceTimersByTimeAsync(STALL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort() 自己也悬挂时仍会复核并关闭会话', async () => {
    // 复核定时器曾经排在 abort() 的 .finally() 里。但 abort 走的正是"已经哑火"的那条
    // 链路:它自己悬挂(turn/interrupt RPC 永不返回)时 promise 永不 settle → finally
    // 永不执行 → 复核永不发生 → 会话永久不可用,恰好是本看门狗要救的场景
    // (review #944 第五轮 Copilot)。
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({ abortHangs: true });
      const session = createSession(stub);
      session.onEvent(() => {});

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      expect(stub.abort).toHaveBeenCalledTimes(1);
      expect(session.getStatus()).not.toBe('closed');

      await vi.advanceTimersByTimeAsync(STALL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期内新起的 turn 不被误关(复核绑定到超时那一个 turn)', async () => {
    // isTurnRunning() 只回答"有 turn 在跑",不回答"是不是那一个"。abort 生效后用户/调度器
    // 在 10s 宽限内起了新 turn,不加 turn 代号的复核会把这条健康的活儿一起关掉
    // (review #944 第七轮 P1)。
    vi.useFakeTimers();
    try {
      const stub = createStubHandle(); // abort 生效 → 卡死的 turn 真的停了
      const session = createSession(stub);
      session.onEvent(() => {});

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      expect(stub.abort).toHaveBeenCalledTimes(1);

      // 宽限没走完就起了新 turn(abort 已生效,isTurnRunning 已翻假,send 不会被拒)
      await session.send('next');
      await vi.advanceTimersByTimeAsync(STALL_ABORT_RECOVERY_GRACE_MS + 1);

      // 新 turn 还在跑 —— 绝不能因为"有 turn 在跑"就把会话关掉
      expect(session.getStatus()).not.toBe('closed');
      expect(session.isTurnRunning()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort 生效时不关闭会话(会话仍可用,不该被误关)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle(); // abort 正常生效
      const session = createSession(stub);
      session.onEvent(() => {});

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      await vi.advanceTimersByTimeAsync(STALL_ABORT_RECOVERY_GRACE_MS + 1);

      expect(stub.abort).toHaveBeenCalledTimes(1);
      expect(session.getStatus()).not.toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('系统挂起期间不计额度,醒来不立刻开火', async () => {
    // Electron 被系统挂起(合盖睡眠)期间没有任何事件,而一个 45 分钟的长定时器一旦在
    // 唤醒后到期就立刻开火 —— 一次午休就足以让看门狗给完全健康的 turn 推终态 error
    // 并中断它(review #944 第十二轮 P1)。改成分片计时后,片尾发现壁钟走得远超片长
    // 就判定被冻结过,该片不计入额度。
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      // 合盖睡 8 小时:壁钟前进,但定时器没有按比例推进
      vi.setSystemTime(Date.now() + 8 * 3_600_000);
      await vi.advanceTimersByTimeAsync(STALL_MS);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();

      // 吸收不等于豁免:醒来后继续静默满一个阈值,照常开火
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      expect(stub.abort).toHaveBeenCalledTimes(1);
      expect(
        seen.some(
          (ev) =>
            ev.type === 'error' &&
            (ev.data as { reason?: string } | null)?.reason === 'turn_no_event_timeout',
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清醒状态下的长时间静默照常开火(分片不该变成永久豁免)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      session.onEvent(() => {});

      await session.send('go');
      // 一路清醒地静默:每一片的真实耗时都等于片长,额度正常累减
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);
      expect(stub.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动 abort 不生效时也会复核并关闭会话', async () => {
    // 用户按 Stop 时 abort() 会先 clearTurnStallWatchdog()。若 transport 已不响应
    // (codex 的 turn/interrupt 悬挂 / claude 的 interrupt 失败且不清 turn-in-flight),
    // Session 层唯一的复核定时器就这么被关掉了、agent 层的 idle 表也随中断收了 ——
    // isTurnRunning() 恒 true,之后每条 send 都被拒(review #944 第十一轮 P1)。
    vi.useFakeTimers();
    try {
      // 关掉零事件看门狗:本用例只验手动 abort 这条恢复路径,否则两个定时器阈值
      // 撞在一起(都是 60s),分不清是谁开的火。
      const stub = createStubHandle({ abortIneffective: true });
      const session = createSession(stub, { turnStallMs: 0 });
      session.onEvent(() => {});

      await session.send('go');
      await session.abort(); // 用户按 Stop;中断没生效
      expect(session.isTurnRunning()).toBe(true);
      // 手动路径的宽限远比看门狗长 —— 健康但慢的 interrupt 不该被误判
      await vi.advanceTimersByTimeAsync(STALL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).not.toBe('closed');

      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期内系统挂起 → 不吃掉给 interrupt 的清醒时间,醒来不立刻关会话', async () => {
    // 合盖睡眠期间 transport 一个字节都收不到,而裸定时器一旦在唤醒后到期就立刻开火:
    // 一次午休能把"给 interrupt 的 60s"变成 0s 有效时间,复核于是关掉一条其实还响应得动
    // 的会话(第十八轮 P1)。宽限也要走分片计时,与看门狗本体同源。
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({ abortIneffective: true });
      const session = createSession(stub, { turnStallMs: 0 });
      session.onEvent(() => {});

      await session.send('go');
      await session.abort();
      // 合盖睡 8 小时:壁钟前进,定时器没按比例推进
      vi.setSystemTime(Date.now() + 8 * 3_600_000);
      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).not.toBe('closed'); // 那一片作废,宽限重新开始

      // 吸收不等于豁免:醒来后清醒地走满宽限,该关照样关
      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('复核日志写的是真正生效的宽限与触发来源', async () => {
    // 复核定时器被两条路径共用(手动 60s / 看门狗 10s),且幂等只保留最早排定的那一次。
    // 诊断字段写死任一常量,事故日志就会把手动 Stop 说成看门狗、把 60s 说成 10s ——
    // 这条日志正是真机排查唯一的线索(review #944 第十八轮 Copilot)。
    vi.useFakeTimers();
    try {
      const errors: LoggedError[] = [];
      const stub = createStubHandle({ abortIneffective: true });
      const session = createSession(stub, { turnStallMs: 0, errorSink: errors });
      session.onEvent(() => {});

      await session.send('go');
      await session.abort();
      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);

      const recovery = errors.find((e) => e.msg.includes('turn still running after abort'));
      expect(recovery?.meta).toMatchObject({
        trigger: 'manual-abort',
        graceMs: MANUAL_ABORT_RECOVERY_GRACE_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动 abort 生效后新起的 turn 不被误关', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle(); // abort 正常生效
      const session = createSession(stub, { turnStallMs: 0 });
      session.onEvent(() => {});

      await session.send('go');
      await session.abort();
      // 宽限没走完就发下一条(abort 已生效,不会被 SESSION_RUNNING 拒)
      await session.send('next');
      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);

      expect(session.getStatus()).not.toBe('closed');
      expect(session.isTurnRunning()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动 abort() 自己悬挂时仍会复核', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({ abortHangs: true });
      const session = createSession(stub, { turnStallMs: 0 });
      session.onEvent(() => {});

      await session.send('go');
      void session.abort(); // 永不 settle
      await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);
      expect(session.getStatus()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turnStallMs=0 关闭看门狗', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = new Session({
        id: 'session-off',
        agentKind: 'claude-code',
        workDir: '/repo',
        handle: stub.handle,
        capabilities: {} as never,
        logger: createLogger() as never,
        turnStallMs: 0,
      });
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS * 10);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
