/*
 * 测试价值
 * - 生产入口与可观察结果：BotAutonomyRuntime（start / evaluate / stop）接真实 RoutineEngine：事件源登记、
 *   内置「跟进」规则落地、阈值事件只叫醒跟进者自己的规则、跟进规则被暂停时改为系统提醒主人、
 *   条件兜底 sweep 只叫醒还有待处理任务且久未被叫醒的伙伴；主人停止的任务不发任何事件；内置规则还没落地时
 *   出现的事件不丢；启动中途被停止不留定时器；伙伴自己的主任务出错不叫醒它自己，总调度（另一个伙伴）照常收到。
 * - Bug／规则依据：docs/product-rules/bot-routines.md「宿主内置事件源 host:sessions」（引擎每次创建后都要
 *   重新登记，事件源表只在内存）与「内置跟进例行任务」；cindy-bots-runtime.md §6.3「没人跟 → 系统提醒」
 *   与「条件兜底」（没有待处理任务的伙伴不被白叫醒）。
 * - 现有覆盖缺口：maker-scheduler 测试只覆盖引擎自身；autonomyRules / taskWatch 不经过引擎，测不到重建后
 *   事件源丢失、followerBotId 过滤与 accepted=0 的提醒分支。
 * - 最小失败输入：引擎重建后不重登记 → publish 抛 "not listening"；waiting 事件叫醒了非跟进者；
 *   跟进规则暂停后主人收不到提醒或被重复提醒；没有待处理任务也被兜底叫醒，或每 30 秒扫描重复叫醒；
 *   停止被当成做完叫醒伙伴；首次安装时事件赶在 ensure 之前发布、accepted=0 后永久丢失；伙伴主任务的欢迎轮出错
 *   后宿主把 errored 发给它自己，排在正在失败的主任务后面打转；启动时第一次读归属失败，补快照里已出错的任务被按
 *   「没人跟」结清、之后归属读到也不再发；内置规则落地失败仍发布（accepted=0 + 回执）后永久丢失；
 *   120 字符的合法伙伴 id 拼出超过 128 字符的规则 id、永远没有内置规则。
 * - tier：unit（真实引擎 + 内存 load/save；状态表 IO 为内存 fake；时间由 now() 推进）。
 */
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { RoutineEngine, type RoutineEngineDeps, type RoutineState } from '@cindy/maker-scheduler';
import type { AutonomyEngine } from '../runtime.js';
import { describe, expect, it, vi } from 'vitest';

import { AUTONOMY_THRESHOLDS, HOST_SESSIONS_SOURCE_ID } from '../../../shared/botAutonomy.js';
import { builtinFollowUpRoutineId } from '../builtinRoutine.js';
import { BotAutonomyRuntime } from '../runtime.js';
import { TaskWatch, type LocalSessionMeta } from '../taskWatch.js';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function meta(id: string): LocalSessionMeta {
  return {
    id, title: `title ${id}`, workingDir: null, status: 'active', hiddenAt: null, source: 'desktop',
    orcaRole: null, laneRole: null, laneBotId: null, interrupted: false, activeTurnStartedAt: null, lastTurnEndedAt: null,
  };
}

/** 灵动岛在交互到来时记下活动时刻 `at`。 */
function waiting(sessionId: string, at = 1): SessionActivitySnapshot {
  return {
    sessionId, phase: 'needs-interaction', interactionKind: 'ask_user_question', startedAtMs: 1, lastActivityAtMs: at,
    currentActionSummary: null, attention: true, workflow: null, turnGeneration: 1, gracefulStopState: 'none', source: 'local',
  } as unknown as SessionActivitySnapshot;
}

function running(sessionId: string): SessionActivitySnapshot {
  return { ...waiting(sessionId), phase: 'running', interactionKind: undefined, attention: false } as SessionActivitySnapshot;
}

function errored(sessionId: string): SessionActivitySnapshot {
  return { ...waiting(sessionId), phase: 'error', interactionKind: undefined, lastActivityAtMs: 5 } as SessionActivitySnapshot;
}

async function setup(options: {
  /** 每次读归属前调用；抛错即这次读失败（模拟启动时读库 / 读文件出错）。 */
  beforeOwnershipRead?: () => void;
  creators?: Record<string, string>;
  extraBots?: string[];
  schedulerOff?: boolean;
  subscribeActivity?: (watch: TaskWatch) => (() => void) | null;
} = {}) {
  let now = 1_000_000;
  let saved: RoutineState | null = null;
  const execute = vi.fn<RoutineEngineDeps['execute']>(async () => ({}));
  const remind = vi.fn();
  const push = vi.fn();
  const engineDeps: RoutineEngineDeps = {
    load: async () => structuredClone(saved),
    save: async (state) => { saved = structuredClone(state); },
    execute,
    id: () => `id-${Math.random().toString(36).slice(2)}`,
    now: () => now,
    changed: () => {},
    onError: () => {},
  };
  const bots = new Map([
    ['sched', { status: 'active', allowSchedulerFollow: false, canonicalSessionId: 'sched-main' }],
    ['a', { status: 'active', allowSchedulerFollow: false, canonicalSessionId: 'a-main' }],
    ['paused-bot', { status: 'paused', allowSchedulerFollow: false }],
    ...(options.extraBots ?? []).map((id) => [id, { status: 'active', allowSchedulerFollow: false }] as const),
  ]);
  const create = (engine: AutonomyEngine) => new BotAutonomyRuntime({
      engine,
      now: () => now,
      log,
      isCurrent: () => true,
      remind,
      push,
      subscribeActivity: options.subscribeActivity ?? (() => () => {}),
      createWatch: (onChange) => new TaskWatch({
        now: () => now,
        log,
        onChange,
        getActivitySnapshots: () => [],
        isToolCallInFlight: () => false,
        getPendingInteractions: () => [],
        readLocalSessions: async (ids) => ids.map(meta),
        readInterruptedSessions: async () => [],
        readOwnership: async () => {
          options.beforeOwnershipRead?.();
          return { bots, creatorBySession: new Map(Object.entries(options.creators ?? {})), responsibleByBot: new Map() };
        },
        readSchedulerOverride: () => ({ customized: !options.schedulerOff, schedulerBotId: options.schedulerOff ? null : 'sched' }),
        listRemoteDevices: async () => null,
        invokeRemote: async () => { throw new Error('unused'); },
      }),
    });
  const runtime = async (engine: RoutineEngine) => {
    const instance = create(engine);
    await instance.start({ timers: false });
    return instance;
  };
  const engine = async () => {
    const created = new RoutineEngine(engineDeps);
    await created.start();
    return created;
  };
  return { runtime, create, engine, execute, remind, push, bots, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('BotAutonomyRuntime with the routine engine', () => {
  it('never wakes for owner tasks without opt-in, while retaining explicitly delegated work', async () => {
    const t = await setup({ schedulerOff: true, creators: { delegated: 'a' } });
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      runtime.watch.applyActivity('mine', errored('mine'));
      runtime.watch.applyActivity('delegated', errored('delegated'));
      await runtime.watch.settled();
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledOnce());
      expect(t.execute.mock.calls[0]![0].botId).toBe('a');
      expect(t.execute.mock.calls[0]![1].events.map(({ event }) => event.subject)).toEqual(['delegated']);
      expect(engine.list('sched')[0].enabled).toBe(true);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('re-registers the host source after an engine rebuild and keeps one built-in rule per active teammate', async () => {
    const t = await setup();
    const first = await t.engine();
    const r1 = await t.runtime(first);
    expect(first.listSources().map((s) => [s.id, s.status])).toEqual([[HOST_SESSIONS_SOURCE_ID, 'listening']]);
    const created = first.list('sched')[0];
    expect(created).toMatchObject({ id: builtinFollowUpRoutineId('sched'), builtin: 'follow-up', silentWhenIdle: true });
    expect(first.list('a')).toHaveLength(1);
    expect(first.list('paused-bot')).toEqual([]);
    r1.stop();
    await first.stop();

    // 账号内重建引擎：事件源表是内存的，新运行体必须重新登记；内置规则幂等，不重复建、不改 revision。
    const second = await t.engine();
    expect(second.listSources()).toEqual([]);
    const r2 = await t.runtime(second);
    expect(second.listSources().map((s) => s.id)).toEqual([HOST_SESSIONS_SOURCE_ID]);
    expect(second.list('sched')).toEqual([created]);
    r2.stop();
    await second.stop();
  });

  it('wakes only the follower for a waiting task and reminds the owner once when its rule is paused', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      runtime.watch.applyActivity('t1', waiting('t1', t.now()));
      await runtime.watch.settled();
      await runtime.evaluate();
      expect(t.execute).not.toHaveBeenCalled();

      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('sched'));
      expect(run.events.map((e) => [e.sourceId, e.event.type, e.event.data.followerBotId, e.event.subject])).toEqual([
        [HOST_SESSIONS_SOURCE_ID, 'waiting', 'sched', 't1'],
      ]);
      expect(t.remind).not.toHaveBeenCalled();

      // 主人暂停了总调度的跟进规则：事件没人接 → 本机任务改为系统提醒，同一事件只提醒一次。
      await engine.put('sched', { ...engine.list('sched')[0]!, enabled: false }, builtinFollowUpRoutineId('sched'));
      runtime.watch.applyActivity('t2', waiting('t2', t.now()));
      await runtime.watch.settled();
      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await runtime.evaluate();
      expect(t.remind).toHaveBeenCalledTimes(1);
      expect(t.remind.mock.calls[0]![0]).toMatchObject({ sessionId: 't2', followerBotId: 'sched' });
      expect(t.execute).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('sweeps a follower only when it has pending tasks and has not been woken for a fallback interval', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    const interval = AUTONOMY_THRESHOLDS.fallbackIntervalMs;
    try {
      // 没有待处理任务：满兜底间隔也不叫醒。
      t.advance(interval);
      await runtime.evaluateFallback();
      expect(t.execute).not.toHaveBeenCalled();

      // 有一条等你的任务、且距启动（视为上次叫醒）已满间隔 → 发一条 sweep；30 秒扫描再来也不重复。
      runtime.watch.applyActivity('t1', waiting('t1', t.now()));
      await runtime.watch.settled();
      await runtime.evaluateFallback();
      await runtime.evaluateFallback();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('sched'));
      expect(run.events.map((e) => [e.event.type, e.event.subject, e.event.data.sessionId, e.event.data.followerBotId])).toEqual([
        ['sweep', 'sched', '', 'sched'],
      ]);

      // 普通事件叫醒也算「被叫醒」：之后要再满一个间隔才兜底。
      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(2));
      t.advance(interval - 1);
      await runtime.evaluateFallback();
      expect(t.execute).toHaveBeenCalledTimes(2);
      t.advance(1);
      await runtime.evaluateFallback();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(3));
      expect(t.execute.mock.calls[2]![1].events.map((e) => e.event.type)).toEqual(['sweep']);
      expect(engine.list('a')[0]!.triggers.some((trigger) => trigger.kind === 'interval')).toBe(false);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('publishes nothing when the owner stops a running task', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      runtime.watch.applyActivity('t1', running('t1'));
      await runtime.watch.settled();
      // 停止：灵动岛直接撤掉条目，没有完成态。
      runtime.watch.applyActivity('t1', null);
      await runtime.watch.settled();
      await runtime.evaluate();
      t.advance(AUTONOMY_THRESHOLDS.fallbackIntervalMs);
      await runtime.sweep();
      expect(t.execute).not.toHaveBeenCalled();
      expect(t.remind).not.toHaveBeenCalled();
      expect(runtime.glance('sched').doneToday).toBe(0);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('does not lose an event that arrives before the built-in rule is in place on first install', async () => {
    const t = await setup();
    const engine = await t.engine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 首次安装：内置规则写盘慢于第一条事件。
    const slow: AutonomyEngine = {
      registerSource: (source) => engine.registerSource(source),
      publish: (...args) => engine.publish(...args),
      ensureBuiltin: async (...args) => { await gate; return engine.ensureBuiltin(...args); },
    };
    const runtime = t.create(slow);
    try {
      const started = runtime.start({ timers: false });
      runtime.watch.applyActivity('t1', errored('t1'));
      await runtime.watch.settled();
      const early = runtime.evaluate();
      release();
      await Promise.all([started, early]);
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      expect(t.execute.mock.calls[0]![1].events.map((e) => [e.event.type, e.event.subject])).toEqual([['errored', 't1']]);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it("never wakes a teammate for its own main task, while the scheduler still follows another teammate's main task", async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      // 两件主任务的欢迎轮都出错：总调度自己的 sched-main，与伙伴 a 的 a-main。
      runtime.watch.applyActivity('sched-main', errored('sched-main'));
      runtime.watch.applyActivity('a-main', errored('a-main'));
      await runtime.watch.settled();
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('sched'));
      expect(run.events.map((e) => [e.event.type, e.event.subject, e.event.data.followerBotId])).toEqual([
        ['errored', 'a-main', 'sched'],
      ]);
      expect(runtime.watch.get('sched-main')).toMatchObject({ canonicalOfBotId: 'sched', followerBotId: null });
      // 满兜底间隔：自己的主任务也不触发对自己的 sweep。
      t.advance(AUTONOMY_THRESHOLDS.fallbackIntervalMs);
      await runtime.evaluateFallback();
      expect(t.execute.mock.calls.every(([, r]) => r.events.every((e) => e.event.subject !== 'sched-main'))).toBe(true);
      // 工作台：自己的主任务不进自己的「等你 / 在做」；总调度仍能看到伙伴 a 的主任务。
      expect(runtime.glance('sched').waiting.map((r) => r.sessionId)).toEqual(['a-main']);
      expect(runtime.glance('a').waiting).toEqual([]);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('does not judge startup tasks before ownership has loaded once, even if the first read fails', async () => {
    let ownershipReads = 0;
    // 与 service 一致：订阅时把灵动岛当前快照同步补进状态表；启动时第一次读归属失败，下一次扫描才读到。
    const t = await setup({
      creators: { t1: 'a' },
      beforeOwnershipRead: () => {
        ownershipReads += 1;
        if (ownershipReads === 1) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      },
      subscribeActivity: (watch) => {
        watch.applyActivity('t1', errored('t1'));
        return () => {};
      },
    });
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      // 让补快照的重算与它触发的判定都有机会先跑（setTimeout 0，不是真实等待）。
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(t.execute).not.toHaveBeenCalled();
      await runtime.sweep();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('a'));
      expect(run.events.map((e) => [e.event.type, e.event.subject, e.event.data.followerBotId])).toEqual([
        ['errored', 't1', 'a'],
      ]);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('keeps an event for the next scan when the built-in rule cannot be written yet', async () => {
    const t = await setup();
    const engine = await t.engine();
    let failing = true;
    const publish = vi.fn<AutonomyEngine['publish']>((...args) => engine.publish(...args));
    const flaky: AutonomyEngine = {
      registerSource: (source) => engine.registerSource(source),
      publish,
      ensureBuiltin: async (...args) => {
        if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return engine.ensureBuiltin(...args);
      },
    };
    const runtime = t.create(flaky);
    try {
      await runtime.start({ timers: false });
      runtime.watch.applyActivity('t1', errored('t1'));
      await runtime.watch.settled();
      // 规则落地失败：不发布、不结清，留到下一次扫描。
      await runtime.evaluate();
      expect(publish).not.toHaveBeenCalled();

      failing = false;
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      expect(publish).toHaveBeenCalledTimes(1);
      expect(t.execute.mock.calls[0]![1].events.map((e) => [e.event.type, e.event.subject])).toEqual([['errored', 't1']]);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('gives a teammate with a long id a valid built-in rule id, and keeps short ids unchanged', async () => {
    const longId = `b${'x'.repeat(119)}`;
    const shortId = 'teammate-0123456789abc';
    const t = await setup({ extraBots: [longId, shortId] });
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      // 已落盘的普通伙伴规则 id 不变：仍是前缀 + 伙伴 id。
      expect(engine.list(shortId).map((r) => r.id)).toEqual([`builtin-follow-up-${shortId}`]);
      // 120 字符的合法伙伴 id：拼接超过 128 字符，改用稳定的摘要 id，规则照样落地。
      const id = builtinFollowUpRoutineId(longId);
      expect(id).toMatch(/^[a-zA-Z0-9_-]{16,128}$/);
      expect(builtinFollowUpRoutineId(longId)).toBe(id);
      expect(engine.list(longId).map((r) => r.id)).toEqual([id]);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果：BotAutonomyRuntime.sweep → 状态表 onChange → 节流推送，界面收到 push 的次数。
   * - Bug／规则依据：页脚「上次看过 N 分钟前」读 lastSweepAt；推送签名曾不含它，没有别的变化时界面一直停在旧时间。
   * - 现有覆盖缺口：其它用例不观察 push。
   * - 最小失败输入：两次扫描之间状态表不变、时间跨过一分钟（应推）与只过 10 秒（不推）。
   * - tier：unit（时间由 now() 推进；节流定时器为 setTimeout 0，不是真实等待）。
   */
  it('refreshes the workbench footer when a sweep crosses a minute, even if no task changed', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
    try {
      await flush();
      t.push.mockClear();
      t.advance(60_000);
      await runtime.sweep();
      await flush();
      expect(t.push).toHaveBeenCalledTimes(1);
      // 同一分钟内再扫一次：页脚不变，不推。
      t.advance(10_000);
      await runtime.sweep();
      await flush();
      expect(t.push).toHaveBeenCalledTimes(1);
      t.advance(60_000);
      await runtime.sweep();
      await flush();
      expect(t.push).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });
});

// Unit §6.3: earlier runtime tests disabled timers and could not detect idle scans.
// Real runtime + TaskWatch, fake clock: default-off -> delegated running -> completed.
it('starts the scan timer only for observed work and releases it when that work ends', async () => {
  vi.useFakeTimers();
  const options = { schedulerOff: true, creators: {} as Record<string, string> };
  const t = await setup(options);
  const runtime = t.create({ registerSource: vi.fn(), publish: vi.fn(async () => ({ accepted: 0, duplicate: false })),
    ensureBuiltin: vi.fn(async () => ({} as never)) });
  const sweep = vi.spyOn(runtime.watch, 'sweep');
  try {
    await runtime.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).not.toHaveBeenCalled();
    options.creators.child = 'a';
    runtime.watch.applyActivity('child', running('child'));
    await runtime.refreshFollowers();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    runtime.watch.applyActivity('child', null);
    await runtime.watch.settled();
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).not.toHaveBeenCalled();
    options.schedulerOff = false;
    await runtime.refreshFollowers();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    options.schedulerOff = true;
    await runtime.refreshFollowers();
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).not.toHaveBeenCalled();
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

// Unit / PR #6675: a delegation arrives after the watcher went idle, then its one
// ownership refresh fails. Earlier recovery coverage only exercised initial startup.
it('retries a failed delegation ownership refresh while idle and admits the cached activity', async () => {
  vi.useFakeTimers();
  let failRead = false;
  const options = { schedulerOff: true, creators: {} as Record<string, string>,
    beforeOwnershipRead: () => { if (failRead) throw new Error('busy'); } };
  const t = await setup(options);
  const publish = vi.fn<AutonomyEngine['publish']>(async () => ({ accepted: 1, duplicate: false }));
  const runtime = t.create({ registerSource: vi.fn(), publish, ensureBuiltin: vi.fn(async () => ({} as never)) });
  const sweep = vi.spyOn(runtime.watch, 'sweep');
  try {
    await runtime.start();
    options.creators.child = 'a';
    runtime.watch.applyActivity('child', errored('child'));
    failRead = true;
    await runtime.refreshFollowers();
    expect(runtime.watch.get('child')).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    failRead = false;
    t.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledOnce();
    expect(runtime.watch.get('child')).toMatchObject({ followerBotId: 'a', phase: 'errored' });
    expect(publish).toHaveBeenCalledWith(HOST_SESSIONS_SOURCE_ID,
      expect.objectContaining({ type: 'errored', subject: 'child' }), expect.any(Function));
    runtime.watch.applyActivity('child', null);
    await runtime.watch.settled();
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).not.toHaveBeenCalled();
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

// Unit / PR #6675: pausing the selected scheduler is not opting out of observation.
// Check the existing owner reminder through the real runtime and routine engine.
it('keeps opted-in tasks visible and reminds the owner when the scheduler teammate is paused', async () => {
  const t = await setup();
  const engine = await t.engine();
  const runtime = await t.runtime(engine);
  try {
    runtime.watch.applyActivity('mine', waiting('mine', t.now()));
    await runtime.watch.settled();
    t.bots.get('sched')!.status = 'paused';
    await runtime.refreshFollowers();
    expect(runtime.watch.needsSweep()).toBe(true);
    expect(runtime.glance('sched').waiting.map(row => row.sessionId)).toEqual(['mine']);
    expect(runtime.watch.get('mine')?.followerBotId).toBeNull();
    t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
    await runtime.sweep();
    expect(t.remind).toHaveBeenCalledOnce();
    expect(t.execute).not.toHaveBeenCalled();
  } finally {
    runtime.stop();
    await engine.stop();
  }
});

// Unit / #6675: activity can run through completion before the debounced ownership
// refresh. Previous recovery coverage kept the task active until ownership loaded.
// Only a witnessed completion may publish/count; stopped, unrelated and stale
// completed tasks must remain silent. Fake time also covers an ownership retry.
it.each([false, true])('keeps a fast delegation completion across delayed ownership (read failure: %s)', async (failFirstRead) => {
  vi.useFakeTimers();
  let failRead = false;
  const options = { schedulerOff: true, creators: {} as Record<string, string>,
    beforeOwnershipRead: () => { if (failRead) throw new Error('busy'); } };
  const t = await setup(options);
  const publish = vi.fn<AutonomyEngine['publish']>(async () => ({ accepted: 1, duplicate: false }));
  const runtime = t.create({ registerSource: vi.fn(), publish, ensureBuiltin: vi.fn(async () => ({} as never)) });
  const completed = (id: string) => ({ ...running(id), phase: 'completed', lastActivityAtMs: t.now() } as SessionActivitySnapshot);
  try {
    await runtime.start();
    options.creators.child = options.creators.stopped = options.creators.stale = 'a';
    for (const id of ['child', 'unrelated', 'stopped']) runtime.watch.applyActivity(id, running(id));
    for (const id of ['child', 'unrelated', 'stale']) runtime.watch.applyActivity(id, completed(id));
    runtime.watch.applyActivity('stopped', null);
    await runtime.watch.settled();
    expect(publish).not.toHaveBeenCalled();
    expect(runtime.watch.needsSweep()).toBe(false);
    failRead = failFirstRead;
    await runtime.refreshFollowers();
    if (failFirstRead) {
      expect(publish).not.toHaveBeenCalled();
      failRead = false;
      t.advance(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(HOST_SESSIONS_SOURCE_ID,
      expect.objectContaining({ type: 'finished', subject: 'child' }), expect.any(Function));
    expect(runtime.glance('a').doneToday).toBe(1);
    expect(runtime.watch.needsSweep()).toBe(false);
    await runtime.refreshFollowers();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

// Unit / PR #6675: a finished last delegation no longer needs state scans, but a
// failed ensure/publish must retain event delivery and stop retrying after success.
it.each(['ensure', 'publish'] as const)('retries the last completion after %s fails and then releases the timer', async (failure) => {
  vi.useFakeTimers();
  let failing = true;
  const t = await setup({ schedulerOff: true, creators: { child: 'a' } });
  const publish = vi.fn<AutonomyEngine['publish']>(async () => {
    if (failure === 'publish' && failing) throw new Error('publish unavailable');
    return { accepted: 1, duplicate: false };
  });
  const runtime = t.create({ registerSource: vi.fn(), publish, ensureBuiltin: vi.fn(async () => {
    if (failure === 'ensure' && failing) throw new Error('storage unavailable');
    return {} as never;
  }) });
  const sweep = vi.spyOn(runtime.watch, 'sweep');
  try {
    await runtime.start();
    runtime.watch.applyActivity('child', running('child'));
    await runtime.watch.settled();
    runtime.watch.applyActivity('child', { ...running('child'), phase: 'completed' } as SessionActivitySnapshot);
    await runtime.watch.settled();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.watch.needsSweep()).toBe(false);
    failing = false;
    publish.mockClear();
    t.advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(HOST_SESSIONS_SOURCE_ID,
      expect.objectContaining({ type: 'finished', subject: 'child' }), expect.any(Function));
    expect(runtime.watch.get('child')).toBeUndefined();
    expect(runtime.watch.finished().map(row => row.sessionId)).toEqual(['child']);
    sweep.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    // The event ledger expires after 24h. A later settings/activity refresh must not replay it.
    t.advance(25 * 60 * 60_000);
    runtime.watch.applyActivity('child', { ...running('child'), phase: 'completed' } as SessionActivitySnapshot);
    await runtime.refreshFollowers();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});
