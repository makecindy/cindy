import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Scheduler,
  DEFAULT_MAX_CONCURRENT_RUNS,
  RUN_HEARTBEAT_INTERVAL_MS,
  RUN_HEARTBEAT_STALE_MS,
  RUN_LEGACY_STALE_MS,
} from '../engine/scheduler.js';
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleInput,
  ListFilter,
} from '../types.js';
import type { ScheduleStorage } from '../interfaces/schedule-storage.js';
import type { FireContext, FireResult, ScheduleRunner } from '../interfaces/schedule-runner.js';
import type { Logger } from '../interfaces/logger.js';

class InMemoryStorage implements ScheduleStorage {
  schedules = new Map<string, Schedule>();
  runs = new Map<string, ScheduleRun>();
  claimInterruptedRun?: ScheduleStorage['claimInterruptedRun'];
  latestClosureFailure?: ScheduleStorage['latestClosureFailure'];

  async list(filter?: ListFilter): Promise<Schedule[]> {
    const all = [...this.schedules.values()];
    return filter?.status ? all.filter((s) => s.status === filter.status) : all;
  }
  async listActive(): Promise<Schedule[]> {
    return [...this.schedules.values()].filter((s) => s.status === 'active');
  }
  async get(id: string): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    return s ? { ...s } : null;
  }
  async insert(schedule: Schedule): Promise<Schedule> {
    this.schedules.set(schedule.id, { ...schedule });
    return { ...schedule };
  }
  async update(id: string, patch: Partial<Schedule>, expected?: Schedule): Promise<Schedule | null> {
    const ex = this.schedules.get(id);
    if (!ex) return null;
    if (expected && (['lastFiredAt', 'nextFireAt', 'status', 'recurring', 'manual',
      'cronExpr', 'timezone', 'intervalMs', 'expireAt'] as const).some((key) => ex[key] !== expected[key])) return null;
    const merged: Schedule = { ...ex, ...patch };
    if (patch.lastFinishedAt !== undefined) {
      merged.lastFinishedAt = Math.max(ex.lastFinishedAt ?? patch.lastFinishedAt, patch.lastFinishedAt);
    }
    this.schedules.set(id, merged);
    return { ...merged };
  }
  async delete(id: string): Promise<void> {
    this.schedules.delete(id);
  }
  async insertRun(run: ScheduleRun): Promise<ScheduleRun> {
    this.runs.set(run.id, { ...run });
    return { ...run };
  }
  async updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun | null> {
    const ex = this.runs.get(id);
    if (!ex) return null;
    const merged: ScheduleRun = { ...ex, ...patch };
    this.runs.set(id, merged);
    return { ...merged };
  }
  // 与真实现同语义:按 firedAt 降序 + 条数上限(引擎侧不变量绝不能依赖这个
  // 有上限的历史查询,回归测试靠这里的保真复现漏判)。
  async listRuns(scheduleId: string, limit = 50): Promise<ScheduleRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.scheduleId === scheduleId)
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, limit);
  }
  async hasRunningRuns(scheduleId?: string): Promise<boolean> {
    return [...this.runs.values()].some(
      (r) => r.status === 'running' && (scheduleId === undefined || r.scheduleId === scheduleId),
    );
  }
  async hasUnfinishedRuns(scheduleId: string): Promise<boolean> {
    return [...this.runs.values()].some((r) => r.scheduleId === scheduleId &&
      (r.status === 'running' || r.status === 'interrupted'));
  }
  async deleteRun(id: string, options?: { excludeBotSchedules?: boolean }): Promise<ScheduleRun | null> {
    const ex = this.runs.get(id);
    if (!ex || (options?.excludeBotSchedules && this.schedules.get(ex.scheduleId)?.source === 'bot')) return null;
    this.runs.delete(id);
    return { ...ex };
  }
  // 与 DrizzleScheduleStorage 相同语义:带心跳的行按 staleBefore、NULL 心跳行按
  // legacyStaleBefore(未传回落 staleBefore)判过期,excludeRunIds 无条件跳过,
  // 返回受影响 scheduleId(去重)。
  async markRunningAsInterrupted(
    staleBefore: number,
    excludeRunIds: readonly string[] = [],
    opts?: { legacyStaleBefore?: number },
  ): Promise<string[]> {
    const exclude = new Set(excludeRunIds);
    const legacyStaleBefore = opts?.legacyStaleBefore ?? staleBefore;
    const affected: string[] = [];
    for (const r of this.runs.values()) {
      if (r.status !== 'running') continue;
      if (exclude.has(r.id)) continue;
      if (r.heartbeatAt !== undefined && r.heartbeatAt >= staleBefore) continue;
      if (r.heartbeatAt === undefined && r.firedAt >= legacyStaleBefore) continue;
      r.status = 'interrupted';
      r.finishedAt = Date.now();
      r.errorMsg = 'app restarted';
      affected.push(r.scheduleId);
    }
    return [...new Set(affected)];
  }
  async touchRunHeartbeats(runIds: readonly string[], heartbeatAt: number): Promise<void> {
    for (const id of runIds) {
      const r = this.runs.get(id);
      if (r && r.status === 'running') r.heartbeatAt = heartbeatAt;
    }
  }
  // 与 DrizzleScheduleStorage.claimDueFire 相同的 CAS 语义:active 且 nextFireAt
  // 精确匹配才认领成功(置空 nextFireAt),否则返回 null 不动行。
  async claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null> {
    const ex = this.schedules.get(id);
    if (!ex || ex.status !== 'active' || ex.nextFireAt !== expectedNextFireAt) return null;
    ex.nextFireAt = undefined;
    return { ...ex };
  }
}

// Rule (2026-11-06): a host-triggered run must reach the runner with its trigger so the pre-run
// check can skip its own pacing; manual runs stay unmarked. Minimal input: two runNow calls (unit).
it('hands a runNow trigger to the runner and leaves manual runs unmarked', async () => {
  const h = makeHarness();
  await h.scheduler.start();
  const schedule = await h.scheduler.create(baseInput);
  const trigger = { kind: 'watch' as const, source: 'pr-status', detail: 'https://github.com/o/r/pull/1' };
  await h.scheduler.runNow(schedule.id, { trigger });
  await h.scheduler.runNow(schedule.id);
  expect(h.fireCalls.map((call) => call.ctx.trigger)).toEqual([trigger, undefined]);
  await h.scheduler.stop();
});

// Regression: quitting while a runner is active must preserve an interrupted run,
// even when closing the provider produces a late rejection. Unit, in-memory I/O.
it('preserves interrupted runs on app exit instead of recording a provider-close failure', async () => {
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const h = makeHarness({ runnerImpl: async (_schedule, ctx) => {
    await ctx.onSessionBound?.('interrupted-session');
    ctx.onTurnActive?.('interrupted-session');
    entered();
    return new Promise<FireResult>((_resolve, fail) => { reject = fail; });
  } });
  await h.scheduler.start();
  const schedule = await h.scheduler.create(baseInput);
  const pending = h.scheduler.runNow(schedule.id);
  await ready;
  const runId = h.fireCalls[0]!.ctx.runId;
  await h.scheduler.stop({ interrupted: true });
  expect(h.scheduler.isRunAbandoned(runId)).toBe(true);
  expect(h.storage.runs.get(runId)).toMatchObject({ status: 'interrupted', sessionId: 'interrupted-session' });
  reject(new Error('scheduler session ended without a terminal event (closed)'));
  await pending;
  expect(h.storage.runs.get(runId)?.status).toBe('interrupted');
});

// discussion_r4420812417 / unit: a DB snapshot that returns after stop must not
// create another run, even when the same engine has already started again.
it.each([false, true])('drops an old tick after stop (restarted=%s)', async (restarted) => {
  const h = makeHarness();
  await h.scheduler.start();
  await h.scheduler.create({ ...baseInput, intervalMs: 90_000 });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const list = h.storage.listActive.bind(h.storage);
  vi.spyOn(h.storage, 'listActive').mockImplementationOnce(async () => {
    const snapshot = await list();
    entered();
    await held;
    return snapshot;
  });
  h.clock.advance(90_000);
  const tick = h.scheduler.tick();
  try {
    await ready;
    await h.scheduler.stop({ interrupted: true });
    if (restarted) await h.scheduler.start();
    release();
    await tick;
    expect(h.fireCalls).toHaveLength(0);
    expect(h.storage.runs.size).toBe(0);
    expect(h.scheduler.getRuntimeSnapshot().inFlightRuns).toHaveLength(0);
  } finally {
    release();
    await tick;
    await h.scheduler.stop();
  }
});

// discussion_r4419551671: previous exit tests held the runner, not its terminal
// storage write. Public stop must drain the latter without losing silence or
// turning already-ended work into a resumable interruption. Unit, fake timers.
it.each(['automatic', 'manual', 'recovery'].flatMap((source) =>
  [false, true].map((failed) => ({ source, failed })),
))('drains terminal persistence before app exit ($source, failed=$failed)', async ({ source, failed }) => {
  vi.useFakeTimers();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const h = makeHarness({ runnerImpl: async (_schedule, ctx) => {
    await ctx.onSessionBound?.('ending-task');
    ctx.onTurnActive?.('ending-task');
    h.scheduler.silenceRun(ctx.runId);
    if (failed) throw new Error('real execution failure');
    return { sessionId: 'ending-task', resultText: 'finished work' };
  } });
  let running: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await h.scheduler.start();
    const schedule = await h.scheduler.create(baseInput);
    const update = h.storage.updateRun.bind(h.storage);
    vi.spyOn(h.storage, 'updateRun').mockImplementation(async (id, patch) => {
      if (patch.status === 'success' || patch.status === 'failed') { entered(); await held; }
      return update(id, patch);
    });
    if (source === 'recovery') {
      await h.storage.insertRun({ id: 'old-run', scheduleId: schedule.id, sessionId: 'ending-task',
        firedAt: h.clock.now() - 1000, status: 'interrupted' });
      h.storage.claimInterruptedRun = async () => h.storage.updateRun('old-run', { status: 'running' });
      running = (await h.scheduler.resumeInterruptedRun('ending-task'))!.completion;
    } else {
      h.clock.setTo(schedule.nextFireAt!);
      running = source === 'automatic' ? h.scheduler.tick() : h.scheduler.runNow(schedule.id);
    }
    await ready;
    const runId = h.fireCalls[0]!.ctx.runId;
    let stopped = false;
    stopping = h.scheduler.stop({ interrupted: true }).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(h.storage.runs.get(runId)?.status).toBe('running');
    release();
    await running;
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    expect(h.storage.runs.get(runId)).toMatchObject({
      status: failed ? 'failed' : 'success',
      ...(failed ? { errorMsg: 'real execution failure' } : { resultText: 'finished work', readAt: h.clock.now() }),
    });
    expect(h.scheduler.getRuntimeSnapshot().inFlightRuns).toHaveLength(0);
  } finally {
    release();
    await running?.catch(() => {});
    await vi.advanceTimersByTimeAsync(50);
    await stopping?.catch(() => {});
    await h.scheduler.stop();
    vi.useRealTimers();
  }
});

// Before dispatch no user turn exists to continue. Stop at each persistence
// boundary must leave a cancelled row, never a fake resumable interruption.
it.each(['manual-get', 'manual-insert', 'automatic-claim', 'automatic-insert'] as const)(
  'cancels undispatched work when app exit wins the %s pre-registration window', async (boundary) => {
    const h = makeHarness();
    await h.scheduler.start();
    const schedule = await h.scheduler.create(baseInput);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const block = async () => { entered(); await held; };
    if (boundary === 'manual-get') {
      const get = h.storage.get.bind(h.storage);
      vi.spyOn(h.storage, 'get').mockImplementationOnce(async (id) => { await block(); return get(id); });
    } else if (boundary === 'automatic-claim') {
      const claim = h.storage.claimDueFire.bind(h.storage);
      vi.spyOn(h.storage, 'claimDueFire').mockImplementationOnce(async (id, at) => { await block(); return claim(id, at); });
    } else {
      const insert = h.storage.insertRun.bind(h.storage);
      vi.spyOn(h.storage, 'insertRun').mockImplementationOnce(async (run) => { await block(); return insert(run); });
    }
    h.clock.setTo(schedule.nextFireAt!);
    const automatic = boundary.startsWith('automatic');
    const pending = automatic ? h.scheduler.tick() : h.scheduler.runNow(schedule.id);
    const settled = pending.catch((error) => {
      if (automatic) throw error;
      expect(String(error)).toContain('scheduler stopped');
    });
    await ready;
    await h.scheduler.stop({ interrupted: true });
    expect(h.storage.runs.size).toBe(0);
    release();
    await settled;
    expect([...h.storage.runs.values()]).toEqual([
      expect.objectContaining({ status: 'aborted', readAt: h.clock.now() }),
    ]);
    expect(h.runner.fire).not.toHaveBeenCalled();
  },
);

// discussion_r4418886395: a busy target binds a session but has not accepted
// this run's prompt. Existing active-run tests do not cover this queue boundary.
// Real tick/runNow/resume + stop must cancel fresh queues and preserve reclaimed
// original turns, without fabricating a new message or run. In-memory unit I/O.
it.each(['automatic', 'manual', 'recovery'] as const)(
  'distinguishes a fresh queued run from its accepted original on exit (%s)', async (source) => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const h = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      await ctx.onSessionBound?.('busy-task');
      ctx.onQueueWaitStart?.();
      entered();
      return new Promise<FireResult>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('provider closed')), { once: true });
      });
    } });
    await h.scheduler.start();
    const schedule = await h.scheduler.create(baseInput);
    if (source === 'recovery') {
      await h.storage.insertRun({ id: 'old-run', scheduleId: schedule.id, sessionId: 'busy-task',
        firedAt: h.clock.now() - 5000, status: 'interrupted', errorMsg: 'app restarted' });
      h.storage.claimInterruptedRun = async () => h.storage.updateRun('old-run', { status: 'running' });
    }
    h.clock.setTo(schedule.nextFireAt!);
    const pending = source === 'recovery'
      ? (await h.scheduler.resumeInterruptedRun('busy-task'))!.completion
      : source === 'automatic' ? h.scheduler.tick() : h.scheduler.runNow(schedule.id);
    await ready;
    await h.scheduler.stop({ interrupted: true });
    await pending;
    expect([...h.storage.runs.values()]).toEqual([expect.objectContaining({
      status: source === 'recovery' ? 'interrupted' : 'aborted', sessionId: 'busy-task',
    })]);
    expect(h.scheduler.resolveInflightRunForSession('busy-task')).toBeUndefined();
  },
);

it('keeps the original fire context while claiming an interrupted run', async () => {
  const storage = new InMemoryStorage();
  let owner = 'a';
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = makeHarness({ storage, captureFireContext: () => {
    const captured = owner;
    return () => { if (owner !== captured) throw new Error('owner changed'); };
  } });
  const schedule = await h.scheduler.create(baseInput);
  const oldRun: ScheduleRun = { id: 'old-run', scheduleId: schedule.id,
    sessionId: 'original-task', firedAt: h.clock.now() - 5000, status: 'interrupted' };
  await storage.insertRun(oldRun);
  storage.claimInterruptedRun = vi.fn(async () => {
    entered();
    await gate;
    return storage.updateRun(oldRun.id, { status: 'running' });
  });
  await h.scheduler.start();
  const resume = h.scheduler.resumeInterruptedRun('original-task');
  await started;
  owner = 'b';
  release();
  const result = await resume;
  await expect(result!.completion).rejects.toThrow('owner changed');
  expect(h.fireCalls).toHaveLength(0);
  expect(storage.runs.get(oldRun.id)?.status).toBe('interrupted');
  await h.scheduler.stop();
});

// discussion_r4419242692: a claimed continuation must remain reclaimable if
// loading fails, while a rejection after completion must not replay settled work.
// Unit: public resume entry, one original row and a one-shot storage failure.
it.each(['none', 'read-rejected', 'schedule-missing', 'pre-enqueue-rejected', 'finish-rejected'] as const)(
  'restores the same run and silence lookup after restart (%s)', async (failure) => {
  const storage = new InMemoryStorage();
  const clock = new FakeClock();
  let finish!: (result: FireResult) => void;
  let rejectedBeforeAccept = false;
  const h = makeHarness({ storage, clock, runnerImpl: async (_schedule, ctx) => {
    if (failure === 'pre-enqueue-rejected' && !rejectedBeforeAccept) {
      rejectedBeforeAccept = true;
      throw new Error('continuation enqueue unavailable');
    }
    await ctx.onSessionBound?.(ctx.resumeSessionId!);
    ctx.onTurnActive?.(ctx.resumeSessionId!);
    return new Promise<FireResult>((resolve) => { finish = resolve; });
  } });
  const schedule = await h.scheduler.create(baseInput);
  const oldRun: ScheduleRun = { id: 'old-run', scheduleId: schedule.id,
    sessionId: 'original-task', firedAt: clock.now() - 5000,
    status: 'interrupted', errorMsg: 'app restarted', costAttribution: 'exact' };
  await storage.insertRun(oldRun);
  storage.claimInterruptedRun = vi.fn(async () => {
    if (storage.runs.get(oldRun.id)?.status !== 'interrupted') return null;
    return storage.updateRun(oldRun.id, { status: 'running', errorMsg: undefined });
  });
  await h.scheduler.start();
  await h.scheduler.tick();
  expect(storage.claimInterruptedRun).not.toHaveBeenCalled();
  expect(h.fireCalls).toHaveLength(0);
  if (failure === 'read-rejected' || failure === 'schedule-missing' || failure === 'pre-enqueue-rejected') {
    const get = vi.spyOn(storage, 'get');
    if (failure === 'read-rejected') get.mockRejectedValueOnce(new Error('storage unavailable'));
    else if (failure === 'schedule-missing') get.mockResolvedValueOnce(null);
    const failed = await h.scheduler.resumeInterruptedRun('original-task');
    await expect(failed!.completion).rejects.toThrow(
      failure === 'read-rejected' ? 'storage unavailable'
        : failure === 'schedule-missing' ? 'Schedule not found' : 'continuation enqueue unavailable',
    );
    expect(storage.runs.get(oldRun.id)).toMatchObject({ status: 'interrupted', sessionId: oldRun.sessionId, costAttribution: 'exact' });
    expect(h.fireCalls).toHaveLength(failure === 'pre-enqueue-rejected' ? 1 : 0);
    expect(h.scheduler.resolveInflightRunForSession('original-task')).toBeUndefined();
  }
  const resumed = await h.scheduler.resumeInterruptedRun('original-task');
  expect(resumed).not.toBeNull();
  await expect(h.scheduler.resumeInterruptedRun('original-task')).rejects.toThrow('already continuing');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(h.fireCalls[0]!.ctx).toMatchObject({ runId: oldRun.id, firedAt: oldRun.firedAt, resumeSessionId: oldRun.sessionId });
  expect(h.scheduler.resolveInflightRunForSession('original-task')).toBe(oldRun.id);
  expect(h.scheduler.silenceRun(oldRun.id)).toBe(true);
  if (failure === 'finish-rejected') {
    vi.spyOn(storage, 'update').mockRejectedValueOnce(new Error('completion metadata unavailable'));
  }
  finish({ sessionId: 'original-task', resultText: 'continued and completed' });
  if (failure === 'finish-rejected') {
    await expect(resumed!.completion).rejects.toThrow('completion metadata unavailable');
    expect(await h.scheduler.resumeInterruptedRun('original-task')).toBeNull();
  } else await resumed!.completion;
  await vi.waitFor(() => expect(storage.runs.get(oldRun.id)?.status).toBe('success'));
  expect(storage.runs.size).toBe(1);
  expect(storage.runs.get(oldRun.id)).toMatchObject({ firedAt: oldRun.firedAt,
    errorMsg: undefined, resultText: 'continued and completed', readAt: clock.now() });
  await h.scheduler.stop();
});

// discussion_r4420812422 / unit: live/stale claims must not be revived by
// startup or the periodic sweep while the user has not chosen Continue.
it.each(['running', 'interrupted'] as const)('keeps an unfinished Once idle through startup and sweeps (%s)', async (status) => {
  const h = makeHarness();
  const schedule = await h.scheduler.create({ ...baseInput, recurring: false, intervalMs: 90_000 });
  await h.storage.claimDueFire(schedule.id, schedule.nextFireAt!);
  await h.storage.insertRun({ id: 'original-once', scheduleId: schedule.id, sessionId: 'original-task',
    firedAt: h.clock.now(), heartbeatAt: h.clock.now(), status });
  await h.scheduler.start();
  try {
    for (let step = 0; step < 10; step++) {
      h.clock.advance(30_000);
      await h.scheduler.tick();
    }
    expect(h.fireCalls).toHaveLength(0);
    expect(h.storage.runs.size).toBe(1);
    expect(h.storage.runs.get('original-once')?.status).toBe('interrupted');
    expect(await h.storage.get(schedule.id)).toMatchObject({ status: 'active', nextFireAt: undefined });
  } finally { await h.scheduler.stop(); }
});

// Recovery completes the original trigger: automatic Once expires and automatic
// intervals start at completion; runNow retains its independent schedule slot.
it.each([
  ['automatic', false], ['automatic', true],
  ['manual', false], ['manual', true],
] as const)('preserves %s completion scheduling after restart (recurring=%s)', async (source, recurring) => {
  const storage = new InMemoryStorage();
  const clock = new FakeClock();
  let reject!: (error: Error) => void;
  const original = makeHarness({ storage, clock, runnerImpl: async (_schedule, ctx) => {
    await ctx.onSessionBound?.('original-task');
    ctx.onTurnActive?.('original-task');
    return new Promise<FireResult>((_resolve, fail) => { reject = fail; });
  } });
  await original.scheduler.start();
  const schedule = await original.scheduler.create({ ...baseInput, recurring, intervalMs: 120_000 });
  clock.setTo(schedule.nextFireAt!);
  const pending = source === 'automatic'
    ? original.scheduler.tick() : original.scheduler.runNow(schedule.id);
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  const interrupted = original.fireCalls[0]!.ctx;
  await original.scheduler.stop({ interrupted: true });
  reject(new Error('provider closed'));
  await pending;
  storage.claimInterruptedRun = vi.fn(async () =>
    storage.updateRun(interrupted.runId, { status: 'running', errorMsg: undefined }));
  const restarted = makeHarness({ storage, clock });
  await restarted.scheduler.start();
  const nextBefore = (await storage.get(schedule.id))!.nextFireAt;
  if (!recurring) {
    // discussion_r4420812422: before the user clicks Continue, startup/tick
    // must not send the initial Once prompt again. Recovery retains the run.
    clock.advance(600_000);
    await restarted.scheduler.tick();
    expect(restarted.fireCalls).toHaveLength(0);
    expect(storage.runs.get(interrupted.runId)?.status).toBe('interrupted');
  }
  clock.advance(30_000);
  const resumed = await restarted.scheduler.resumeInterruptedRun('original-task');
  await resumed!.completion;
  const completed = (await storage.get(schedule.id))!;
  expect(completed.lastFiredAt).toBe(interrupted.firedAt);
  expect(completed.lastFinishedAt).toBe(clock.now());
  expect(completed.status).toBe(source === 'automatic' && !recurring ? 'expired' : 'active');
  expect(completed.nextFireAt).toBe(source === 'automatic'
    ? recurring ? clock.now() + 120_000 : undefined
    : nextBefore);
  if (!recurring) {
    clock.advance(600_000);
    await restarted.scheduler.tick();
    expect(restarted.fireCalls).toHaveLength(1);
  }
  expect(storage.runs.size).toBe(1);
  expect(storage.runs.get(interrupted.runId)?.status).toBe('success');
  await restarted.scheduler.stop();
});

// Review discussion_r4418701657: unlike the isolated restart cases above,
// a newer automatic fire finishes while recovery awaits its runner/host lock.
// Public tick + resume entries must preserve that newer fire's schedule fields.
it.each([false, true].flatMap((recurring) => [false, true].flatMap((failed) =>
  ['before-read', 'after-read'].map((timing) => ({ recurring, failed, timing })),
)))('keeps newer completion scheduling during recovery ($recurring, $failed, $timing)', async ({ recurring, failed, timing }) => {
  let finishNewer!: () => void;
  let finishRecovery!: () => void;
  const h = makeHarness({ runnerImpl: async (_schedule, ctx) => {
    await ctx.onSessionBound?.(ctx.resumeSessionId ?? 'newer-task');
    ctx.onTurnActive?.(ctx.resumeSessionId ?? 'newer-task');
    if (ctx.resumeSessionId) {
      await new Promise<void>((resolve) => { finishRecovery = resolve; });
      if (failed) throw new Error('continuation failed');
    } else {
      await new Promise<void>((resolve) => { finishNewer = resolve; });
    }
    return { sessionId: ctx.resumeSessionId ?? 'newer-task' };
  } });
  await h.scheduler.start();
  const schedule = await h.scheduler.create({ ...baseInput, recurring, intervalMs: 120_000 });
  const oldRun: ScheduleRun = { id: 'interrupted-run', scheduleId: schedule.id,
    sessionId: 'original-task', firedAt: h.clock.now() - 5000,
    status: 'interrupted', errorMsg: 'app restarted' };
  await h.storage.insertRun(oldRun);
  h.storage.claimInterruptedRun = async () => h.storage.updateRun(oldRun.id, { status: 'running' });
  h.clock.setTo(schedule.nextFireAt!);
  const newer = h.scheduler.tick();
  await vi.waitFor(() => expect(finishNewer).toBeTypeOf('function'));
  const recovered = await h.scheduler.resumeInterruptedRun('original-task');
  await vi.waitFor(() => expect(finishRecovery).toBeTypeOf('function'));
  let newerSchedule!: Schedule;
  const read = h.storage.get.bind(h.storage);
  const completeNewer = async () => {
    // The old recovery captured finishedAt before its read yielded. A second
    // process can finish later before the conditional write, not just fire later.
    if (timing === 'after-read') h.clock.advance(10_000);
    finishNewer();
    await newer;
    newerSchedule = (await read(schedule.id))!;
  };
  if (timing === 'before-read') await completeNewer();
  else vi.spyOn(h.storage, 'get').mockImplementationOnce(async (id) => {
    const stale = await read(id);
    await completeNewer();
    return stale;
  });
  h.clock.advance(30_000);
  finishRecovery();
  await recovered!.completion;
  expect(newerSchedule.lastFiredAt).toBeGreaterThan(oldRun.firedAt);
  expect(await h.storage.get(schedule.id)).toMatchObject({
    lastFiredAt: newerSchedule.lastFiredAt,
    nextFireAt: newerSchedule.nextFireAt,
    status: newerSchedule.status,
    lastFinishedAt: h.clock.now(),
  });
  expect(h.storage.runs.get(oldRun.id)?.status).toBe(failed ? 'failed' : 'success');
  expect(h.storage.runs.size).toBe(2);
  await h.scheduler.stop();
});

class FakeClock {
  current = Date.UTC(2026, 0, 1, 0, 0, 30); // start at 2026-01-01 00:00:30 UTC
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  setTo(ms: number): void {
    this.current = ms;
  }
}

const baseInput = {
  name: 'test',
  prompt: 'do thing',
  kind: 'cron',
  cronExpr: '* * * * *', // every minute
  timezone: 'UTC',
  recurring: true,
  agentKind: 'claude-code',
  useWorktree: false,
  notify: { desktop: false, feishu: false },
} satisfies CreateScheduleInput;

function makeIdGen(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

interface FireCall {
  schedule: Schedule;
  ctx: FireContext;
}

interface Harness {
  scheduler: Scheduler;
  storage: InMemoryStorage;
  clock: FakeClock;
  runner: ScheduleRunner & { fire: ReturnType<typeof vi.fn> };
  fireCalls: FireCall[];
}

function makeHarness(opts?: {
  runnerImpl?: (s: Schedule, ctx: FireContext) => Promise<FireResult>;
  captureFireContext?: () => () => void;
  isManagedWorkspaceDir?: (dir: string) => boolean;
  validateModelSelection?: (schedule: Schedule, previous?: Schedule) => Promise<void>;
  validateTargetSession?: (
    targetSessionId: string,
    operation: 'create' | 'update' | 'fire',
    selection: Pick<Schedule, 'modelAgentKind'>,
  ) => Promise<void>;
  /** 传入共享 storage / clock 模拟"两个 app 实例共用同一 DB"的双开场景。 */
  storage?: InMemoryStorage;
  clock?: FakeClock;
  generateId?: () => string;
  passive?: boolean;
  maxConcurrentRuns?: number;
  runStallMs?: number;
  runStallAbortGraceMs?: number;
  /** 默认 0(关闭挂起吸收):假时钟跳表与真实睡眠在壁钟上同形,见 SchedulerOptions.suspendGapMs。 */
  suspendGapMs?: number;
  /** 预闸门 storage 等待上限;卡死用例注入小值,让超时在测试壁钟内发生。 */
  preGateStorageTimeoutMs?: number;
  logger?: Logger;
  resolvePreRunPlugin?: (pluginId: string) => string;
}): Harness {
  const storage = opts?.storage ?? new InMemoryStorage();
  const clock = opts?.clock ?? new FakeClock();
  const fireCalls: FireCall[] = [];
  const impl =
    opts?.runnerImpl ??
    (async (s: Schedule) => ({ sessionId: `sess-${s.id}` }));
  const runner = {
    fire: vi.fn(async (s: Schedule, ctx: FireContext) => {
      fireCalls.push({ schedule: s, ctx });
      return impl(s, ctx);
    }),
  };
  const scheduler = new Scheduler({
    storage,
    runner,
    captureFireContext: opts?.captureFireContext,
    clock,
    generateId: opts?.generateId ?? makeIdGen(),
    tickIntervalMs: 60_000_000, // effectively disabled; tests call tick() manually
    isManagedWorkspaceDir: opts?.isManagedWorkspaceDir,
    validateTargetSession: opts?.validateTargetSession,
    validateModelSelection: opts?.validateModelSelection,
    passive: opts?.passive,
    maxConcurrentRuns: opts?.maxConcurrentRuns,
    runStallMs: opts?.runStallMs,
    runStallAbortGraceMs: opts?.runStallAbortGraceMs,
    suspendGapMs: opts?.suspendGapMs ?? 0,
    preGateStorageTimeoutMs: opts?.preGateStorageTimeoutMs,
    logger: opts?.logger,
    resolvePreRunPlugin: opts?.resolvePreRunPlugin,
    instanceId: 'test-scheduler',
    processId: 1234,
  });
  return { scheduler, storage, clock, runner, fireCalls };
}

describe('Scheduler', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  // #11490: 预闸门 storage await 永不 settle 时,tick 必须放弃该阶段并继续
  // due-fire —— 事故里 DB 同步/清扫/补排卡死让并发闸门数小时不放行,六个空槽
  // 却无任何「调度器不能触发」的信号。race 1s 哨兵让旧代码干净地红在断言上,
  // 而不是挂满测试超时。
  it('keeps due-fire alive when the pre-gate DB sync never settles', async () => {
    const warn = vi.fn();
    const local = makeHarness({ logger: { warn }, preGateStorageTimeoutMs: 20 });
    const schedule = await local.scheduler.create(baseInput);
    vi.spyOn(local.storage, 'listActive').mockImplementation(
      () => new Promise<Schedule[]>(() => {}),
    );
    local.clock.setTo(schedule.nextFireAt!);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 必须显著大于修复路径的 20ms storage 上限,让旧代码的无界 await 稳定判 hung 而非偶发竞态
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');
    expect(local.fireCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'scheduler: pre-gate storage await timed out — skipping phase so due-fire can proceed',
      expect.objectContaining({ phase: 'listActive' }),
    );
  });

  // expireSchedule 超时的语义与 DB 同步相反:过期任务本轮**绝不**派发(与真实
  // 异常同向),只放弃等待、下轮重试持久化;tick 本身仍须完成。
  it('skips dispatch of an expired schedule when its persist await never settles', async () => {
    const warn = vi.fn();
    const local = makeHarness({ logger: { warn }, preGateStorageTimeoutMs: 20 });
    const expireAt = local.clock.now() + 60_000;
    await local.scheduler.create({ ...baseInput, expireAt });
    vi.spyOn(local.storage, 'update').mockImplementation(
      () => new Promise<Schedule | null>(() => {}),
    );
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 必须显著大于修复路径的 20ms storage 上限,让旧代码的无界 await 稳定判 hung 而非偶发竞态
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');
    expect(local.fireCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'scheduler: pre-gate storage await timed out — skipping phase so due-fire can proceed',
      expect.objectContaining({ phase: 'expireSchedule' }),
    );
  });

  // Greptile P1 on #11577:逐条各给全量上限时,10 条过期任务的串行写入能推迟
  // due-fire 数十秒。共享预算让整轮过期扫描封顶,预算耗尽后纯同步判定
  // (hasExpired)照做 —— 过期任务不派发,健康到期任务照常触发。
  it('bounds the whole expire scan so healthy due schedules still fire', async () => {
    const warn = vi.fn();
    const local = makeHarness({ logger: { warn }, preGateStorageTimeoutMs: 60 });
    // expireAt 必须建在未来:create() 会按当时的 now 判定,已过期的输入直接建成
    // 'expired' 且没有 nextFireAt,那种行永远进不了过期扫描。过期要靠跳表实现。
    const expireAt = local.clock.now() + 60_000;
    for (let i = 0; i < 3; i++) {
      await local.scheduler.create({ ...baseInput, name: `expired-${i}`, expireAt });
    }
    await local.scheduler.create({ ...baseInput, name: 'healthy-due' });
    const realUpdate = local.storage.update.bind(local.storage);
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired'
        ? new Promise<Schedule | null>(() => {})
        : realUpdate(id, patch, expected),
    );
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 必须显著大于共享预算(60ms),让旧代码的无界 await 稳定判 hung
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.schedule.name).toBe('healthy-due');
    expect(warn).toHaveBeenCalledWith(
      'scheduler: pre-gate storage await timed out — skipping phase so due-fire can proceed',
      expect.objectContaining({ phase: 'expireSchedule' }),
    );
  });

  // Codex P2 on #11577:过期写入已提交但回包晚于上限时,迟到结果不能被吞 ——
  // 唯一的 CAS 胜者必须补发 changed,否则界面把已过期任务一直显示成 active。
  it('emits changed when the expiry write commits after the timeout', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30 });
    // 同上:expireAt 建在未来,过期由跳表触发,否则 create() 直接建成 'expired'。
    const expireAt = local.clock.now() + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseUpdate!: (value: Schedule | null) => void;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired'
        ? new Promise<Schedule | null>((resolve) => { releaseUpdate = resolve; })
        : realUpdate(id, patch, expected),
    );
    const changed: string[] = [];
    local.scheduler.on('changed', (e: { scheduleId: string }) => changed.push(e.scheduleId));
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 修复路径 30ms 内完成,旧代码的无界 await 稳定判 hung
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');
    expect(changed).not.toContain(schedule.id);
    // 迟到提交:回包在超时之后才到,收口必须补发 changed 并把缓存对齐成 expired。
    releaseUpdate(await realUpdate(schedule.id, { status: 'expired', nextFireAt: undefined }, schedule));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toContain(schedule.id);
  });

  // Codex P2 on #11577:存储挂死时过期写入永不 settle,而过期扫描每轮 tick 都跑一次。
  // 不登记在途写入,每秒就为同一条任务多发一条 UPDATE,未完成的请求无界增长 ——
  // 恰好在存储故障期间进一步压制其它任务。一条 schedule 同时只保留一次在途过期
  // 写入,settle 前不再重发。
  it('keeps one in-flight expiry write per schedule when storage never settles', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 20 });
    const expireAt = local.clock.now() + 60_000;
    await local.scheduler.create({ ...baseInput, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let expiryWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expiryWrites += 1;
        return new Promise<Schedule | null>(() => {});
      }
      return realUpdate(id, patch, expected);
    });
    local.clock.setTo(expireAt + 1);
    const runTick = async () => {
      const settled = await Promise.race([
        local.scheduler.tick().then(() => 'tick' as const),
        // real-wait: 挂死哨兵 —— 必须显著大于修复路径的 20ms storage 上限,让旧代码的无界 await 稳定判 hung 而非偶发竞态
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
      ]);
      expect(settled).toBe('tick');
    };
    // 连跑两轮:修复前第二轮会再发一条 UPDATE,修复后在途写入期间不再重发。
    await runTick();
    await runTick();
    expect(expiryWrites).toBe(1);
    expect(local.fireCalls).toHaveLength(0);
  });

  // Codex P2 on #11577:过期写入已提交但回包晚于上限时,用户可能在回包前延长了截止
  // 时间 —— update() 把重新 active 的新行放回缓存,而迟到的仍是早先那次 UPDATE
  // 返回的 expired 快照。无条件应用它会把刚恢复的任务又从缓存里抹掉,下一次 30 秒
  // DB sync 之前 tick() 看不到它,临近的 cron 触发被延后。
  it('keeps a schedule that was extended while its expiry reply was still late', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30 });
    const createdAt = local.clock.now();
    const expireAt = createdAt + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, intervalMs: 15_000, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired'
        ? new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; })
        : realUpdate(id, patch, expected),
    );
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 修复路径 30ms 内完成,旧代码的无界 await 稳定判 hung
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');
    expect(local.fireCalls).toHaveLength(0);

    // 用户在迟到回包到达前延长了截止时间:任务重新 active,缓存换成新的一行。
    const extended = await local.scheduler.update(schedule.id, { expireAt: expireAt + 3_600_000 });
    expect(extended.status).toBe('active');

    // 迟到的过期快照这时才回来 —— 它已经过期,不能盖掉刚恢复的那一版。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: expireAt + 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 任务仍在缓存里:下一轮 tick(还在 30 秒 DB sync 之前)照常派发。
    local.clock.setTo(expireAt + 2_000);
    await local.scheduler.tick();
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.schedule.id).toBe(schedule.id);
  });

  // Codex P1 on #11577:切账号 / 重启时宿主先 stop 调度器(apps/desktop 的
  // resetScheduler),挂死的过期写入随后才回来。stop() 已经清掉 activeSchedules,
  // 过期快照检查「查无新版」会判定它是最新版本,把上一段生命周期的结果写回缓存
  // 并广播 changed —— 新主人会收到上一账号的时间线。
  it('drops an expiry reply that arrives after stop', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30 });
    const changed: string[] = [];
    local.scheduler.on('changed', (e: { scheduleId: string }) => changed.push(e.scheduleId));
    const expireAt = local.clock.now() + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired'
        ? new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; })
        : realUpdate(id, patch, expected),
    );
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 修复路径 30ms 内完成,旧代码的无界 await 稳定判 hung
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');

    // 宿主停机(切账号 / 重启):调度器换代。
    await local.scheduler.stop();
    changed.length = 0;

    // 挂死的过期写入这时才回来 —— 属于上一段生命周期,不得再改状态或广播。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: expireAt + 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toEqual([]);
  });

  // Codex P1 on #11577:用户延长截止时间后任务重新 active、到点进入派发队列,新行
  // 已从 activeSchedules 摘走(只在 automaticDispatchSchedules 里)。这时迟到的过期
  // 快照若只查 activeSchedules 就「查无此行」,会被当成最新版本并覆盖派发守卫,
  // canDispatch 变 false,一次本该触发的运行被推迟。
  it('keeps the in-flight dispatch snapshot when the expiry reply arrives late', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      // 派发停在途中:快照留在 automaticDispatchSchedules,便于观察守卫。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    const createdAt = local.clock.now();
    const expireAt = createdAt + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, intervalMs: 15_000, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired'
        ? new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; })
        : realUpdate(id, patch, expected),
    );
    local.clock.setTo(expireAt + 1);
    const settled = await Promise.race([
      local.scheduler.tick().then(() => 'tick' as const),
      // real-wait: 挂死哨兵 —— 修复路径 30ms 内完成,旧代码的无界 await 稳定判 hung
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(settled).toBe('tick');

    // 用户在迟到回包到达前延长截止时间,任务重新 active。
    const extended = await local.scheduler.update(schedule.id, { expireAt: expireAt + 3_600_000 });
    expect(extended.status).toBe('active');

    // 到点 → 进入派发队列:新行从 activeSchedules 摘走,只留在派发快照里。
    local.clock.setTo(expireAt + 2_000);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 迟到的过期快照这时才回来 —— 它比派发中的那一版旧,不能覆盖派发守卫。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: expireAt + 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    await local.scheduler.stop();
  });

  // Codex P1 on #11577:代次必须在**发起**过期写入时取,不能在超时之后才取。
  // 等待期间宿主 stop()(切账号 / 重启)会把代次推进;若超时后才取,拿到的是新
  // 主人的代次,上一段生命周期发起的写入回来时混过校验,把上一账号的过期结果
  // 写回缓存并广播给新主人。
  it('drops an expiry reply that arrives after a stop during the expiry wait', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 200 });
    const changed: string[] = [];
    local.scheduler.on('changed', (e: { scheduleId: string }) => changed.push(e.scheduleId));
    const expireAt = local.clock.now() + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    let expireLaunched = false;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireLaunched = true;
        return new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; });
      }
      return realUpdate(id, patch, expected);
    });
    local.clock.setTo(expireAt + 1);
    // 过期写入挂起:这一轮 tick 卡在等回包上(共享预闸门预算 200ms)。
    const tickPromise = local.scheduler.tick();
    for (let i = 0; i < 100 && !expireLaunched; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(expireLaunched).toBe(true);

    // 等待期间宿主换代(切账号 / 重启)。
    await local.scheduler.stop();
    changed.length = 0;
    await tickPromise;

    // 挂死的过期写入这时才回来 —— 属于上一段生命周期,不得改状态或广播。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: expireAt + 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toEqual([]);
  });

  // Codex P2 on #11577:DB sync 刷新派发守卫快照时,迟到的读必须用**原来那次**的
  // 结果。超时后另起一次读,那次读更慢(或失败)时,守卫快照会一直停在旧
  // deadline —— 别的实例已经过期掉的任务仍会被排队中的 run 放行。
  it('refreshes the dispatch guard from the original read when the sync read is late', async () => {
    const local = makeHarness({
      logger: { warn: vi.fn() },
      preGateStorageTimeoutMs: 30,
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules,便于观察。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const expireAt = createdAt + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, intervalMs: 15_000, expireAt });

    // 到点派发:快照进 automaticDispatchSchedules,守卫可观察。
    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 别的实例把这条任务过期掉了(行离开 listActive):DB sync 必须回读它来刷新
    // 守卫快照。
    const expiredRow: Schedule = {
      ...schedule,
      status: 'expired',
      nextFireAt: undefined,
      expireAt: createdAt - 1,
      updatedAt: createdAt + 1,
    };
    local.storage.schedules.set(schedule.id, expiredRow);

    // 这一读很慢:超时之后才回来。
    let releaseRead!: (value: Schedule | null) => void;
    const lateRead = new Promise<Schedule | null>((resolve) => { releaseRead = resolve; });
    let reads = 0;
    const realGet = local.storage.get.bind(local.storage);
    vi.spyOn(local.storage, 'get').mockImplementation(async (id: string) => {
      if (id !== schedule.id) return realGet(id);
      reads += 1;
      // 旧代码的第二读:更慢(直接挂死)—— 守卫就永远停在旧 deadline。
      if (reads > 1) return new Promise<Schedule | null>(() => {});
      return lateRead;
    });

    // 触发周期 DB sync(30s 间隔)。
    local.clock.advance(30_000);
    await local.scheduler.tick();

    // 迟到的读回来:守卫必须用这一版快照(截止时间已过 → 不再放行)。
    releaseRead(expiredRow);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);
    // 只有原来那一读:不能再靠另起一次读来兜底。
    expect(reads).toBe(1);

    await local.scheduler.stop();
  });

  // Codex P1 on #11577:CAS 败者后的回读超时,迟到的结果不能丢。原实现把回读的
  // promise 丢在超时里,迟到收口另起一次读 —— 那次更慢(或失败)时,这一行的
  // 结果就丢了,缓存一直停在旧的(已过期)截止时间,临近的触发要等到下一次
  // DB sync 才恢复;每轮 tick 还能再堆一次读。
  it('reconciles the expiry cache from the original fallback read when it is late', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30 });
    const createdAt = local.clock.now();
    const expireAt = createdAt + 2_000;
    const schedule = await local.scheduler.create({ ...baseInput, intervalMs: 1_000, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    const realGet = local.storage.get.bind(local.storage);
    // CAS 败者:这一行已被别的实例改过,过期写入拿不到行。
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired' ? Promise.resolve(null) : realUpdate(id, patch, expected),
    );
    // 别的实例延长了截止时间并重新排期。
    const extended: Schedule = {
      ...schedule,
      expireAt: createdAt + 3_600_000,
      nextFireAt: createdAt + 1_500,
      updatedAt: createdAt + 1_200,
    };
    let releaseRead!: (value: Schedule | null) => void;
    let reads = 0;
    let reconciled = false;
    vi.spyOn(local.storage, 'get').mockImplementation(async (id: string) => {
      if (id !== schedule.id) return realGet(id);
      reads += 1;
      // 第一次(CAS 败者后的回读)很慢,超时之后才回来。
      if (reads === 1) return await new Promise<Schedule | null>((resolve) => { releaseRead = resolve; });
      // 对齐之前再读 —— 旧代码的重试读就是这样挂死的(结果也就丢了)。
      if (!reconciled) return new Promise<Schedule | null>(() => {});
      return realGet(id);
    });

    // 第一轮:把这一行同步进内存(还没有过期)。
    await local.scheduler.tick();
    // 别的实例改了行:内存里那份还是旧的(截止时间已过)。
    local.storage.schedules.set(schedule.id, extended);
    local.clock.setTo(expireAt);
    // 第二轮:过期扫描 → CAS 败者 → 回读超上限。
    await local.scheduler.tick();

    // 迟到的回读回来:缓存必须用这一行对齐(任务重新 active、已排期)。
    releaseRead(extended);
    await new Promise((resolve) => setTimeout(resolve, 0));
    reconciled = true;
    // 只有原来那一读:不能再靠另起一次读来兜底。
    expect(reads).toBe(1);

    // 第三轮:任务照常派发 —— 旧截止时间那一份已被换掉。
    local.clock.setTo(expireAt + 1);
    await local.scheduler.tick();
    expect(local.fireCalls).toHaveLength(1);
  });

  // Codex P1 on #11577:补排重试卡死时,后续 tick 不能对同一条任务再起一份。
  // pendingReplans 的条目要等这次补排 settle 才摘掉,而预闸门超时只放弃「等」——
  // 活儿还在跑。存储故障期间每 tick 再起一份就是无界的存储调用堆积,反而饿死
  // 本来要保住的 due-fire。
  it('keeps a stalled replan single-flight across ticks', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realGet = h.storage.get.bind(h.storage);
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        replanReads += 1;
        // 第一次(强制收口那次的补排)失败 → 条目留在 pendingReplans 等重试;
        // 之后的补排重试挂死 —— 存储卡死的形态。
        if (replanReads === 1) throw new Error('storage unavailable');
        return new Promise<Schedule | null>(() => {});
      });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 跨过无进展阈值 → abort;跨过宽限 → 强制收口 → 补排(这一次失败,条目上膛)。
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 之后的每轮 tick 都会重试补排:挂死的那一次不能被重复发起。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #11577:补排重飞只按 scheduleId 压制。上一轮的补排永久挂死(存储
  // 调用永不返回),任务仍可能被编辑重新触发、又跑挂新一轮 —— 新 run 的凭据顶替了
  // 旧条目,但旧那一轮的在途登记还在,后续每个 tick 都在「上一轮还在途」处跳过,
  // 新 run 的补排永远发不出去:它认领过的任务没有 nextFireAt,直到进程重启。
  it('retries a newer run replan past a wedged older one', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realGet = h.storage.get.bind(h.storage);
      let replanReads = 0;
      // 补排读的剧本:'fail' 这次没做成(凭据上膛)、'wedge' 永久挂死、'real' 照常。
      let mode: 'fail' | 'wedge' | 'real' = 'real';
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        replanReads += 1;
        if (mode === 'wedge') return new Promise<Schedule | null>(() => {});
        if (mode === 'fail') return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });

      // 第一轮 run:跑挂 → 强制收口那次的补排失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      mode = 'fail';
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 补排重试永久挂死:登记留着,任务没有排期。
      mode = 'wedge';
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 用户编辑让任务重新触发(update 自己要走 storage.get,先让读恢复正常),
      // 新一轮 run 又跑挂 → 它的补排失败,凭据顶替旧条目。
      mode = 'real';
      await h.scheduler.update(sch.id, { intervalMs: 1_800_000 });
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toEqual(expect.any(Number));
      h.clock.advance(1_800_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      mode = 'fail';
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 之后每个 tick 都必须重试**新那一轮**的补排:挂死的旧登记不能把它挡掉。
      mode = 'real';
      for (let i = 0; i < 3; i += 1) {
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toEqual(expect.any(Number));

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #11577:凭据判旧只比「队列里那一凭据」不够 —— 摘掉凭据之后,旧一轮
  // 迟到的失败会因为「队列里没有凭据」而把陈旧计划重新上膛。任务那时已被重新认领、
  // 正在跑新一轮,这次重试会再排一次触发(共享 DB 下就是重叠执行)。
  it('keeps a wedged replan from re-arming after a newer one concluded', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      let rejectWedged!: (reason: Error) => void;
      // 补排读的剧本:'fail' 这次没做成(凭据上膛)、'wedge' 永久挂死、'real' 照常。
      let mode: 'fail' | 'wedge' | 'real' = 'real';
      // 补排写(认领之外的 nextFireAt 写入)逐个记下来:陈旧计划重新上膛后,重试它会
      // 再写一次排期 —— 那就是共享 DB 下的重叠执行。
      const replanWrites: (number | undefined)[] = [];
      vi.spyOn(h.storage, 'update').mockImplementation((id, patch, expected) => {
        if (patch.nextFireAt !== undefined) replanWrites.push(patch.nextFireAt);
        return realUpdate(id, patch, expected);
      });
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (mode === 'wedge') {
          return new Promise<Schedule | null>((_resolve, reject) => { rejectWedged = reject; });
        }
        if (mode === 'fail') return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });

      // 第一轮 run:跑挂 → 强制收口那次的补排失败(凭据上膛)→ 重试挂死。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      mode = 'fail';
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();
      mode = 'wedge';
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 用户编辑让任务重新触发,新一轮 run 又跑挂 → 它的补排**成功**,凭据被摘掉。
      mode = 'real';
      await h.scheduler.update(sch.id, { intervalMs: 1_800_000 });
      h.clock.advance(1_800_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toEqual(expect.any(Number));

      // 任务再次被认领(第三轮 run 在跑,nextFireAt 已清空)。
      replanWrites.length = 0;
      h.clock.advance(1_800_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 挂死的旧那一轮补排终于失败:不能把陈旧计划重新上膛。
      rejectWedged(new Error('storage unavailable'));
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 3; i += 1) {
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
      }
      // 没有新的补排写,也没有在第三轮 run 在跑时又排一次触发。
      expect(replanWrites).toEqual([]);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #11577:预算内回来的过期写入同样要过代次栅栏。等待期间宿主
  // stop()(切账号 / 重启)把 lifecycleGeneration 推进了,这次 UPDATE 属于上一段生命
  // 周期;不走超时分支就不会经过 armExpireLateApply 的栅栏,它的 CAS 结果会被写回
  // 缓存并广播 changed —— 新主人于是看到上一个账号的时间线。
  it('drops an in-budget expiry completion that lands after a stop', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 5_000 });
    const changed: string[] = [];
    local.scheduler.on('changed', (e: { scheduleId: string }) => changed.push(e.scheduleId));
    const expireAt = local.clock.now() + 60_000;
    const schedule = await local.scheduler.create({ ...baseInput, expireAt });
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    let expireLaunched = false;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireLaunched = true;
        // 在预算内(5s)回来,但回来之前宿主先 stop()。
        return new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; });
      }
      return realUpdate(id, patch, expected);
    });
    local.clock.setTo(expireAt + 1);
    const tickPromise = local.scheduler.tick();
    for (let i = 0; i < 100 && !expireLaunched; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(expireLaunched).toBe(true);

    await local.scheduler.stop();
    changed.length = 0;
    // 这次 UPDATE 在预算内完成(不走超时分支),仍属于上一段生命周期。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: expireAt + 1 });
    await tickPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toEqual([]);
  });

  // Codex P1 on #11577:CAS 败者后的回读迟到回来时,要和迟到的 UPDATE 用同一把尺子。
  // 回读发起时用户还没改期,回包里是更早的、截止时间更长的那一版;无条件应用它,
  // 排队中的 run 就会拿着已作废的 expireAt 放行。
  it('rejects a stale CAS-loser fallback read before replacing dispatch guards', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules,便于观察。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 60_000,
    });

    // 到点派发:守卫快照 = 原始那一版(截止时间在 60s 后)。
    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 另一实例把这一行的截止时间改短(已经过期),行重新排期后仍在 listActive 里:
    // 下一次 DB sync 把它带回 activeSchedules,过期扫描才会走到 CAS 败者分支。
    const shortened: Schedule = {
      ...schedule,
      expireAt: createdAt + 16_000,
      updatedAt: createdAt + 5,
    };
    local.storage.schedules.set(schedule.id, shortened);
    local.clock.advance(30_000);

    const realUpdate = local.storage.update.bind(local.storage);
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) =>
      patch.status === 'expired' ? Promise.resolve(null) : realUpdate(id, patch, expected),
    );
    let releaseRead!: (value: Schedule | null) => void;
    let reads = 0;
    const realGet = local.storage.get.bind(local.storage);
    vi.spyOn(local.storage, 'get').mockImplementation(async (id: string) => {
      if (id !== schedule.id) return realGet(id);
      reads += 1;
      // CAS 败者后的回读:慢到超时之后才回来,带回的是**发起时那一版**(截止更长)。
      if (reads === 1) return await new Promise<Schedule | null>((resolve) => { releaseRead = resolve; });
      return realGet(id);
    });

    // DB sync 把改短后的行带回内存 → 过期扫描 → CAS 败者 → 回读超上限。
    await local.scheduler.tick();

    // 迟到的回读带回旧版行(截止时间 60s 后)。
    releaseRead({ ...schedule, status: 'active', expireAt: createdAt + 60_000, updatedAt: createdAt });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);

    // 守卫必须停在改短后的那一版:截止时间已过 → 不得放行。
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);

    await local.scheduler.stop();
  });

  // Codex P2 on #11577:一条派发守卫的回读超时不能带崩整轮。两条守卫都离开了
  // listActive 时,第一条的回读超时若直接上抛,后面那条连读都不会发 —— 它的守卫停在
  // 旧 deadline,而 lastDbSyncAt 已经前移,要等下一次 30 秒同步才恢复;期间别的实例
  // 改短了截止时间的排队 run 仍会被放行。
  it('keeps later dispatch guards refreshing after an earlier read timeout', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      // 两条派发都停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const first = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 60_000,
    });
    const second = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 60_000,
    });

    local.clock.setTo(first.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 200 && local.fireCalls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(2);
    const guardOf = (id: string) => local.fireCalls.find((c) => c.schedule.id === id)!;
    expect(guardOf(first.id).ctx.canDispatch?.()).toBe(true);
    expect(guardOf(second.id).ctx.canDispatch?.()).toBe(true);

    // 另一实例把两条都过期掉了(行离开 listActive),DB sync 必须回读它们。
    const expiredRow = (sch: Schedule): Schedule => ({
      ...sch, status: 'expired', nextFireAt: undefined, expireAt: createdAt - 1, updatedAt: createdAt + 1,
    });
    local.storage.schedules.set(first.id, expiredRow(first));
    local.storage.schedules.set(second.id, expiredRow(second));

    // 第一条的回读挂死(超时),第二条的回读慢但会回来。
    const readIds: string[] = [];
    let releaseSecond!: (value: Schedule | null) => void;
    const realGet = local.storage.get.bind(local.storage);
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== first.id && id !== second.id) return realGet(id);
      readIds.push(id);
      if (id === first.id) return new Promise<Schedule | null>(() => {});
      return new Promise<Schedule | null>((resolve) => { releaseSecond = resolve; });
    });

    local.clock.advance(30_000);
    await local.scheduler.tick();

    // 第一条超时之后,第二条的读仍然必须发出去(它的迟到结果才有 handler 收口)。
    expect(readIds).toEqual([first.id, second.id]);

    // 第二条的迟到回读回来:守卫必须用这一版(截止时间已过 → 不再放行)。
    releaseSecond(expiredRow(second));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guardOf(second.id).ctx.canDispatch?.()).toBe(false);

    await local.scheduler.stop();
  });

  // Codex P2 on #11577:批量 listActive 超时时,派发守卫的收口不能一起被跳过。
  // 原实现在那个 await 处直接跳进 catch,dispatchSnapshots 循环整段不执行 ——
  // 排队中的 run 一直拿着旧 deadline,而 lastDbSyncAt 已经前移,要等下一次 30 秒
  // 同步才恢复;期间别的实例改短了截止时间的 run 仍会被放行。
  it('reconciles queued dispatch guards when listActive times out', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 60_000,
    });

    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 另一实例把这一行过期掉了(行离开 listActive)。
    const expired: Schedule = {
      ...schedule, status: 'expired', nextFireAt: undefined, expireAt: createdAt - 1, updatedAt: createdAt + 1,
    };
    local.storage.schedules.set(schedule.id, expired);

    // 批量读挂死(超时);单条回读慢但会回来。
    let releaseRead!: (value: Schedule | null) => void;
    let reads = 0;
    const realGet = local.storage.get.bind(local.storage);
    vi.spyOn(local.storage, 'listActive').mockImplementation(() => new Promise<Schedule[]>(() => {}));
    vi.spyOn(local.storage, 'get').mockImplementation(async (id: string) => {
      if (id !== schedule.id) return realGet(id);
      reads += 1;
      return await new Promise<Schedule | null>((resolve) => { releaseRead = resolve; });
    });

    local.clock.advance(30_000);
    await local.scheduler.tick();

    // 批量读超时之后,守卫的回读仍然必须发出去(迟到结果才有 handler 收口)。
    expect(reads).toBe(1);

    // 迟到的回读回来:守卫必须用这一版(截止时间已过 → 不再放行)。
    releaseRead(expired);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);

    await local.scheduler.stop();
  });

  // Codex P2 on #11577:预算内回来的过期写入也要判旧。等待期间截止时间被延长,
  // 缓存里已经是更新的一版,而这一份是早先那次写入返回的 expired 快照;无条件覆盖
  // 会把刚恢复的任务又从缓存里抹掉,临近的触发要等到下一次 30 秒 DB sync 才恢复。
  it('keeps the active row when an in-budget expiry reply is stale', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 5_000 });
    const createdAt = local.clock.now();
    const expireAt = createdAt + 20_000;
    const schedule = await local.scheduler.create({ ...baseInput, intervalMs: 15_000, expireAt });

    // 第一轮:把这一行同步进内存。
    await local.scheduler.tick();

    // 到点(已过截止时间):过期扫描发起 UPDATE,这一轮卡在等回包上。
    local.clock.setTo(expireAt + 1);
    const realUpdate = local.storage.update.bind(local.storage);
    let releaseExpire!: (value: Schedule | null) => void;
    let expireLaunched = false;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireLaunched = true;
        return new Promise<Schedule | null>((resolve) => { releaseExpire = resolve; });
      }
      return realUpdate(id, patch, expected);
    });
    const tickPromise = local.scheduler.tick();
    for (let i = 0; i < 100 && !expireLaunched; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(expireLaunched).toBe(true);

    // 等待期间用户延长了截止时间:缓存里换成更新的一版(nextFireAt 不变)。
    const extended = await local.scheduler.update(schedule.id, { expireAt: createdAt + 3_600_000 });
    expect(extended.expireAt).toBe(createdAt + 3_600_000);

    // 这次 UPDATE 在预算内回来,带回的是**发起时那一版**(已过期)。
    releaseExpire({ ...schedule, status: 'expired', nextFireAt: undefined, updatedAt: createdAt });
    await tickPromise;

    // 第三轮(不触发 DB sync):任务必须照常派发 —— 改期后的那一版没被旧快照抹掉。
    await local.scheduler.tick();
    expect(local.fireCalls).toHaveLength(1);
  });

  // Codex P2 on #11577:僵尸清扫也要 single-flight。markRunningAsInterrupted 永不
  // settle 时,预闸门超时只放弃「等」,活儿还在跑 —— 而清扫挂在每个 30 秒的 DB sync
  // 块里,之后每一轮都会再起一份,存储故障期间挂起的 DB 工作无界增长,把认领和过期
  // 写入的调用也挤掉。
  it('keeps the stale-run sweep single-flight across ticks', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await local.scheduler.start();
    await local.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });

    // 清扫的存储调用挂死。
    let sweepCalls = 0;
    vi.spyOn(local.storage, 'markRunningAsInterrupted').mockImplementation(
      () => {
        sweepCalls += 1;
        return new Promise<string[]>(() => {});
      },
    );

    // start() 把清扫挡到「启动 + 完整过期窗口」之后。先用一轮 30 秒的 tick 把
    // lastTickAt 推上来(间隔不超过挂起吸收阈值,不会再被挡一次),窗口在下一轮到达。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(0); // 窗口未到,清扫本就还没开始

    // 窗口已过:这一轮清扫发起后卡死,预闸门超时放弃等待,tick 继续走。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(1);

    // 之后每一轮都到 DB sync 块:在途的那一份不能再起一份。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(1);

    await local.scheduler.stop();
  });

  // Codex P1 on #11577:在途过期写入的压制必须带版本。第一次写入挂死,之后用户改期
  // 成功(存储接受了那次编辑,行已经是新的一版):只按 scheduleId 压制的话,每个 tick
  // 都在「还有在途写入」处退出,新截止时间的过期写入永远发不出去 —— 持久行和 UI
  // 停在 active 且截止时间已过,直到进程重启。
  it('expires again after an edit moves the deadline past a stalled write', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30 });
    const createdAt = local.clock.now();
    const firstDeadline = createdAt + 2_000;
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 3_600_000, expireAt: firstDeadline,
    });

    const realUpdate = local.storage.update.bind(local.storage);
    let expireWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireWrites += 1;
        // 第一次过期写入永不 settle(存储挂死的形态)。
        if (expireWrites === 1) return new Promise<Schedule | null>(() => {});
      }
      return realUpdate(id, patch, expected);
    });

    // 第一轮:到点 → 过期写入发起后卡死,预闸门超时放弃等待。
    local.clock.setTo(firstDeadline);
    await local.scheduler.tick();
    expect(expireWrites).toBe(1);

    // 存储其实是好的:用户把截止时间改到更晚,那次编辑成功落库。
    const extended = createdAt + 120_000;
    const edited = await local.scheduler.update(schedule.id, { expireAt: extended });
    expect(edited.expireAt).toBe(extended);

    // 新截止时间到达:必须再发一次过期写入 —— 挂死的那一次只属于旧版本。
    local.clock.setTo(extended);
    await local.scheduler.tick();
    expect(expireWrites).toBe(2);

    // 持久行收口到 expired(不再停在 active 且截止时间已过)。
    expect((await local.storage.get(schedule.id))?.status).toBe('expired');

    // 缓存也已对齐:下一轮不会再发起第三次写入。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(2);
  });

  // Codex P1 on #11577:批量 listActive 超时后,每条守卫的回读也要 single-flight。
  // 读同样挂死时,之后每个 30 秒的 DB sync 块都会把同样的读再发一遍 —— 存储故障
  // 期间未完成的 RPC 工作无界增长,把认领和过期写入也挤掉,due-fire 重新被压制。
  it('keeps fallback guard reads single-flight across bulk timeouts', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 60_000,
    });

    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);

    // 批量读和单条回读都挂死(存储/worker 持续故障的形态)。
    let reads = 0;
    vi.spyOn(local.storage, 'listActive').mockImplementation(() => new Promise<Schedule[]>(() => {}));
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== schedule.id) return Promise.resolve(null);
      reads += 1;
      return new Promise<Schedule | null>(() => {});
    });

    // 之后每一轮都到 DB sync 块:在途的那一次回读不能再发一遍。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    local.clock.advance(30_000);
    await local.scheduler.tick();
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(reads).toBe(1);

    await local.scheduler.stop();
  });

  // Codex P2 on #11577:守卫回读单飞登记后,底层读永不 settle 时条目要等生命周期
  // 切换才消失。存储恢复(listActive 成功)后、行已离开批量结果的守卫仍复用那份
  // 孤儿读,永远发不出新点读 —— 别的实例写下的过期行刷不进 canDispatch,排队中的
  // run 在用户过期之后仍被放行。钉住两半契约:楔住期间不重发(单飞),listActive
  // 成功之后退役换新读(恢复)。
  it('retires a wedged guard read after listActive recovers', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 180_000,
    });

    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);

    // 楔住形态:批量读不回包,这一条的点读也永不 settle(在途读成了孤儿)。
    // 别的实例随后把行过期掉:它离开 listActive,本地只能靠点读得知。
    const expiredRow: Schedule = {
      ...schedule,
      status: 'expired',
      nextFireAt: undefined,
      expireAt: createdAt + 60_000,
      updatedAt: createdAt + 90_000,
    };
    let recovered = false;
    let reads = 0;
    vi.spyOn(local.storage, 'listActive').mockImplementation(() =>
      recovered ? Promise.resolve([]) : new Promise<Schedule[]>(() => {}));
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== schedule.id) return Promise.resolve(null);
      reads += 1;
      return recovered
        ? Promise.resolve(expiredRow)
        : new Promise<Schedule | null>(() => {});
    });

    // 楚住期间:每轮同步都到点读分支,单飞必须压住不重发。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(reads).toBe(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(reads).toBe(1);

    // 存储恢复:listActive 应答(行已过期不在结果里),点读也恢复正常。
    recovered = true;
    local.storage.schedules.set(schedule.id, expiredRow);
    local.clock.advance(30_000);
    await local.scheduler.tick();
    // 孤儿读必须退役:新点读带回过期行,守卫不再放行。
    expect(reads).toBe(2);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);

    await local.scheduler.stop();
  });

  // Greptile P1 on #12087:退役只换了登记,没作废旧读已挂上的迟到收口。恢复轮
  // 发出新读 C 等待期间,旧读 B 先返回同版本的另一对象 —— 收口把守卫换成 B,
  // 随后 C 的更新回包因身份闸(`=== previous`)失败被丢,守卫停在旧 deadline,
  // 排队中的 run 在用户过期之后仍被放行,直到下一轮同步。
  it('drops a retired guard read that settles while the replacement is in flight', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 180_000,
    });

    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);

    const expiredRow: Schedule = {
      ...schedule,
      status: 'expired',
      nextFireAt: undefined,
      expireAt: createdAt + 60_000,
      updatedAt: createdAt + 90_000,
    };
    // 同版本的另一对象:updatedAt/expireAt 与本地守卫一致,只是对象不同。
    const sameVersionTwin: Schedule = { ...schedule };

    let resolveOrphan!: (value: Schedule | null) => void;
    let resolveReplacement!: (value: Schedule | null) => void;
    let recovered = false;
    let reads = 0;
    vi.spyOn(local.storage, 'listActive').mockImplementation(() =>
      recovered ? Promise.resolve([]) : new Promise<Schedule[]>(() => {}));
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== schedule.id) return Promise.resolve(null);
      reads += 1;
      if (reads === 1) {
        return new Promise<Schedule | null>((resolve) => { resolveOrphan = resolve; });
      }
      return new Promise<Schedule | null>((resolve) => { resolveReplacement = resolve; });
    });

    // 楔住:孤儿读 B 发出并挂上收口。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(reads).toBe(1);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 恢复:listActive 应答(行已过期不在结果里),换发新读 C —— C 还在途。
    recovered = true;
    local.storage.schedules.set(schedule.id, expiredRow);
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(reads).toBe(2);
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 旧读 B 在 C 等待期间返回同版本的另一对象:它的收口必须作废。
    resolveOrphan(sameVersionTwin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 新读 C 带回过期行:身份闸必须仍然成立(守卫没被 B 换掉)。
    resolveReplacement(expiredRow);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);
    await local.scheduler.stop();
  });

  // Codex P2 on #12087:过期写入的压制登记只有 settle/stop 才清。写入永不 settle、
  // 而 listActive 恢复后仍返回同版本的 active 行(写入没落地)时,恢复后的每个
  // tick 都在「还有在途写入」处退出,过期写入永远发不出去 —— 持久行和 changed
  // 事件保持 active 直到重启。
  it('re-issues an expire write after listActive recovers with the row still active', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30, logger: { warn: vi.fn() } });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 3_600_000, expireAt: createdAt + 2_000,
    });

    const realUpdate = local.storage.update.bind(local.storage);
    let expireWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireWrites += 1;
        // 第一次过期写入永不 settle(存储局部挂死的形态);listActive 仍正常应答。
        if (expireWrites === 1) return new Promise<Schedule | null>(() => {});
      }
      return realUpdate(id, patch, expected);
    });

    // 第一轮:到点 → 过期写入发起后卡死;批量读仍返回同版本的 active 行。
    local.clock.setTo(createdAt + 2_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(1);
    expect((await local.storage.get(schedule.id))?.status).toBe('active');

    // 恢复轮:listActive 应答且仍含同版本的 active 行 → 孤儿写入必须被淘汰,
    // 同一轮里重新发出过期写入(这次成功)。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(2);
    expect((await local.storage.get(schedule.id))?.status).toBe('expired');

    await local.scheduler.stop();
  });

  // Codex P2 on #12087:清扫的单飞登记没有代次。markRunningAsInterrupted 永不
  // settle、listActive 随后从失败恢复时,在途的那份孤儿清扫把之后每个 30 秒同步
  // 挡在门外,别的实例崩溃留下的 running 行与认领后 nextFireAt 为空的任务永远无人收。
  it('re-starts the stale-run sweep after listActive recovers past a wedged sweep', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await local.scheduler.start();
    await local.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });

    let sweepCalls = 0;
    vi.spyOn(local.storage, 'markRunningAsInterrupted').mockImplementation(() => {
      sweepCalls += 1;
      return new Promise<string[]>(() => {});
    });
    let bulkFailed = false;
    const realListActive = local.storage.listActive.bind(local.storage);
    vi.spyOn(local.storage, 'listActive').mockImplementation(() =>
      bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

    // 与既有 single-flight 用例同序:先推进 lastTickAt,再让清扫在窗口内发出并卡死。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(0);
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(1);

    // 批量读也挂死一代(代次冻结,在途清扫仍被压制)。
    bulkFailed = true;
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(1);

    // 批量读从失败恢复 → 代次前进,孤儿清扫退役,重新发起。
    bulkFailed = false;
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(2);

    await local.scheduler.stop();
  });

  // Codex P2 on #12087:补排的在途登记没有代次。同一凭据的补排永不 settle、
  // listActive 随后从失败恢复时,后续每个 tick 都跳过同一凭据 —— 认领过的任务
  // nextFireAt 已空,批量重载不会重算,周期任务停摆到进程重启。
  it('retries the same replan credential after listActive recovers past a wedged attempt', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      let replanReads = 0;
      // 'fail' 这次没做成(凭据上膛)、'wedge' 永久挂死、'retry' 恢复后照常。
      let getMode: 'fail' | 'wedge' | 'retry' | 'real' = 'real';
      let bulkFailed = false;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        // 只拦补排路径:强杀后 fireOne 仍挂着,遗留派发守卫在 listActive 超时时
        // 会走 getGuardFallbackRead,那条读不该计入补排计数、也不该被楔住。
        if (!(new Error().stack ?? '').includes('applyStalledClaimReplan')) return realGet(id);
        if (getMode === 'real') return realGet(id);
        replanReads += 1;
        if (getMode === 'fail') {
          getMode = 'wedge';
          return Promise.reject(new Error('storage unavailable'));
        }
        if (getMode === 'wedge') return new Promise<Schedule | null>(() => {});
        return realGet(id);
      });
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口那次的补排失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      getMode = 'fail';
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 补排重试永久挂死:登记留下,同凭据不再重发(批量读也还健康,代次未动)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 批量读失败一代(代次冻结,在途补排仍被压制)。DB sync 每 30s 才跑,
      // 必须推进调度器时钟让这一轮真正读到 listActive。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);

      // 批量读从失败恢复 → 代次前进,同一凭据必须重试并补上排期。
      bulkFailed = false;
      getMode = 'retry';
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(3);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toEqual(expect.any(Number));

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087:孤儿过期写入的淘汰不能变成「每次同步都换发一条写入」。
  // 写通道局部挂死(单条 UPDATE 永不 settle)而批量读一直健康时,每个 30 秒同步
  // 都会淘汰那份孤儿登记、随后再发一条 UPDATE;旧的请求既不取消也不收口,在途
  // 写入按时间无界增长,再次压垮存储。在途过期写入必须有硬上限。
  it('bounds the outstanding expire writes while the write channel stays wedged', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30, logger: { warn: vi.fn() } });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    await local.scheduler.create({
      ...baseInput, intervalMs: 3_600_000, expireAt: createdAt + 2_000,
    });

    const realUpdate = local.storage.update.bind(local.storage);
    let expireWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireWrites += 1;
        // 写通道楔住:过期写入永不 settle(存储写侧的局部故障形态)。
        return new Promise<Schedule | null>(() => {});
      }
      return realUpdate(id, patch, expected);
    });

    local.clock.setTo(createdAt + 2_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(1);

    // 写通道一直楔住:同步轮数增加,在途过期写入不得跟着增长。
    for (let i = 0; i < 6; i += 1) {
      local.clock.advance(30_000);
      await local.scheduler.tick();
    }
    expect(expireWrites).toBeLessThanOrEqual(3);

    await local.scheduler.stop();
  });

  // Codex P2 on #12087:若同一任务每次都在过期写入挂起时被延长到新版本,
  // 版本门会放行下一条 UPDATE;容量上限必须在发请求前检查,不能只拒绝事后记账。
  it('does not send newer expiry writes beyond the outstanding request cap', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 5, logger: { warn: vi.fn() } });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 3_600_000, expireAt: createdAt + 1_000,
    });

    const realUpdate = local.storage.update.bind(local.storage);
    let expireWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireWrites += 1;
        return new Promise<Schedule | null>(() => {});
      }
      return realUpdate(id, patch, expected);
    });

    for (let revision = 0; revision < 4; revision += 1) {
      if (revision > 0) {
        const nextDeadline = local.clock.now() + 1_000;
        await local.scheduler.update(schedule.id, { expireAt: nextDeadline });
        local.clock.setTo(nextDeadline);
      } else {
        local.clock.setTo(schedule.expireAt!);
      }
      await local.scheduler.tick();
    }

    expect(expireWrites).toBe(3);
    await local.scheduler.stop();
  });

  // Codex P1 on #12087:已退役补排的在途写入不能盖掉换发出来的那次补排的结果。
  // 同一凭据的补排卡在 storage.update、listActive 随后从失败恢复时,代次前进会
  // 换发第二次补排;第二次先把按恢复时刻算出的排期写进库,第一次那条旧 RPC 随后
  // 恢复 —— 它按故障前时刻算出的值会把新排期盖回去,周期任务因此可能提前或重复
  // 触发。持久化副作用必须带快照 CAS。
  it('does not let a retired replan overwrite the schedule written by its replacement', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      let releaseWedgedWrite!: () => void;
      let replanReads = 0;
      let replanWrites = 0;
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (inReplanPath()) {
          replanWrites += 1;
          if (replanWrites === 1) {
            // 换发出来的那次补排卡在写上(旧 RPC 在途)。
            await new Promise<void>((resolve) => { releaseWedgedWrite = resolve; });
          }
        }
        return realUpdate(id, patch, expected);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读成功,写排期卡住(旧 RPC 在途)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(replanWrites).toBe(1);

      // 批量读失败一代(代次冻结,在途补排仍被压制)。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(1);

      // 批量读从失败恢复 → 代次前进,换发第二次补排:这一次的写必须落地。
      bulkFailed = false;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(2);
      const settledNextFireAt = h.storage.schedules.get(sch.id)?.nextFireAt;
      expect(settledNextFireAt).toEqual(expect.any(Number));

      // 旧的那条 RPC 恢复:它按故障前的时刻算出的排期不得盖掉新补排的结果。
      releaseWedgedWrite();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBe(settledNextFireAt);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087:换发路径没有在途上限。批量读在故障期间反复「失败 → 恢复」,
  // 代次每次恢复都前进,僵尸清扫的单飞登记被覆盖并再发一份 —— 旧的那份取消不了也
  // 收不掉,每个恢复周期都多留一条在途 markRunningAsInterrupted,在途量无界增长,
  // 再次压垮存储。换发路径必须有硬上限。
  it('bounds the in-flight sweep requests while the sweep channel stays wedged', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30, logger: { warn: vi.fn() } });
    await local.scheduler.start();
    await local.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });

    let sweepCalls = 0;
    vi.spyOn(local.storage, 'markRunningAsInterrupted').mockImplementation(() => {
      sweepCalls += 1;
      // 清扫通道楔住:每一份都永不 settle。
      return new Promise<string[]>(() => {});
    });
    const realListActive = local.storage.listActive.bind(local.storage);
    let bulkFailed = false;
    vi.spyOn(local.storage, 'listActive').mockImplementation(() =>
      bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

    // 与既有 single-flight 用例同序:先推进 lastTickAt,清扫才在窗口内发出。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(0);
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(sweepCalls).toBe(1);

    // 批量读反复「失败 → 恢复」:每次恢复代次前进,清扫被换发。
    for (let i = 0; i < 6; i += 1) {
      bulkFailed = true;
      local.clock.advance(30_000);
      await local.scheduler.tick();
      bulkFailed = false;
      local.clock.advance(30_000);
      await local.scheduler.tick();
    }
    // 旧请求取消不了 —— 在途清扫请求必须有硬上限,不能按恢复周期无界增长。
    expect(sweepCalls).toBeLessThanOrEqual(3);

    await local.scheduler.stop();
  });

  // Codex P1 on #12087:退役的补排**先落笔**时,CAS 挡不住它 —— 它按故障前的时刻
  // 算出排期,长故障之后那个时刻已经落在过去,任务会在恢复后立即补跑,而不是从
  // 恢复时刻重新计时。换发出来的那次补排必须识别这种行并接管过来重排。
  it('takes over the overdue schedule written by a retired replan that landed first', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let releaseOldWrite!: () => void;
      let oldWriteLanded!: () => void;
      const oldWriteLandedPromise = new Promise<void>((resolve) => { oldWriteLanded = resolve; });
      let replanReads = 0;
      let replanWrites = 0;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (!inReplanPath()) return realUpdate(id, patch, expected);
        replanWrites += 1;
        if (replanWrites === 1) {
          // 被退役的那次补排:它发端于故障前,带着按故障前时刻算出的排期,写卡住。
          await new Promise<void>((resolve) => { releaseOldWrite = resolve; });
          // 另一实例只改元数据并推进 updatedAt。真实存储的补排 CAS 不比较元数据,
          // 所以旧补排仍会落笔,返回的行修订必须成为它的收据指纹。
          const beforeMetadataEdit = await realGet(id);
          expect(beforeMetadataEdit).not.toBeNull();
          await realUpdate(id, {
            name: 'Renamed by another instance',
            updatedAt: h.clock.now(),
          }, beforeMetadataEdit!);
          const out = await realUpdate(id, patch, expected);
          oldWriteLanded();
          return out;
        }
        if (replanWrites === 2) {
          // 换发出来的那次补排:旧的那条**先落笔**,于是自己的快照 CAS 落空。
          releaseOldWrite();
          await oldWriteLandedPromise;
          return null;
        }
        // 接管写:真的落笔。
        return realUpdate(id, patch, expected);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读成功,写排期卡住(旧的那条在途)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(replanWrites).toBe(1);

      // 故障持续很久:被退役的那次补排算出的时刻已经落在过去。
      h.clock.advance(7_200_000);

      // 批量读失败一代(代次冻结,在途补排仍被压制)。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(1);

      // 批量读从失败恢复 → 代次前进,换发第二次补排:旧的那条先落笔,新的一次
      // 接管过来,行里留下的必须是按恢复时刻算出的排期。
      bulkFailed = false;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(3);
      const persisted = h.storage.schedules.get(sch.id)?.nextFireAt;
      expect(persisted).toEqual(expect.any(Number));
      // 不得是「按故障前时刻算出、已经落在过去」的那个排期。
      expect(persisted!).toBeGreaterThan(h.clock.now());

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P2 on #12087:在途过期写入的计数按数字加减,会被上一段生命周期挂死的那条
  // 写入的迟到 settle 减错 —— 减掉的是**新**一段刚发的写入的额度,硬上限形同虚设。
  it('does not let a settled write from the previous lifecycle free the new expire write budget', async () => {
    const local = makeHarness({ preGateStorageTimeoutMs: 30, logger: { warn: vi.fn() } });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    await local.scheduler.create({
      ...baseInput, intervalMs: 3_600_000, expireAt: createdAt + 2_000,
    });

    const realUpdate = local.storage.update.bind(local.storage);
    const releases: Array<() => void> = [];
    let expireWrites = 0;
    vi.spyOn(local.storage, 'update').mockImplementation((id, patch, expected) => {
      if (patch.status === 'expired') {
        expireWrites += 1;
        return new Promise<Schedule | null>((resolve) => { releases.push(() => resolve(null)); });
      }
      return realUpdate(id, patch, expected);
    });

    local.clock.setTo(createdAt + 2_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(1);

    // 停机再启动:新的一段生命周期重新发过期写入(上一段那条挂死的仍在途)。
    await local.scheduler.stop();
    await local.scheduler.start();
    expect(expireWrites).toBe(2);

    // 新的一段把额度用满:在途过期写入到上限后不再换发。
    for (let i = 0; i < 3; i += 1) {
      local.clock.advance(30_000);
      await local.scheduler.tick();
    }
    const beforeSettle = expireWrites;
    expect(beforeSettle).toBe(4);

    // 上一段那条挂死的写入这时才 settle:它不得减掉新一段的额度。
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(expireWrites).toBe(beforeSettle);

    await local.scheduler.stop();
  });

  // Codex P2 on #12087:一次性任务的补排落笔过期时带了快照 CAS —— CAS 落空说明行
  // 已经被用户改过,过期**没有**落笔,缓存里此刻是用户改好的新版,不能顺手删掉。
  // 删掉的话 due 循环要等下一次 DB 同步才重新看到它,期间该触发的任务被延后。
  it('keeps the user-edited row in the cache when the one-shot expiry loses the CAS', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, recurring: false });
      const realGet = h.storage.get.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let staleRow: Schedule | null = null;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        // 补排的回读拿到的是**用户改之前**那一版 → 它的 CAS 必然落空。
        if (inReplanPath() && staleRow) return { ...staleRow };
        return realGet(id);
      });

      // 第一轮 run:认领之后、用户改之前那一版。
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      staleRow = { ...(await h.storage.get(sch.id))! };

      // 用户在 run 卡死期间把这条改成周期任务(cadence 变了,行换了新的一版)。
      await h.scheduler.update(sch.id, { recurring: true, intervalMs: 15_000 });

      // 强制收口:补排拿着旧快照去过期,落空。
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      // 用户改好的那一版仍要在它的排期上触发(缓存里没被顺手删掉)。
      const firesBefore = h.fireCalls.length;
      h.clock.advance(15_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.fireCalls.length).toBe(firesBefore + 1);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第二轮复评):退役写入的指纹不能是「已经到期」。
  // 并发闸门会刻意让合法到期的任务 nextFireAt 停在过去(等槽位才派发),用户在补排
  // 挂起期间改出的排期也会在恢复前到期 —— 那些行都不是退役写入。拿时间当指纹,
  // 补排重试会把这次该触发的排期 CAS 到未来并摘掉凭据,静默吞掉一次触发。
  it('leaves a due schedule that the user edited during a pending replan to the due loop', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 用户在补排挂着的时候改了这条任务:排期落在「刚刚」的将来。
      await h.scheduler.update(sch.id, { intervalMs: 45_000 });
      const editedNextFireAt = h.storage.schedules.get(sch.id)?.nextFireAt ?? 0;
      expect(editedNextFireAt).toBeGreaterThan(h.clock.now());

      // 走到用户改出来的排期上:这一轮该触发(补排重试不得把它接管成未来)。
      h.clock.setTo(editedNextFireAt + 1);
      const firesBefore = h.fireCalls.length;
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.fireCalls.length).toBe(firesBefore + 1);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第二轮复评):换发出来的那次补排与被换发取代的那次共享同一条
  // 凭据、同一个 startedAt —— 只按登记时刻分不出先后。换发出来的那次先成功、任务
  // 随后被新一轮认领之后,退役那次迟到的失败不能把凭据重新上膛:上膛了就会给已经
  // 被新 run 认领的任务再排一次触发,跨实例产生重叠执行。
  it('does not re-arm the replan credential when a superseded replan fails late', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let replanReads = 0;
      let rejectWedgedRead!: (err: Error) => void;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        // 第二次(被换发取代的那次)卡在读上,退役之后才 reject。
        if (replanReads === 2) {
          return new Promise<Schedule | null>((_resolve, reject) => { rejectWedgedRead = reject; });
        }
        return realGet(id);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读卡住(旧 RPC 在途)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);

      // 批量读失败一代 → 恢复,代次前进 → 换发出来的那次补排先成功。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      bulkFailed = false;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(3);
      const replannedNextFireAt = h.storage.schedules.get(sch.id)?.nextFireAt;
      expect(replannedNextFireAt).toEqual(expect.any(Number));

      // 任务在新的排期上被认领,进入新一轮 run(nextFireAt 被清空)。
      h.clock.setTo(replannedNextFireAt! + 1);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 被换发取代的那次补排这时才 reject:它不得把凭据重新上膛。
      rejectWedgedRead(new Error('storage unavailable'));
      await vi.advanceTimersByTimeAsync(100);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);

      // 不得给已经被新一轮认领的任务再排一次触发(跨实例重叠执行)。
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P2 on #12087(第二轮复评):硬上限到顶之后连恢复后的通道也发不出新请求 ——
  // 那几条永不 settle 的孤儿把计数永久钉在上限,已被认领、nextFireAt 为空的周期
  // 任务只能等进程重启。到顶之后必须留一条有界退避的探测通道:通道恢复后总能自己
  // 走通,任务不至于停在没有 nextFireAt 的状态。
  it('probes a capped replan path once its orphaned requests age out', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        // 换发出来的补排都卡在读上(永不 settle 的孤儿)。
        if (replanReads <= 4) return new Promise<Schedule | null>(() => {});
        return realGet(id);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 第一次重试:一条补排卡在读上(孤儿 #1)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);

      // 之后每次代次前进(批量读失败 → 恢复)都换发一条补排,三条都卡在读上。
      for (let i = 0; i < 3; i += 1) {
        bulkFailed = true;
        h.clock.advance(30_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
        bulkFailed = false;
        h.clock.advance(30_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
      }
      // 回读:第一次失败 + 三条换发 = 四次;第四次换发被硬上限挡住。
      expect(replanReads).toBe(4);

      // 孤儿超龄、退避窗口也过去了 → 探测通道放一条新的补排出去。通道已经恢复,
      // 这次补排必须落笔(任务不能停在没有 nextFireAt 的状态)。
      h.clock.advance(11 * 60_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(200);
      expect(replanReads).toBe(5);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toEqual(expect.any(Number));

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第五轮复评):一次性任务的过期写入 CAS 落空后不能就此收尾。
  // 用户把这条一次性任务改成了周期任务 —— 改「recurring」本身不触发重算(重算的触发
  // 字段是 cron / 时区 / interval / manual / 截止时间),于是新版仍是 active 且
  // nextFireAt 为空:按一次性语义收尾,这条任务就停摆到进程重启(周期 DB sync 只重灌
  // 行、不补 nextFireAt)。修法:回读新版,按它自己的 recurring 语义补排。
  it('replans a one-shot the user turned recurring while the expiry lost the CAS', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, recurring: false, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let staleRow: Schedule | null = null;
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 补排的第一次回读拿到的是**用户改之前**那一版 → 它的过期 CAS 必然落空。
        if (replanReads === 1 && staleRow) return { ...staleRow };
        return realGet(id);
      });

      // 第一轮 run:认领之后、用户改之前那一版。
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      staleRow = { ...(await h.storage.get(sch.id))! };

      // 用户把一次性任务改成周期任务:只改 recurring —— 重算的触发字段没动,排期不会被
      // 重算,于是新版是 active 且 nextFireAt 为空。
      await h.scheduler.update(sch.id, { recurring: true });
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 强制收口:补排拿着旧快照去过期,落空 → 回读新版,按它的 recurring 语义补排。
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      const replanned = h.storage.schedules.get(sch.id)?.nextFireAt ?? 0;
      expect(replanned).toBeGreaterThan(h.clock.now());

      // 补出来的排期上要真的触发一次(不能停在没有 nextFireAt 的状态)。
      const firesBefore = h.fireCalls.length;
      h.clock.setTo(replanned + 1);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.fireCalls.length).toBe(firesBefore + 1);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第六轮复评):补排的 CAS 落空后,回读到的新版必须按**它自己
  // 的语义**重新判定 —— 用户在补排挂起期间把周期任务改成一次性时,新版是 active
  // 且 nextFireAt 为空(改「recurring」不触发重算),而这次触发已经被卡死的那一轮
  // 消耗掉:应当走一次性语义的**过期**。不处理的话这条行既不会被触发(没有排期),
  // 也不会自动过期(周期 DB sync 只重灌行、不补 nextFireAt),只能等进程重启才被当成
  // 「还没跑过」重新排一次 —— 一次性任务因此多跑一轮。
  it('expires a recurring schedule the user turned into a one-shot while the replan lost the CAS', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let staleRow: Schedule | null = null;
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 补排的第一次回读拿到的是**用户改之前**那一版 → 它的补排 CAS 必然落空。
        if (replanReads === 1 && staleRow) return { ...staleRow };
        return realGet(id);
      });

      // 第一轮 run:认领之后、用户改之前那一版。
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      staleRow = { ...(await h.storage.get(sch.id))! };

      // 用户把周期任务改成一次性:只改 recurring —— 重算的触发字段没动,排期不会
      // 被重算,于是新版是 active 且 nextFireAt 为空。
      await h.scheduler.update(sch.id, { recurring: false });
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 强制收口:补排拿着旧快照去补排,落空 → 回读新版,按它的一次性语义过期。
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      const settled = h.storage.schedules.get(sch.id)!;
      expect(settled.status).toBe('expired');
      expect(settled.nextFireAt).toBeUndefined();
      expect(settled.lastFiredAt).toEqual(expect.any(Number));

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第九轮复评):补排 CAS 落空后,回读到的新版**仍是周期任务**
  // 但没有排期时,必须按它自己的 cadence 补排。并发的手动触发(runNow)在触发时
  // 只落 lastFiredAt、**从不恢复** nextFireAt(手动触发不改自动排期)—— 行因此停在
  // 「周期但没有排期」:既不会被触发(没有排期),周期 DB sync 也只重灌行、不补
  // nextFireAt,任务停摆到进程重启,而凭据被当成已收口摘掉。
  it('replans a recurring row left without a schedule by a concurrent run-now', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let staleRow: Schedule | null = null;
      let replanReads = 0;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 补排的第一次回读拿到的是**并发 runNow 落 lastFiredAt 之前**那一版 →
        // 它的补排 CAS 必然落空。
        if (replanReads === 1 && staleRow) return { ...staleRow };
        return realGet(id);
      });

      // 第一轮 run:认领之后那一版(nextFireAt 被认领清空)。
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      staleRow = { ...(await h.storage.get(sch.id))! };
      expect(staleRow.nextFireAt).toBeUndefined();

      // 另一台电脑上的手动触发在触发时乐观落 lastFiredAt,不动 nextFireAt。
      const claimed = (await realGet(sch.id))!;
      await h.storage.update(sch.id, { lastFiredAt: h.clock.now() }, claimed);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 强制收口:补排拿着旧快照去补排,落空 → 回读新版(仍是周期、没有排期)→ 补排。
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      const replanned = h.storage.schedules.get(sch.id)?.nextFireAt ?? 0;
      expect(replanned).toBeGreaterThan(h.clock.now());

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第十轮复评):「CAS 落空 → 回读 → 恢复写入」这条路上的写入也可能
  // 再落空(又一个并发写在回读之后落了 lastFiredAt)。此时不能收尾 —— 收尾会摘掉重试
  // 凭据,而 runNow 收口与周期 DB sync 都不补 nextFireAt,任务停摆到进程重启。这次没
  // 做成:凭据继续上膛,由后续 tick 重试。
  it('keeps the replan credential armed when a second run-now also loses the recovery CAS', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let staleRow: Schedule | null = null;
      let replanReads = 0;
      let replanWrites = 0;
      vi.spyOn(h.storage, 'get').mockImplementation(async (id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 补排的第一次回读拿到的是**第一个 runNow 落 lastFiredAt 之前**那一版 →
        // 它的补排 CAS 必然落空。
        if (replanReads === 1 && staleRow) return { ...staleRow };
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (!inReplanPath()) return realUpdate(id, patch, expected);
        replanWrites += 1;
        if (replanWrites === 2) {
          // 又一个并发 runNow 在回读之后、恢复写入之前落了 lastFiredAt → 这次也落空。
          const row = await realGet(id);
          if (row) await realUpdate(id, { lastFiredAt: h.clock.now() }, row);
          return null;
        }
        return realUpdate(id, patch, expected);
      });

      // 第一轮 run:认领之后那一版,再模拟第一个并发 runNow 落 lastFiredAt。
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      staleRow = { ...(await h.storage.get(sch.id))! };
      const claimed = (await realGet(sch.id))!;
      await h.storage.update(sch.id, { lastFiredAt: h.clock.now() }, claimed);

      // 强制收口:补排 CAS 落空 → 回读 → 恢复写入也落空。
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      // 两次写入都落空:行仍是没有排期的周期任务,凭据必须还在。
      expect(replanWrites).toBe(2);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBeUndefined();

      // 下一个 tick 的重试把排期补上(凭据没被摘掉)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      const replanned = h.storage.schedules.get(sch.id)?.nextFireAt ?? 0;
      expect(replanned).toBeGreaterThan(h.clock.now());

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第十轮复评):退役补排写下的旧排期落库之后,用户只改元数据
  // (name / prompt)时,行级 updatedAt 被推进而 nextFireAt 原样保留。收据指纹若带上
  // 行级修订,这份排期就再也认不出来 —— 恢复时按"别人写的排期"保留它,长故障之后
  // 立即补跑 / 与新一轮重叠。元数据编辑不动作排期语义,收据必须继续有效。
  // Codex P1 on #12087(第十一轮复评):退役收据对「用户暂停后又恢复」失效。
  // 收据指纹刻意只带 CAS 身份(不带行级 updatedAt),而 pause → resume 之后行回到
  // active、nextFireAt 可能与暂停前逐项相同(用户在同一个槽位之前暂停又恢复,resume
  // 算出的还是那个槽位)—— 不动作废收据的话,恢复时刻的补排把**用户恢复出来的那一
  // 版**认成退役写入,顶到下一个槽位,用户恢复的那次触发被静默跳过。
  it('keeps the slot a user resumed before the stalled replan retried', async () => {
    vi.useFakeTimers();
    try {
      let runStarts = 0;
      const h = makeHarness({
        runStallMs: 10_000,
        runStallAbortGraceMs: 1_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => {
          runStarts += 1;
          return new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {});
          });
        },
      });
      const sch = await h.scheduler.create({ ...baseInput });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let replanReads = 0;
      let replanWrites = 0;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (!inReplanPath()) return realUpdate(id, patch, expected);
        replanWrites += 1;
        // 第一次补排的写卡死(写通道楔住):收据已经签发(值 = 发起时刻算出的槽位),
        // 但落笔一直不回来 → 凭据继续上膛,由后续 tick 重试。
        if (replanWrites === 1) return new Promise<Schedule | null>(() => {});
        return realUpdate(id, patch, expected);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:到点触发 → 卡死 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(30_000); // 00:01:00 —— 第一个槽位
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(10_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(1_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读成功,写排期卡死(收据已签发,值 = 00:02:00 那个槽位)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(replanWrites).toBe(1);

      // 用户在那个槽位之前把任务暂停又恢复:resume 算出的还是同一个槽位。
      await h.scheduler.pause(sch.id);
      await h.scheduler.resume(sch.id);
      const userSlot = h.storage.schedules.get(sch.id)?.nextFireAt;
      expect(userSlot).toBeGreaterThan(h.clock.now());

      // 批量读失败一代(代次冻结):这一轮还在用户那个槽位之前,到期槽位不会先被派发。
      h.clock.advance(30_000);
      bulkFailed = true;
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(1); // 在途的那一次还挂着,这一轮换发不出去
      bulkFailed = false;

      // 故障持续到那个槽位之后 → 批量读恢复(代次前进)→ 换发第二次补排。
      h.clock.advance(120_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);

      // 恢复时刻的补排不得把用户恢复出来的那一版顶到下一个槽位 —— 那个槽位仍要触发。
      expect(runStarts).toBe(2);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still takes over a retired replan write after a metadata-only edit', async () => {
    vi.useFakeTimers();
    try {
      let runStarts = 0;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => {
          runStarts += 1;
          return new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {});
          });
        },
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let releaseOldWrite!: () => void;
      let oldWriteLanded!: () => void;
      const oldWriteLandedPromise = new Promise<void>((resolve) => { oldWriteLanded = resolve; });
      let replanReads = 0;
      let replanWrites = 0;
      let staleValue = 0;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (!inReplanPath()) return realUpdate(id, patch, expected);
        replanWrites += 1;
        if (replanWrites === 1) {
          // 被退役的那次补排:写卡住,直到换发出来的那次把它放行。故障持续很久,
          // 它算出的时刻落地时已经落在过去。落笔时按**当下**那一版 CAS —— 行在
          // 等待期间被周期 DB sync 推进过,这份旧排期确实落进库里(要接管的正是它)。
          await new Promise<void>((resolve) => { releaseOldWrite = resolve; });
          const row = (await realGet(id))!;
          const out = await realUpdate(id, patch, row);
          staleValue = out?.nextFireAt ?? 0;
          oldWriteLanded();
          return out;
        }
        if (replanWrites === 2) {
          // 换发出来的那次补排:旧的那条先落笔,于是自己的快照 CAS 落空。
          releaseOldWrite();
          await oldWriteLandedPromise;
          // 用户在旧排期落库之后只改了元数据:updatedAt 推进,nextFireAt 原样保留。
          const row = (await realGet(id))!;
          await realUpdate(id, { name: 'renamed by the user', updatedAt: h.clock.now() }, row);
          expect(h.storage.schedules.get(id)?.nextFireAt).toBe(staleValue);
          return null;
        }
        // 接管写:真的落笔。
        return realUpdate(id, patch, expected);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读成功,写排期卡住(旧的那条在途)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(replanWrites).toBe(1);

      // 故障持续很久:被退役的那次补排算出的时刻已经落在过去。
      h.clock.advance(7_200_000);

      // 批量读失败一代(代次冻结)后恢复 → 换发第二次补排:旧的那条先落笔,用户随后
      // 只改元数据,新的那次 CAS 落空 → 回读仍要认出退役写入并按恢复时刻接管。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(1);
      bulkFailed = false;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);

      const persisted = h.storage.schedules.get(sch.id)?.nextFireAt ?? 0;
      // 恢复后不得**立即补跑**:退役写入的旧排期按故障前时刻算出,长故障之后已经落在
      // 过去 —— 一旦被当成「别人写的排期」保留下来,恢复即刻就被认领触发(第二次 run)。
      expect(runStarts).toBe(1);
      expect(persisted).toEqual(expect.any(Number));
      // 不得是「按故障前时刻算出、已经落在过去」的那个排期。
      expect(persisted).toBeGreaterThan(h.clock.now());

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第五、六轮复评):退役写入的指纹不能只是 nextFireAt 或 CAS 字段。
  // 用户把 cadence 改走再改回原值时,CAS 字段与 nextFireAt 都能回到收据中的值(ABA),
  // 但 updatedAt 已推进;不能把用户那一版当成退役写入接管掉,静默跳过用户选中的排期。
  // 本用例经公开 Scheduler.update 入口验证该用户可观察行为。
  it('does not take over a schedule the user edited into the same next fire time', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 600_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realUpdate = h.storage.update.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let releaseOldWrite!: () => void;
      let oldWriteLanded!: () => void;
      let oldWriteLandedSignal!: () => void;
      let userEditDone!: () => void;
      const oldWriteLandedPromise = new Promise<void>((resolve) => { oldWriteLanded = resolve; });
      const oldWriteLandedSignalPromise = new Promise<void>((resolve) => { oldWriteLandedSignal = resolve; });
      const userEditDonePromise = new Promise<void>((resolve) => { userEditDone = resolve; });
      let replanReads = 0;
      let replanWrites = 0;
      let retiredValue = 0;
      let performingUserEdit = false;
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛;之后的回读照常。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        return realGet(id);
      });
      vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
        if (performingUserEdit) return realUpdate(id, patch, expected);
        if (!inReplanPath()) return realUpdate(id, patch, expected);
        replanWrites += 1;
        if (replanWrites === 1) {
          // 被退役的那次补排:它发端于故障前,带着按故障前时刻算出的排期,写卡住。
          retiredValue = patch.nextFireAt ?? 0;
          await new Promise<void>((resolve) => { releaseOldWrite = resolve; });
          const out = await realUpdate(id, patch, expected);
          oldWriteLanded();
          return out;
        }
        if (replanWrites === 2) {
          // 换发出来的那次补排:旧的那条**先落笔**,于是自己的快照 CAS 落空。
          releaseOldWrite();
          await oldWriteLandedPromise;
          oldWriteLandedSignal();
          // 等用户改完 cadence 再让这一次落空。
          await userEditDonePromise;
          return null;
        }
        // 接管写:不该发生 —— 用户那一版不是退役写入。
        return realUpdate(id, patch, expected);
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 重试一次补排:回读成功,写排期卡住(旧的那条在途)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      expect(replanWrites).toBe(1);

      // 批量读失败一代(代次冻结,在途补排仍被压制),再恢复 → 代次前进,换发第二次补排。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanWrites).toBe(1);

      bulkFailed = false;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      // 第二次补排的写正在等:旧的那条已经落笔(行里是它按故障前时刻算出的排期)。
      await oldWriteLandedSignalPromise;

      // 用户把 cadence 先改走、再改回原值。nextFireAt 与收据完全一致,其余 CAS 字段
      // 也都回到旧值;只有 updateSchedule 写入的 updatedAt 前进了(ABA)。
      const rowBeforeEdit = h.storage.schedules.get(sch.id)!;
      retiredValue = rowBeforeEdit.nextFireAt!;
      h.clock.setTo(retiredValue - 600_000);
      expect(h.clock.now()).toBeGreaterThan(rowBeforeEdit.updatedAt);
      performingUserEdit = true;
      try {
        await h.scheduler.update(sch.id, { intervalMs: 123_000 });
        await h.scheduler.update(sch.id, { intervalMs: 600_000 });
      } finally {
        performingUserEdit = false;
      }
      const userEdited = h.storage.schedules.get(sch.id)!;
      expect(userEdited.nextFireAt).toBe(retiredValue);
      expect(userEdited.intervalMs).toBe(rowBeforeEdit.intervalMs);
      expect(userEdited.updatedAt).toBeGreaterThan(rowBeforeEdit.updatedAt);
      userEditDone();

      await vi.advanceTimersByTimeAsync(200);

      // 用户那一版不是退役写入:不得被接管成另一个排期,也不该发出接管写。
      expect(replanWrites).toBe(2);
      expect(h.storage.schedules.get(sch.id)?.nextFireAt).toBe(retiredValue);

      // 用户选中的那个排期要真的触发一次。
      const firesBefore = h.fireCalls.length;
      h.clock.setTo(retiredValue + 1);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.fireCalls.length).toBe(firesBefore + 1);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P1 on #12087(第五轮复评):探测不能靠删掉记账 token 给真实在途的 DB 调用
  // 腾位。被退役的请求取消不了 —— 底层 promise 仍在途,记账上摘掉只会让真实在途量
  // 每轮退避到期就多挂一条永挂请求。修法:被退役的请求照样计入真实在途量(每条路径
  // 有硬上限),并且只在通道确实回包时才发探测。
  it('keeps the real in-flight requests of a wedged path bounded while probing for recovery', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        preGateStorageTimeoutMs: 30,
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        runnerImpl: (_s, ctx) => new Promise<FireResult>(() => {
          ctx.signal.addEventListener('abort', () => {});
        }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 60_000 });
      const realGet = h.storage.get.bind(h.storage);
      const realListActive = h.storage.listActive.bind(h.storage);
      const inReplanPath = () => (new Error().stack ?? '').includes('applyStalledClaimReplan');
      let replanReads = 0;
      let wedgedReads = 0;
      let inFlightReads = 0;
      const wedgedReadResolvers: Array<(value: Schedule | null) => void> = [];
      vi.spyOn(h.storage, 'get').mockImplementation((id: string) => {
        if (id !== sch.id) return realGet(id);
        if (!inReplanPath()) return realGet(id);
        replanReads += 1;
        // 第一次补排的回读失败 → 凭据上膛。
        if (replanReads === 1) return Promise.reject(new Error('storage unavailable'));
        // 这条路径之后的回读一律卡死,除非用例显式放回一条真实在途读。
        wedgedReads += 1;
        inFlightReads += 1;
        return new Promise<Schedule | null>((resolve) => {
          wedgedReadResolvers.push((value) => {
            inFlightReads -= 1;
            resolve(value);
          });
        });
      });
      let bulkFailed = false;
      vi.spyOn(h.storage, 'listActive').mockImplementation(() =>
        bulkFailed ? new Promise<Schedule[]>(() => {}) : realListActive());

      // 第一轮 run:跑挂 → 强制收口 → 那次补排的回读失败(凭据上膛)。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(replanReads).toBe(1);

      // 三条换发出来的补排把在途读顶到上限(之后每轮都被硬上限挡住)。
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(replanReads).toBe(2);
      for (let i = 0; i < 3; i += 1) {
        bulkFailed = true;
        h.clock.advance(30_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
        bulkFailed = false;
        h.clock.advance(30_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(wedgedReads).toBe(3);

      // 两轮探测后真实在途为 5(3 个 live + 2 个退役孤儿)。让最早的孤儿迟到回包:
      // 它会清掉退避状态,但另一个孤儿仍在途;预算不能随退避状态一起清零。
      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      bulkFailed = false;
      h.clock.advance(11 * 60_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(wedgedReads).toBe(4);

      bulkFailed = true;
      h.clock.advance(30_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      bulkFailed = false;
      h.clock.advance(6 * 60_000);
      void h.scheduler.tick();
      await vi.advanceTimersByTimeAsync(100);
      expect(wedgedReads).toBe(5);
      expect(inFlightReads).toBe(5);

      // 放回第一条退役读,但保留另一条孤儿,同时确实触发探测退避复位。
      wedgedReadResolvers[0]!(await realGet(sch.id));
      await vi.advanceTimersByTimeAsync(100);
      expect(inFlightReads).toBe(4);

      // settle 后代次前进会再触发探测。首轮可以把剩余孤儿数补到 2,之后必须停在
      // 5 条真实在途;旧实现只在途状态而不按剩余孤儿记账,这里会走到第 6 条。
      for (let i = 0; i < 2; i += 1) {
        bulkFailed = true;
        h.clock.advance(30_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
        bulkFailed = false;
        h.clock.advance(6 * 60_000);
        void h.scheduler.tick();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(inFlightReads).toBe(5);
      expect(wedgedReads).toBe(6);

      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P2 on #11577:守卫回读按任务单飞之后,在途的那一次读可能发端于本地快照
  // 前进之前。用户改短截止时间,update() 换掉 automaticDispatchSchedules 里的那一版
  // (updatedAt 前进),而单飞复用的旧读回来的是改期前那一行(更长的 expireAt);
  // 旧回包通过身份 guard 会把派发快照退回长截止时间,canDispatch 因而在用户新截止
  // 时间之后仍放行 —— 排队中的 run 超过用户设定的期限继续跑。
  it('drops a dispatch guard read that predates the local snapshot', async () => {
    const local = makeHarness({
      preGateStorageTimeoutMs: 30,
      logger: { warn: vi.fn() },
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const schedule = await local.scheduler.create({
      ...baseInput, intervalMs: 15_000, expireAt: createdAt + 90_000,
    });

    local.clock.setTo(schedule.nextFireAt!);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(1);

    // 一次守卫回读进入在途(单飞登记):批量读挂死,这一条也迟迟不回来。
    let releaseRead!: (value: Schedule | null) => void;
    let hangGet = true;
    const realGet = local.storage.get.bind(local.storage);
    vi.spyOn(local.storage, 'listActive').mockImplementation(() => new Promise<Schedule[]>(() => {}));
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== schedule.id || !hangGet) return realGet(id);
      return new Promise<Schedule | null>((resolve) => { releaseRead = resolve; });
    });

    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 用户把截止时间改短(update 走真实存储读,先让 get 恢复正常):守卫换成新版,
    // 而在途的那一次读仍挂着 —— 它发端于改期之前。
    hangGet = false;
    await local.scheduler.update(schedule.id, { expireAt: createdAt + 60_000 });
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(true);

    // 走过新的截止时间:这一行到期离开 listActive,下一轮同步又走回读分支,
    // 复用在途的那一次读。
    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);

    // 在途的那一次读终于回来,带的是改期前那一行(更长的 expireAt、更旧的版本)。
    releaseRead({ ...schedule, status: 'active', expireAt: createdAt + 90_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 旧回包不得把守卫退回长截止时间。
    expect(local.fireCalls[0]!.ctx.canDispatch?.()).toBe(false);

    await local.scheduler.stop();
  });

  // Codex P1 on #11577:共享预算耗尽后,守卫循环不能再逐条等。排队中的自动 attempt
  // 不计入 maxConcurrentRuns,条数可以是几十条;每条再等一个 1ms 定时器、再发一次
  // 读,这一轮 advertised 的硬上限就变成 timeout + O(排队 run 数),把预闸门本该让位
  // 的 due-fire 又推迟下去。改成只挂迟到收口、不当场等 —— 第一条回读失败也不能把
  // 后面几条的收口一起带崩。
  it('reconciles every dispatch guard once the shared budget is spent', async () => {
    // 预闸门预算按**墙钟**算(Scheduler.preGateRemaining 用 Date.now())。Windows 的
    // Date.now() 粒度约 15.6ms:1ms 预算的「预算已耗尽」在那台机器上取决于时钟有没有
    // 跨过毫秒边界 —— 跨过去走迟到收口分支(过),没跨过去走「当场等回读」分支,而回读
    // 被 mock 成 reject,第一条守卫的失败会把整轮守卫循环带崩,第二条守卫根本没发读
    // (挂)。这里自己接管墙钟:listActive 被调用的那一刻(本轮 deadline 已经算完)把
    // 墙钟推到 deadline 之后,「预算已耗尽」在所有平台上都是同一条分支。
    const realNow = Date.now.bind(Date);
    let wallOffset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + wallOffset);
    const local = makeHarness({
      preGateStorageTimeoutMs: 1,
      logger: { warn: vi.fn() },
      // 派发停在途中:守卫快照留在 automaticDispatchSchedules。
      runnerImpl: async () => new Promise<FireResult>(() => {}),
    });
    await local.scheduler.start();
    const createdAt = local.clock.now();
    const first = await local.scheduler.create({ ...baseInput, intervalMs: 15_000 });
    const second = await local.scheduler.create({ ...baseInput, intervalMs: 15_000 });

    local.clock.setTo(createdAt + 15_000);
    void local.scheduler.tick().catch(() => undefined);
    for (let i = 0; i < 100 && local.fireCalls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(local.fireCalls).toHaveLength(2);

    // 批量读挂死:它自己就把 1ms 预算吃光,守卫回读拿到的剩余 ≤0。
    // 回读直接失败(不是超时)—— 逐条等的话,第一次失败就会把整个循环带崩,
    // 后面几条守卫连收口都挂不上。
    const readIds: string[] = [];
    vi.spyOn(local.storage, 'listActive').mockImplementation(() => {
      // 墙钟推进到本轮 deadline(轮开始时的 Date.now() + 1ms)之后:预算已耗尽。
      wallOffset = 1_000;
      return new Promise<Schedule[]>(() => {});
    });
    vi.spyOn(local.storage, 'get').mockImplementation((id: string) => {
      if (id !== first.id && id !== second.id) return Promise.resolve(null);
      readIds.push(id);
      return Promise.reject(new Error('storage unavailable'));
    });

    local.clock.advance(30_000);
    await local.scheduler.tick();

    // 预算耗尽后不再逐条等,但每条守卫都要挂上迟到收口。
    expect(readIds).toEqual([first.id, second.id]);

    nowSpy.mockRestore();
    await local.scheduler.stop();
  });

  it('preserves the primary binding on edits and recognizes a Contacts draft returned by an older mobile client', async () => {
    const prompt = '整理我的通讯录（cindy-contacts 插件）。maintenance begin run_id';
    const s = await h.scheduler.create({ ...baseInput, prompt });
    expect(s.primaryHostKey).toBe('public/cindy-contacts');
    expect((await h.scheduler.update(s.id, { name: 'renamed' })).primaryHostKey).toBe(s.primaryHostKey);
    await expect(h.scheduler.update(s.id, { primaryHostKey: undefined })).rejects.toThrow('binding');
    expect((await h.scheduler.create({ ...baseInput, prompt: prompt + '\nnamespace 传「local」。' })).primaryHostKey).toBe('local/cindy-contacts');
    expect((await h.scheduler.create({ ...baseInput, prompt: 'compile a list' })).primaryHostKey).toBeUndefined();
  });

  it('remembers the first local task of a primary persistent schedule for subsequent runs', async () => {
    const saved = await h.scheduler.create({ ...baseInput, primaryHostKey: 'public/cindy-contacts', persistentSession: true });
    await h.scheduler.updateFromCurrent(saved.id, async current =>
      current.persistentSession && !current.targetSessionId ? { targetSessionId: 'first-task' } : {});
    expect(await h.scheduler.get(saved.id)).toMatchObject({ primaryHostKey: saved.primaryHostKey, targetSessionId: 'first-task' });
    await expect(h.scheduler.update(saved.id, { agentDeviceId: 'other' })).rejects.toThrow('host');
    await expect(h.scheduler.create({ ...baseInput, primaryHostKey: saved.primaryHostKey, targetSessionId: 'unrelated-task' })).rejects.toThrow('host');
  });

  it('can rename a primary schedule with an explicit local model and a legacy remote default', async () => {
    const saved = await h.scheduler.create({
      ...baseInput, primaryHostKey: 'public/cindy-contacts', agentDeviceId: 'studio', modelAgentDeviceId: '',
      modelAgentKind: 'codex', model: 'test-model', providerId: 'local-provider',
    });
    expect(await h.scheduler.update(saved.id, { name: 'renamed' })).toMatchObject({
      name: 'renamed', agentDeviceId: 'studio', modelAgentDeviceId: '', primaryHostKey: 'public/cindy-contacts',
    });
    await expect(h.scheduler.update(saved.id, { modelAgentDeviceId: 'other' })).rejects.toThrow('host');
  });

  // Plugin engines (docs/plans/acp-plugin-bridge.md, 2026-11-19): unit through Scheduler.create /
  // update. A plugin engine only runs as a new task each run on the automation host; the minimal
  // failing inputs are a bound/persistent/worktree/remote/script plugin schedule being saved, or an
  // old peer rewriting only agentKind back to a built-in Harness (a silent engine switch).
  it('saves a plugin engine only as a local new-task-each-run automation', async () => {
    const engine = { agentKind: 'acp', modelAgentKind: 'acp', providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
      model: 'deepseek-v4' } as const;
    const saved = await h.scheduler.create({ ...baseInput, ...engine });
    expect(saved).toMatchObject(engine);
    for (const extra of [
      { targetSessionId: 'task-1' },
      { persistentSession: true },
      { useWorktree: true, workspaceKind: 'project' as const, workingDir: '/repo' },
      { agentDeviceId: 'studio-mac' },
      { providerId: 'anthropic' },
      { modelAgentKind: 'claude-code' as const },
      { executionMode: 'script' as const, scriptConfig: { command: 'echo hi', capabilities: [] } },
    ]) {
      await expect(h.scheduler.create({ ...baseInput, ...engine, ...extra })).rejects.toThrow();
    }
    // A half switch is refused (changing agentKind alone also drops the saved model).
    await expect(h.scheduler.update(saved.id, { agentKind: 'claude-code' })).rejects.toThrow();
    await expect(h.scheduler.update(saved.id, { agentKind: 'claude-code', model: 'deepseek-v4' })).rejects.toThrow(/plugin engine/);
    // A complete switch back to a built-in Harness is an ordinary edit.
    const builtin = await h.scheduler.update(saved.id, {
      agentKind: 'claude-code', modelAgentKind: 'claude-code', model: 'claude-opus-5-5', providerId: 'anthropic',
    });
    expect(builtin).toMatchObject({ agentKind: 'claude-code', modelAgentKind: 'claude-code' });
  });

  it('persists an explicit Harness with its model and clears it when following the target', async () => {
    const saved = await h.scheduler.create({ ...baseInput, modelAgentKind: 'pi', model: 'grok-4.6' });
    expect(saved.modelAgentKind).toBe('pi');
    await expect(h.scheduler.update(saved.id, { model: undefined })).rejects.toThrow(/Harness/);
    const followed = await h.scheduler.update(saved.id, { modelAgentKind: undefined, model: undefined });
    expect(followed?.modelAgentKind).toBeUndefined();
    await expect(h.scheduler.create({ ...baseInput, modelAgentKind: 'pi', model: '' })).rejects.toThrow(/Harness/);
  });

  // Unit: old-client prompt edits preserve remote routing, but incomplete model
  // edits cannot silently keep a different device's credentials.
  it('preserves a saved shared route on partial edits and validates complete changes', async () => {
    const saved = await h.scheduler.create({ ...baseInput, modelAgentKind: 'pi',
      modelAgentDeviceId: 'shared:owner', providerId: 'shared-provider', model: 'remote-model' });
    expect((await h.scheduler.update(saved.id, { prompt: 'new prompt' })).modelAgentDeviceId).toBe('shared:owner');
    await expect(h.scheduler.update(saved.id, { model: 'other-model' })).rejects.toThrow('newer client');
    // Main's older location field cannot silently edit a pinned override.
    await expect(h.scheduler.update(saved.id, { agentDeviceId: 'studio' })).rejects.toThrow('newer client');
    expect((await h.scheduler.get(saved.id))?.model).toBe('remote-model');
    expect((await h.scheduler.update(saved.id, { modelAgentDeviceId: '', model: 'local-model' })).modelAgentDeviceId).toBe('');
    await expect(h.scheduler.create({ ...baseInput, modelAgentDeviceId: 'shared:owner' })).rejects.toThrow('remote model selection');
  });

  // Unit, PR #6830 review: a legacy bound automation has no explicit Harness.
  // A location-only local patch used to save successfully but still run remotely.
  it('rejects an incomplete local selection on a bound automation without changing its saved route', async () => {
    const legacy = { ...baseInput, agentKind: 'codex' as const, targetSessionId: 'remote-task', model: 'same-model', providerId: 'openai' };
    const saved = await h.scheduler.create(legacy);
    await expect(h.scheduler.update(saved.id, { modelAgentDeviceId: '' })).rejects.toThrow('bound task');
    expect(await h.scheduler.get(saved.id)).toEqual(saved);
    await expect(h.scheduler.create({ ...legacy, modelAgentDeviceId: '' })).rejects.toThrow('bound task');
    expect(await h.scheduler.update(saved.id, { modelAgentDeviceId: '', modelAgentKind: 'codex' }))
      .toMatchObject({ modelAgentDeviceId: '', modelAgentKind: 'codex', model: 'same-model' });
    const followed = await h.scheduler.update(saved.id, {
      modelAgentDeviceId: undefined, modelAgentKind: undefined, model: undefined, providerId: undefined,
    });
    expect(followed.modelAgentDeviceId).toBeUndefined();
    expect(followed.modelAgentKind).toBeUndefined();
  });

  // Unit: persistent schedules become bound after their first run. Accepting an
  // incomplete local selection must not make that required internal update fail.
  it('requires an executable local selection before a persistent automation first binds', async () => {
    const persistent = { ...baseInput, persistentSession: true, modelAgentDeviceId: '', model: 'local-model' };
    await expect(h.scheduler.create(persistent)).rejects.toThrow('bound task');
    const saved = await h.scheduler.create({ ...persistent, modelAgentKind: 'codex' });
    expect(await h.scheduler.update(saved.id, { targetSessionId: 'first-run-task' }))
      .toMatchObject({ targetSessionId: 'first-run-task', modelAgentDeviceId: '', modelAgentKind: 'codex' });
  });

  // Unit (model-selector-unified.md §3): update/runNow must preserve an active
  // run and history while later runs use the saved route. The former one-way
  // case missed same-model/provider remote -> local -> remote -> local changes,
  // including clearing effort/Fast; no real timers or vendor calls are needed.
  it('applies repeated location changes only to later runs', async () => {
    let finish!: (value: FireResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: Schedule[] = [];
    const local = makeHarness({ runnerImpl: async (schedule) => {
      calls.push(schedule);
      if (calls.length > 1) return { sessionId: `task-${calls.length}` };
      entered();
      return new Promise<FireResult>((resolve) => { finish = resolve; });
    } });
    const saved = await local.scheduler.create({ ...baseInput, model: 'original' });
    const run = local.scheduler.runNow(saved.id);
    await started;
    const remote = { modelAgentKind: 'codex' as const, modelAgentDeviceId: 'shared:owner',
      model: 'same-model', providerId: 'same-provider', effort: 'xhigh' as const, fastMode: 'ultrafast' as const };
    const onHost = { ...remote, modelAgentDeviceId: '', effort: undefined, fastMode: false };
    await local.scheduler.update(saved.id, remote);
    expect(calls[0]).toMatchObject({ model: 'original' });
    expect(calls[0].modelAgentDeviceId).toBeUndefined();
    finish({ sessionId: 'original-task' });
    await run;
    await local.scheduler.runNow(saved.id);
    expect(calls[1]).toMatchObject(remote);
    const firstHistory = await local.scheduler.listRuns(saved.id, 10);
    for (const route of [onHost, remote, onHost]) {
      expect(await local.scheduler.update(saved.id, route)).toMatchObject(route);
      await local.scheduler.runNow(saved.id);
      expect(calls.at(-1)).toMatchObject(route);
    }
    expect(calls[0]).toMatchObject({ model: 'original' });
    expect(calls[0].modelAgentDeviceId).toBeUndefined();
    expect(calls[1]).toMatchObject(remote);
    for (const previous of firstHistory) {
      expect((await local.scheduler.listRuns(saved.id, 10)).find((r) => r.id === previous.id)).toEqual(previous);
    }
    expect((await local.scheduler.listRuns(saved.id, 10)).map((r) => r.sessionId).sort())
      .toEqual(['original-task', 'task-2', 'task-3', 'task-4', 'task-5']);
  });

  it('create() computes nextFireAt and adds to active map', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    // From 00:00:30, next minute boundary = 00:01:00
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(sch.status).toBe('active');
    // baseInput 无 workingDir / worktree / targetSessionId → 推断为对话任务
    expect(sch.workspaceKind).toBe('dialogue');
    const list = await h.scheduler.list({ status: 'active' });
    expect(list).toHaveLength(1);
  });

  // 测试价值
  // - 生产入口与可观察结果：Scheduler.tick 认领到期任务、运行 runner 并重排 nextFireAt；下一合法槽位前不得重复调用。
  // - Bug／规则依据：#5924；重排结果必须严格晚于完成时刻。
  // - 现有覆盖缺口：已有 tick/互斥测试未在 Lord Howe 亚小时回拨时区验证 cron 重排结果。
  // - 最小失败输入：Lord Howe 回拨后的整点 cron，完成时刻 15:30Z。
  // - tier：unit；内存 storage、假时钟、无副作用 runner。
  // - 实测耗时：随现有 scheduler.test.ts 定向运行记录在 PR 验证项。
  it('Lord Howe 回拨后真实 tick 重排到未来且下一合法槽前不重复', async () => {
    const local = makeHarness();
    local.clock.setTo(Date.UTC(2026, 3, 4, 14, 0, 21));
    const schedule = await local.scheduler.create({
      ...baseInput,
      cronExpr: '0 * * * *',
      timezone: 'Australia/Lord_Howe',
    });
    expect(schedule.nextFireAt).toBe(Date.UTC(2026, 3, 4, 15, 30, 0));

    local.clock.setTo(Date.UTC(2026, 3, 4, 15, 30, 0));
    await local.scheduler.tick();
    expect(local.runner.fire).toHaveBeenCalledTimes(1);
    const run = (await local.storage.listRuns(schedule.id))[0];
    const updated = await local.storage.get(schedule.id);
    expect(run?.finishedAt).toBeDefined();
    expect(updated?.nextFireAt).toBeDefined();
    expect(updated!.nextFireAt!).toBeGreaterThan(run!.finishedAt!);

    local.clock.advance(30_000);
    await local.scheduler.tick();
    expect(local.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('marks skipped child runs as zero-cost', async () => {
    const childHarness = makeHarness({
      runnerImpl: async (_schedule, ctx) => {
        await ctx.createChildRun?.({ status: 'skipped' });
        return { sessionId: '' };
      },
    });
    const sch = await childHarness.scheduler.create({ ...baseInput });

    await childHarness.scheduler.runNow(sch.id);

    const skippedRun = (await childHarness.scheduler.listRuns(sch.id)).find(
      (run) => run.status === 'skipped',
    );
    expect(skippedRun?.costAttribution).toBe('zero');
  });

  it('create() preserves dialogue workspace target', async () => {
    const sch = await h.scheduler.create({ ...baseInput, workspaceKind: 'dialogue' });
    expect(sch.workspaceKind).toBe('dialogue');
  });

  it('create() 未传 workspaceKind 时按目标推断 dialogue/project', async () => {
    // 给了 workingDir → project
    const withDir = await h.scheduler.create({ ...baseInput, workingDir: '/repo' });
    expect(withDir.workspaceKind).toBe('project');
    // 开 worktree(目录由 runner 解析)→ project
    const withWorktree = await h.scheduler.create({ ...baseInput, useWorktree: true });
    expect(withWorktree.workspaceKind).toBe('project');
    // heartbeat(绑已有会话)→ project,不归对话组
    const heartbeat = await h.scheduler.create({ ...baseInput, targetSessionId: 's-1' });
    expect(heartbeat.workspaceKind).toBe('project');
    // 显式 workspaceKind 不被推断覆盖
    const explicit = await h.scheduler.create({ ...baseInput, workspaceKind: 'project' });
    expect(explicit.workspaceKind).toBe('project');
    // 空白串 workingDir 等同未传 → dialogue
    const blankDir = await h.scheduler.create({ ...baseInput, workingDir: '  ' });
    expect(blankDir.workspaceKind).toBe('dialogue');
  });

  // Unit: model admission must fail before persistence, not at the first timer fire.
  // Previous target validation covered Harness changes, not model/location tuples.
  it('keeps storage unchanged when model admission rejects create or update', async () => {
    const validateModelSelection = vi.fn(async (candidate: Schedule, previous?: Schedule) => {
      if (candidate.model === 'unavailable') throw new Error('invalid model location');
      if (previous) expect(previous.model).toBe('available');
    });
    const h = makeHarness({ validateModelSelection });
    await expect(h.scheduler.create({ ...baseInput, model: 'unavailable' }))
      .rejects.toThrow('invalid model location');
    expect(h.storage.schedules.size).toBe(0);
    const saved = await h.scheduler.create({ ...baseInput, model: 'available' });
    await expect(h.scheduler.update(saved.id, { model: 'unavailable' }))
      .rejects.toThrow('invalid model location');
    expect(await h.storage.get(saved.id)).toEqual(saved);
    await h.scheduler.update(saved.id, { name: 'renamed' });
    expect(validateModelSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'renamed', model: 'available' }), saved);
    expect(h.fireCalls).toHaveLength(0);
  });

  it.each(['manual', 'automatic'] as const)(
    'keeps the original fire context while target validation waits (%s)',
    async (mode) => {
      let owner = 'a';
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const local = makeHarness({
        captureFireContext: () => {
          const captured = owner;
          return () => { if (owner !== captured) throw new Error('owner changed'); };
        },
        validateTargetSession: async (_id, op) => {
          if (op === 'fire') { entered(); await gate; }
        },
      });
      const schedule = await local.scheduler.create({ ...baseInput, targetSessionId: 'bound' });
      if (mode === 'automatic') local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
      const fire = mode === 'manual' ? local.scheduler.runNow(schedule.id) : local.scheduler.tick();
      await started;
      owner = 'b';
      release();
      await fire;
      expect(local.fireCalls).toHaveLength(0);
      expect([...local.storage.runs.values()].at(-1)).toMatchObject({ status: 'failed', errorMsg: 'owner changed' });
    },
  );

  it.each(['manual', 'automatic'] as const)(
    'keeps script fires independent of the agent owner guard (%s)',
    async (mode) => {
      const local = makeHarness({ captureFireContext: () => () => { throw new Error('owner changed'); } });
      const schedule = await local.scheduler.create({ ...baseInput, executionMode: 'script', workspaceKind: 'project', workingDir: '/repo', scriptConfig: { command: 'echo ok', capabilities: [] } });
      if (mode === 'automatic') {
        local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
        await local.scheduler.tick();
      } else {
        await local.scheduler.runNow(schedule.id);
      }
      expect(local.fireCalls).toHaveLength(1);
    },
  );

  it('passes the complete candidate Harness to host validation before saving and firing', async () => {
    let allowedAgent = 'codex';
    const validateTargetSession = vi.fn(async (
      _target: string,
      _operation: 'create' | 'update' | 'fire',
      selection: Pick<Schedule, 'modelAgentKind'>,
    ) => {
      if (selection.modelAgentKind && selection.modelAgentKind !== allowedAgent) {
        throw new Error('target Harness is fixed');
      }
    });
    const local = makeHarness({ validateTargetSession });
    await expect(local.scheduler.create({ ...baseInput, targetSessionId: 'bound',
      modelAgentKind: 'pi', model: 'test-model' })).rejects.toThrow('Harness is fixed');
    expect(local.storage.schedules.size).toBe(0);
    const schedule = await local.scheduler.create({ ...baseInput, targetSessionId: 'bound',
      modelAgentKind: 'codex', model: 'test-model' });
    await expect(local.scheduler.update(schedule.id, { modelAgentKind: 'pi' }))
      .rejects.toThrow('Harness is fixed');
    expect((await local.storage.get(schedule.id))?.modelAgentKind).toBe('codex');
    await local.scheduler.update(schedule.id, { name: 'same route' });
    expect(validateTargetSession).toHaveBeenLastCalledWith('bound', 'update',
      expect.objectContaining({ modelAgentKind: 'codex' }));

    // A changed host capability must also be checked on automatic and manual runs.
    allowedAgent = 'pi';
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    expect(local.fireCalls).toHaveLength(0);
    expect(validateTargetSession).toHaveBeenLastCalledWith('bound', 'fire',
      expect.objectContaining({ modelAgentKind: 'codex' }));
    await local.scheduler.runNow(schedule.id);
    expect(local.fireCalls).toHaveLength(0);
    const follow = await local.scheduler.update(schedule.id, { modelAgentKind: undefined });
    expect(follow.modelAgentKind).toBeUndefined();
  });

  it('rejects persisted Review targets at create, update, automatic fire, and runNow after restart', async () => {
    const sourceBySessionId = new Map<string, string>([
      ['session-normal', 'desktop'],
      ['session-review', 'review'],
    ]);
    const operations: Array<{ targetSessionId: string; operation: string }> = [];
    const validateTargetSession = async (
      targetSessionId: string,
      operation: 'create' | 'update' | 'fire',
    ): Promise<void> => {
      operations.push({ targetSessionId, operation });
      if (sourceBySessionId.get(targetSessionId) === 'review') {
        throw new Error('Review tasks cannot be targets of scheduled automations');
      }
    };
    const local = makeHarness({ validateTargetSession });

    await expect(
      local.scheduler.create({ ...baseInput, targetSessionId: 'session-review' }),
    ).rejects.toThrow('Review tasks cannot be targets');
    expect(local.storage.schedules.size).toBe(0);

    const schedule = await local.scheduler.create({
      ...baseInput,
      targetSessionId: 'session-normal',
    });
    await expect(
      local.scheduler.update(schedule.id, { targetSessionId: 'session-review' }),
    ).rejects.toThrow('Review tasks cannot be targets');
    expect((await local.storage.get(schedule.id))?.targetSessionId).toBe('session-normal');

    // The source is durable session state, so a target that becomes a Review
    // task after scheduling must still be rejected by a restarted host.
    sourceBySessionId.set('session-normal', 'review');
    const restarted = makeHarness({
      storage: local.storage,
      clock: local.clock,
      validateTargetSession,
    });
    await restarted.scheduler.start();
    try {
      local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
      await restarted.scheduler.tick();
      expect(restarted.runner.fire).not.toHaveBeenCalled();
      expect(await restarted.scheduler.listRuns(schedule.id)).toMatchObject([
        {
          status: 'failed',
          errorMsg: 'Review tasks cannot be targets of scheduled automations',
        },
      ]);

      await restarted.scheduler.runNow(schedule.id);
      expect(restarted.runner.fire).not.toHaveBeenCalled();
      const runs = await restarted.scheduler.listRuns(schedule.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === 'failed')).toBe(true);
    } finally {
      await restarted.scheduler.stop();
    }

    expect(operations.map((entry) => entry.operation)).toEqual([
      'create',
      'create',
      'update',
      'fire',
      'fire',
    ]);
  });

  it('create()/update() 把 app 管理工作区目录归一成对话任务(host 注入谓词)', async () => {
    const h2 = makeHarness({
      isManagedWorkspaceDir: (dir) => dir.startsWith('/managed/'),
    });
    // agent 把对话自己的 cwd 当 workingDir 传入 → 归一:清目录 + dialogue
    const sch = await h2.scheduler.create({
      ...baseInput,
      workingDir: '/managed/2026-06-12/sess-1',
    });
    expect(sch.workspaceKind).toBe('dialogue');
    expect(sch.workingDir).toBeUndefined();
    // 真实项目目录不受影响
    const proj = await h2.scheduler.create({ ...baseInput, workingDir: '/repo' });
    expect(proj.workspaceKind).toBe('project');
    expect(proj.workingDir).toBe('/repo');
    // update 改成管理目录同样归一
    const updated = await h2.scheduler.update(proj.id, {
      workingDir: '/managed/2026-06-12/sess-2',
    });
    expect(updated.workspaceKind).toBe('dialogue');
    expect(updated.workingDir).toBeUndefined();
    // 未注入谓词的实例不归一(默认 harness)
    const plain = await h.scheduler.create({
      ...baseInput,
      workingDir: '/managed/2026-06-12/sess-3',
    });
    expect(plain.workspaceKind).toBe('project');
  });

  it('update() 换 agentKind 时丢弃上一引擎的 model / providerId / effort(回到默认路由)', async () => {
    // 伙伴接管期把任务钉在 Codex 的 gpt-6-astra@openai 上,之后改回 Claude Code 却没法
    // 清模型 → 任务带着 Claude Code 跑不了的路由,每轮 fire 都被上游拒绝。
    const sch = await h.scheduler.create({
      ...baseInput,
      agentKind: 'codex',
      model: 'gpt-6-astra',
      providerId: 'openai',
      effort: 'medium',
      fastMode: true,
    });
    const switched = await h.scheduler.update(sch.id, { agentKind: 'claude-code' });
    expect(switched.agentKind).toBe('claude-code');
    expect(switched.model).toBeUndefined();
    expect(switched.providerId).toBeUndefined();
    expect(switched.effort).toBeUndefined();
    // 旧引擎的 Fast 开关不能潜伏到下次切回 Codex/Pi 时复活
    expect(switched.fastMode).toBe(false);
    const back = await h.scheduler.update(sch.id, { agentKind: 'codex' });
    expect(back.fastMode).toBe(false);
    expect(back.model).toBeUndefined();
    // 落库 patch 必须带 key(storage 按 hasOwnProperty 清列),不能只是省略
    const stored = h.storage.schedules.get(sch.id)!;
    expect(Object.prototype.hasOwnProperty.call(stored, 'model')).toBe(true);
    expect(stored.model).toBeUndefined();
    expect(stored.providerId).toBeUndefined();

    // 反证 1:agentKind 没变 → 路由原样保留
    const sch2 = await h.scheduler.create({
      ...baseInput,
      agentKind: 'codex',
      model: 'gpt-6-astra',
      providerId: 'openai',
      fastMode: true,
    });
    const same = await h.scheduler.update(sch2.id, { agentKind: 'codex', prompt: 'p2' });
    expect(same.model).toBe('gpt-6-astra');
    expect(same.providerId).toBe('openai');
    expect(same.fastMode).toBe(true);
    const untouched = await h.scheduler.update(sch2.id, { prompt: 'p3' });
    expect(untouched.model).toBe('gpt-6-astra');

    // 反证 2:换引擎同时显式给了新路由 → 按调用方意图
    const explicit = await h.scheduler.update(sch2.id, {
      agentKind: 'claude-code',
      model: 'claude-fable-5-1',
      providerId: 'anthropic',
    });
    expect(explicit.model).toBe('claude-fable-5-1');
    expect(explicit.providerId).toBe('anthropic');
    expect(explicit.effort).toBeUndefined();
    expect(explicit.fastMode).toBe(false);
    // 显式带 fastMode 按调用方意图
    const keepFast = await h.scheduler.update(sch2.id, { agentKind: 'codex', fastMode: true });
    expect(keepFast.fastMode).toBe(true);
  });

  it('update() 改了模型或来源却没带运行位置时回到本机(旧版远程编辑的全量表单)', async () => {
    // 来源属于运行位置那台电脑的目录。旧手机端 / 旧桌面远程编辑不认识 agentDeviceId,
    // 它们选的是本机目录;沿用旧位置会把本机来源派到另一台电脑上。
    const sch = await h.scheduler.create({
      ...baseInput,
      modelAgentKind: 'claude-code',
      model: 'claude-opus-5-5',
      providerId: 'remote-sub',
      agentDeviceId: 'studio',
    });
    expect(sch.agentDeviceId).toBe('studio');
    // 路由原样回传(全量表单只改了名字)→ 位置保留
    const renamed = await h.scheduler.update(sch.id, {
      name: 'renamed', agentKind: 'claude-code', model: 'claude-opus-5-5', providerId: 'remote-sub',
    });
    expect(renamed.agentDeviceId).toBe('studio');
    const moved = await h.scheduler.update(sch.id, { model: 'claude-sonnet-5-5', providerId: 'anthropic' });
    expect(moved.agentDeviceId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(h.storage.schedules.get(sch.id)!, 'agentDeviceId')).toBe(true);
    // 远程位置只配显式模型(那台的默认模型本机解析不了)
    await expect(h.scheduler.create({ ...baseInput, agentDeviceId: 'studio' }))
      .rejects.toThrow('agentDeviceId requires an explicit model');
  });

  // model-groups.md §6.3: a schedule with a mode re-picks every run; its concrete model is the fallback.
  // Gap: clients that only know concrete models (older phones, tools) could change the model while the
  // mode stayed, so the newly chosen model never ran. Minimal input: one schedule with a mode, then an echo,
  // a model change, an explicit keep and an explicit clear. Tier: unit, real engine with in-memory storage.
  it('update() 改了具体模型却没提模式时去掉模式，原样回传或显式给了按调用方', async () => {
    const sch = await h.scheduler.create({
      ...baseInput, modelAgentKind: 'codex', agentKind: 'codex', model: 'gpt-saved', providerId: 'openai', modelGroup: '  daily  ',
    });
    expect(sch.modelGroup).toBe('daily');
    const echoed = await h.scheduler.update(sch.id, { name: 'renamed', model: 'gpt-saved', providerId: 'openai' });
    expect(echoed.modelGroup).toBe('daily');
    const kept = await h.scheduler.update(sch.id, { model: 'gpt-other', modelGroup: 'daily' });
    expect(kept.modelGroup).toBe('daily');
    const changed = await h.scheduler.update(sch.id, { model: 'gpt-third' });
    expect(changed.modelGroup).toBeUndefined();
    const again = await h.scheduler.update(sch.id, { modelGroup: 'review' });
    expect(again.modelGroup).toBe('review');
    const cleared = await h.scheduler.update(sch.id, { modelGroup: undefined });
    expect(cleared.modelGroup).toBeUndefined();
    await expect(h.scheduler.create({ ...baseInput, modelGroup: 'x'.repeat(65) })).rejects.toThrow('modelGroup');
  });

  // PR #11881 review r4653462650: a client that only moves the same model to another computer changed no
  // model field, so the mode stayed and its pick overrode the chosen computer. Minimal input: a mode
  // schedule whose run location alone is echoed, then changed. Tier: unit, real engine, in-memory storage.
  it('update() 只换了运行位置却没提模式时也去掉模式，原样回传保留', async () => {
    const sch = await h.scheduler.create({
      ...baseInput, modelAgentKind: 'codex', agentKind: 'codex', model: 'gpt-saved', providerId: 'openai',
      modelAgentDeviceId: '', modelGroup: 'daily',
    });
    const echoed = await h.scheduler.update(sch.id, { model: 'gpt-saved', providerId: 'openai', modelAgentDeviceId: '' });
    expect(echoed.modelGroup).toBe('daily');
    const moved = await h.scheduler.update(sch.id, { model: 'gpt-saved', providerId: 'openai', modelAgentDeviceId: 'desk-2' });
    expect(moved.modelGroup).toBeUndefined();
    expect(moved.modelAgentDeviceId).toBe('desk-2');
  });

  it('update() 给了真实 workingDir 时翻成 project(与 create 推断对称)', async () => {
    // 对话任务后来被显式改了项目目录 → 不能仍留 dialogue,否则 fire 时
    // 新目录会被管理工作区分配覆盖,显式设置被静默丢弃
    const sch = await h.scheduler.create({ ...baseInput }); // 推断 dialogue
    const updated = await h.scheduler.update(sch.id, { workingDir: '/real/project' });
    expect(updated.workspaceKind).toBe('project');
    expect(updated.workingDir).toBe('/real/project');
    // patch 显式指明 workspaceKind 时不被推断覆盖
    const sch2 = await h.scheduler.create({ ...baseInput });
    const updated2 = await h.scheduler.update(sch2.id, {
      workingDir: '/x',
      workspaceKind: 'dialogue',
    });
    expect(updated2.workspaceKind).toBe('dialogue');
  });

  it('validates script-only schedule shape before insert/update', async () => {
    await expect(
      h.scheduler.create({
        ...baseInput,
        executionMode: 'script',
        scriptConfig: { command: '  ', capabilities: [] },
        workspaceKind: 'project',
        workingDir: '/repo',
        prompt: '',
      }),
    ).rejects.toThrow('non-empty command');

    const script = await h.scheduler.create({
      ...baseInput,
      executionMode: 'script',
      scriptConfig: {
        command: '  python auto.py  ',
        timeoutMs: 1234.8,
        capabilities: ['jira.read', 'jira.read', 'sessions.dispatch'],
      },
      workspaceKind: 'project',
      workingDir: '/repo',
      prompt: '',
    });
    expect(script.scriptConfig).toEqual({
      command: 'python auto.py',
      timeoutMs: 1234,
      capabilities: ['jira.read', 'sessions.dispatch'],
    });

    await expect(h.scheduler.update(script.id, { useWorktree: true })).rejects.toThrow(
      'does not support worktrees or persistent sessions',
    );
    await expect(h.scheduler.update(script.id, { silentWhenIdle: true })).rejects.toThrow(
      'does not support silentWhenIdle',
    );

    const bound = await h.scheduler.update(script.id, { targetSessionId: 'owner-session' });
    expect(bound.targetSessionId).toBe('owner-session');
    expect(bound.executionMode).toBe('script');

    // 堵 update 逃逸:script 任务(prompt 合法为空)只切 executionMode='agent'
    // 不带 prompt → 会落库空提示词的 agent 任务,必须拒;带 prompt 一起切才放行。
    await expect(
      h.scheduler.update(script.id, { executionMode: 'agent', scriptConfig: null }),
    ).rejects.toThrow('prompt is required for agent execution mode');
    const converted = await h.scheduler.update(script.id, {
      executionMode: 'agent',
      scriptConfig: null,
      prompt: '/standup',
    });
    expect(converted.executionMode).toBe('agent');
    expect(converted.scriptConfig).toBeUndefined();
    // 存量兼容:patch 不动 executionMode/prompt 时不触发该校验(改名等照常)
    const renamed = await h.scheduler.update(script.id, { name: 'renamed' });
    expect(renamed.name).toBe('renamed');

    // create 兜底:agent 模式空 prompt 直接拒(工具层/UI 已拦,引擎是最后防线)
    await expect(
      h.scheduler.create({ ...baseInput, prompt: '   ' }),
    ).rejects.toThrow('prompt is required for agent execution mode');
  });

  // Review regression (unit): script sessions.dispatch only resolves local
  // defaults. Reject remote routes before persistence instead of charging a
  // same-id local provider; prior shape tests did not cover a remote selection.
  it('rejects remote model routes in scripts and preserves the saved automation', async () => {
    const remote = { modelAgentKind: 'codex' as const, modelAgentDeviceId: 'shared:owner',
      model: 'same-model', providerId: 'openai' };
    const script = { executionMode: 'script' as const, workspaceKind: 'project' as const,
      workingDir: '/repo', scriptConfig: { command: 'node run.mjs', capabilities: ['sessions.dispatch' as const] } };
    await expect(h.scheduler.create({ ...baseInput, ...remote, ...script })).rejects.toThrow('script execution does not support remote model sources');
    const saved = await h.scheduler.create({ ...baseInput, ...remote, agentDeviceId: 'legacy-studio' });
    await expect(h.scheduler.update(saved.id, script)).rejects.toThrow('script execution does not support remote model sources');
    expect(await h.scheduler.get(saved.id)).toEqual(saved);
    // The explicit local choice remains supported; no new gate on local scripts.
    expect(await h.scheduler.update(saved.id, { ...script, modelAgentDeviceId: '' })).toMatchObject({
      ...script, ...remote, modelAgentDeviceId: '',
    });
  });

  // #8886 / unit: existing cadence tests never set expireAt. Exercise the real
  // create/update/tick/start entries with a deadline between two minute slots.
  it.each([undefined, 30_000])('stops automatic fires at expireAt (interval=%s)', async (intervalMs) => {
    const expireAt = h.clock.now() + 60_000;
    const sch = await h.scheduler.create({ ...baseInput, intervalMs, expireAt });
    h.clock.setTo(sch.nextFireAt!);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
    expect((await h.scheduler.get(sch.id))?.nextFireAt).toBeUndefined();
    h.clock.setTo(expireAt);
    await h.scheduler.tick();
    expect(await h.scheduler.get(sch.id)).toMatchObject({ status: 'expired', nextFireAt: undefined });
    h.clock.advance(120_000);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
  });

  it('expires overdue rows on startup without dispatching them', async () => {
    const sch = await h.scheduler.create(baseInput);
    await h.storage.update(sch.id, { expireAt: h.clock.now() - 1 });
    await h.scheduler.start();
    try {
      expect(await h.scheduler.get(sch.id)).toMatchObject({ status: 'expired', nextFireAt: undefined });
      h.clock.advance(120_000);
      await h.scheduler.tick();
      expect(h.fireCalls).toHaveLength(0);
    } finally { await h.scheduler.stop(); }
  });

  it('does not revive a deadline-expired row on rename or resume, but permits extending it', async () => {
    const sch = await h.scheduler.create({ ...baseInput, expireAt: h.clock.now() - 1 });
    expect(sch.status).toBe('expired');
    expect((await h.scheduler.update(sch.id, { name: 'renamed' })).status).toBe('expired');
    expect((await h.scheduler.resume(sch.id)).status).toBe('expired');
    const renewed = await h.scheduler.update(sch.id, { expireAt: h.clock.now() + 120_000 });
    expect(renewed.status).toBe('active');
    expect(renewed.nextFireAt).toBeGreaterThan(h.clock.now());
  });

  // PR #9059 / unit: reactivation covered recurring schedules only. A deadline
  // before the first Once fire must be reversible, while a consumed Once stays terminal.
  it.each([
    { consumed: false, clear: false }, { consumed: false, clear: true },
    { consumed: true, clear: false }, { consumed: true, clear: true },
  ])('reactivates only an unconsumed one-shot after a deadline edit (%j)', async ({ consumed, clear }) => {
    const expireAt = h.clock.now() + (consumed ? 120_000 : 20_000);
    const sch = await h.scheduler.create({ ...baseInput, recurring: false, expireAt });
    h.clock.setTo(consumed ? sch.nextFireAt! : expireAt);
    await h.scheduler.tick();
    expect((await h.scheduler.get(sch.id))?.status).toBe('expired');
    const updated = await h.scheduler.update(sch.id, { expireAt: clear ? null : h.clock.now() + 120_000 });
    expect(updated.status).toBe(consumed ? 'expired' : 'active');
    if (!consumed) expect(updated.nextFireAt).toBeGreaterThan(h.clock.now());
    else expect(updated.nextFireAt).toBeUndefined();
    h.clock.setTo(updated.nextFireAt ?? h.clock.now() + 60_000);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
    expect((await h.scheduler.get(sch.id))?.status).toBe('expired');
  });

  it('checks wall time after a due fire waited past its deadline', async () => {
    const sch = await h.scheduler.create({ ...baseInput, expireAt: h.clock.now() + 60_000 });
    h.clock.advance(120_000);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(0);
    expect((await h.scheduler.get(sch.id))?.status).toBe('expired');
  });

  it('allows an already-started run to finish across the deadline without rescheduling', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const local = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      expect(ctx.signal.aborted).toBe(false);
      return { sessionId: 'finished' };
    } });
    const expireAt = local.clock.now() + 60_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    local.clock.setTo(sch.nextFireAt!);
    const fire = local.scheduler.tick();
    await ready;
    local.clock.setTo(expireAt);
    await local.scheduler.tick();
    release();
    await fire;
    expect(await local.scheduler.get(sch.id)).toMatchObject({ status: 'expired', nextFireAt: undefined });
    expect((await local.scheduler.listRuns(sch.id))[0]?.status).toBe('success');
  });

  // #8886 / unit: a runner can wait for a busy task before dispatching. The
  // cadence cases above do not exercise edits during that preparation window.
  it.each(['elapsed', 'shortened', 'cleared'] as const)('checks the latest deadline before queued dispatch (%s)', async (change) => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let dispatched = false;
    const local = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      dispatched = ctx.canDispatch?.() !== false;
      return { sessionId: 'busy-task', deferred: !dispatched };
    } });
    const expireAt = local.clock.now() + 120_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    local.clock.setTo(sch.nextFireAt!);
    const fire = local.scheduler.tick();
    await ready;
    if (change === 'shortened') await local.scheduler.update(sch.id, { expireAt: local.clock.now() });
    else {
      if (change === 'cleared') await local.scheduler.update(sch.id, { expireAt: null });
      local.clock.setTo(expireAt);
    }
    release();
    await fire;
    expect(dispatched).toBe(change === 'cleared');
  });

  // PR #9059 / unit: local edits covered the guard, but DB synchronization did
  // not. Change the shared row while a real automatic attempt waits to dispatch.
  it.each(['shortened', 'cleared'] as const)('syncs another instance deadline into a queued dispatch (%s)', async (change) => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let dispatched = false;
    const local = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      dispatched = ctx.canDispatch?.() !== false;
      return { sessionId: '', deferred: !dispatched };
    } });
    const expireAt = local.clock.now() + 120_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    local.clock.setTo(sch.nextFireAt!);
    const fire = local.scheduler.tick();
    await ready;
    await local.storage.update(sch.id, change === 'cleared'
      ? { expireAt: undefined }
      : { expireAt: local.clock.now(), status: 'expired' });
    local.clock.setTo(change === 'cleared' ? expireAt : local.clock.now() + 30_000);
    await local.scheduler.tick();
    release();
    await fire;
    expect(dispatched).toBe(change === 'cleared');
  });

  it.each([false, true])('bounds a deferred retry by the deadline (manual=%s)', async (manual) => {
    const local = makeHarness({ runnerImpl: async () => ({ sessionId: 'busy', deferred: true, deferRetryMs: 120_000 }) });
    const expireAt = local.clock.now() + 60_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    local.clock.setTo(sch.nextFireAt!);
    if (manual) await local.scheduler.runNow(sch.id);
    else await local.scheduler.tick();
    expect((await local.scheduler.get(sch.id))?.nextFireAt).toBeUndefined();
    local.clock.setTo(expireAt);
    await local.scheduler.tick();
    expect((await local.scheduler.get(sch.id))?.status).toBe('expired');
    expect(local.fireCalls).toHaveLength(1);
  });

  it('uses the claimed deadline when another instance shortens it after the scan', async () => {
    const sch = await h.scheduler.create({ ...baseInput, expireAt: h.clock.now() + 120_000 });
    const claim = h.storage.claimDueFire.bind(h.storage);
    vi.spyOn(h.storage, 'claimDueFire').mockImplementationOnce(async (id, next) => {
      await h.storage.update(id, { expireAt: h.clock.now() });
      return claim(id, next);
    });
    h.clock.setTo(sch.nextFireAt!);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(0);
    expect((await h.scheduler.get(sch.id))?.status).toBe('expired');
  });

  it('does not overwrite a deadline extension made during expiration', async () => {
    const sch = await h.scheduler.create({ ...baseInput, expireAt: h.clock.now() + 60_000 });
    const update = h.storage.update.bind(h.storage);
    const extended = h.clock.now() + 180_000;
    vi.spyOn(h.storage, 'update').mockImplementationOnce(async (id, patch, expected) => {
      await update(id, { expireAt: extended });
      return update(id, patch, expected);
    });
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect(await h.scheduler.get(sch.id)).toMatchObject({ status: 'active', expireAt: extended });
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
  });

  it('clears a deadline over JSON while omission preserves it and manual force-fire stays available', async () => {
    const sch = await h.scheduler.create({ ...baseInput, expireAt: h.clock.now() - 1 });
    await h.scheduler.runNow(sch.id);
    expect(h.fireCalls).toHaveLength(1);
    expect((await h.scheduler.update(sch.id, { name: 'kept' })).expireAt).toBe(sch.expireAt);
    const cleared = await h.scheduler.update(sch.id, JSON.parse('{"expireAt":null}'));
    expect(cleared).toMatchObject({ status: 'active', expireAt: undefined });
    expect(cleared.nextFireAt).toBeGreaterThan(h.clock.now());
  });

  // PR #9059 / unit: queued-run tests only edited after runner.fire. Hold the
  // earlier run persistence boundary and observe the actual dispatch decision.
  it.each(['shortened', 'cleared'] as const)('tracks deadline edits during insertRun (%s)', async (change) => {
    let dispatched = false;
    const local = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      dispatched = ctx.canDispatch?.() !== false;
      return { sessionId: '', deferred: !dispatched };
    } });
    const expireAt = local.clock.now() + 120_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    const insertRun = local.storage.insertRun.bind(local.storage);
    vi.spyOn(local.storage, 'insertRun').mockImplementationOnce(async (run) => {
      if (change === 'cleared') local.clock.setTo(expireAt);
      await local.scheduler.update(sch.id, { expireAt: change === 'cleared' ? null : local.clock.now() });
      return insertRun(run);
    });
    local.clock.setTo(sch.nextFireAt!);
    await local.scheduler.tick();
    expect(dispatched).toBe(change === 'cleared');
  });

  // A rename can read either the due time or the cleared in-flight claim.
  // Finish a real automatic run before that read returns; neither snapshot may
  // overwrite its new cadence. Existing rename tests had no concurrent fire.
  it.each([false, true])('preserves completion scheduling during a rename (claimed=%s)', async (claimed) => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const local = makeHarness({ runnerImpl: async () => {
      entered();
      if (claimed) await held;
      return { sessionId: 'completed' };
    } });
    const sch = await local.scheduler.create(baseInput);
    local.clock.setTo(sch.nextFireAt!);
    const fire = claimed ? local.scheduler.tick() : undefined;
    if (claimed) await ready;
    const get = local.storage.get.bind(local.storage);
    let completed!: Schedule;
    vi.spyOn(local.storage, 'get').mockImplementationOnce(async (id) => {
      const snapshot = await get(id);
      release();
      await (fire ?? local.scheduler.tick());
      completed = (await get(id))!;
      return snapshot;
    });
    await local.scheduler.update(sch.id, { name: 'renamed' });
    expect(await local.scheduler.get(sch.id)).toMatchObject({
      name: 'renamed', nextFireAt: completed.nextFireAt, lastFiredAt: completed.lastFiredAt,
    });
    await local.scheduler.tick();
    expect(local.fireCalls).toHaveLength(1);
  });

  // PR #9059 / unit: the prior retry tests never changed the deadline between
  // the read and UPDATE. Simulate another process extending/clearing that row.
  it.each([false, true])('recalculates a deferred retry after a deadline edit (manual=%s)', async (manual) => {
    const local = makeHarness({ runnerImpl: async () => {
      local.clock.setTo(expireAt);
      return { sessionId: '', deferred: true };
    } });
    const expireAt = local.clock.now() + 120_000;
    const sch = await local.scheduler.create({ ...baseInput, expireAt });
    const renewed = manual ? undefined : expireAt + 180_000;
    const update = local.storage.update.bind(local.storage);
    let raced = false;
    vi.spyOn(local.storage, 'update').mockImplementation(async (id, patch, expected) => {
      if (!raced && patch.status === 'expired') {
        raced = true;
        await update(id, { expireAt: renewed });
      }
      return update(id, patch, expected);
    });
    local.clock.setTo(sch.nextFireAt!);
    if (manual) await local.scheduler.runNow(sch.id);
    else await local.scheduler.tick();
    expect(raced).toBe(true);
    const after = await local.scheduler.get(sch.id);
    expect(after).toMatchObject({
      status: 'active', expireAt: renewed, nextFireAt: expireAt + 60_000,
    });
    expect(after?.lastFiredAt).toBeUndefined();
  });

  // PR #9059 / unit: completion CAS failure used to discard the Once-consumed
  // state. Clear its deadline through update exactly before the terminal write.
  it('consumes a one-shot even when its deadline changes during completion', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false, expireAt: h.clock.now() + 120_000 });
    const update = h.storage.update.bind(h.storage);
    let raced = false;
    vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
      if (!raced && patch.lastFinishedAt !== undefined) {
        raced = true;
        await h.scheduler.update(id, { expireAt: null });
      }
      return update(id, patch, expected);
    });
    h.clock.setTo(sch.nextFireAt!);
    await h.scheduler.tick();
    expect(raced).toBe(true);
    expect(await h.scheduler.get(sch.id)).toMatchObject({
      status: 'expired', nextFireAt: undefined, lastFiredAt: sch.nextFireAt, expireAt: undefined,
    });
    h.clock.advance(180_000);
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
  });

  it('recurring fire updates lastFiredAt and recomputes nextFireAt', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
    // Run row recorded
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].sessionId).toBe(`sess-${sch.id}`);
  });

  it('one-shot schedule moves to expired after fire', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('expired');
    expect(after?.nextFireAt).toBeUndefined();
    // No re-fire even after another tick
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 5, 0));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('paused schedule is not fired', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('paused');
  });

  it('resume recomputes nextFireAt and re-arms', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 5, 30));
    await h.scheduler.resume(sch.id);
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
    await h.scheduler.tick(); // not yet due
    expect(h.runner.fire).not.toHaveBeenCalled();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 6, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
  });

  // Bug: resume armed the placeholder cron of a manual schedule, so a webhook-only task
  // started firing on a timer after pause + resume. Public resume entry; unit.
  it('resume keeps a manual schedule off the timer', async () => {
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.pause(sch.id);
    await h.scheduler.resume(sch.id);
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    h.clock.setTo(Date.UTC(2026, 0, 2));
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
  });

  // Rule: docs/product-rules/schedule-webhook-trigger.md. The route must survive edits, or
  // every forwarder configured with the old address silently stops delivering.
  it('generates the webhook route itself and keeps it across edits', async () => {
    const sch = await h.scheduler.create({ ...baseInput, webhookTrigger: { endpointId: 'caller-chosen', events: ['issues'] } });
    const endpointId = sch.webhookTrigger!.endpointId;
    expect(endpointId).not.toBe('caller-chosen');
    const edited = await h.scheduler.update(sch.id, { webhookTrigger: { events: ['pull_request.closed'] } });
    expect(edited.webhookTrigger).toEqual({ endpointId, events: ['pull_request.closed'] });
    const cleared = await h.scheduler.update(sch.id, { webhookTrigger: null });
    expect(cleared.webhookTrigger).toBeUndefined();
    const reopened = await h.scheduler.update(sch.id, { webhookTrigger: {} });
    expect(reopened.webhookTrigger?.endpointId).not.toBe(endpointId);
  });

  it('rejects a webhook on a timed one-shot, which the first event would use up', async () => {
    await expect(h.scheduler.create({ ...baseInput, recurring: false, webhookTrigger: {} })).rejects.toThrow('recurring');
    const manual = await h.scheduler.create({ ...baseInput, recurring: false, manual: true, webhookTrigger: {} });
    expect(manual.webhookTrigger).toBeDefined();
    const sch = await h.scheduler.create({ ...baseInput, webhookTrigger: {} });
    await expect(h.scheduler.update(sch.id, { recurring: false })).rejects.toThrow('recurring');
  });

  // The managed source is configured through the same Scheduler entry as UI, MCP and remote edits.
  it('preserves GitHub App subscriptions and invalidates queued scope when repositories change', async () => {
    const sch = await h.scheduler.create({ ...baseInput, manual: true,
      webhookTrigger: { source: { preset: 'github-app', repositories: ['Example/Project', 'example/project'] }, events: ['issue_comment.created'] } });
    expect(sch.webhookTrigger?.source).toEqual({ preset: 'github-app', repositories: ['example/project'] });
    const retained = await h.scheduler.update(sch.id, { webhookTrigger: { events: ['issue_comment.created'] } });
    expect(retained.webhookTrigger?.endpointId).toBe(sch.webhookTrigger?.endpointId);
    const changed = await h.scheduler.update(sch.id, { webhookTrigger: {
      source: { preset: 'github-app', repositories: ['other/project'] }, events: ['issue_comment.created'] } });
    expect(changed.webhookTrigger?.endpointId).not.toBe(sch.webhookTrigger?.endpointId);
    await expect(h.scheduler.update(sch.id, { webhookTrigger: { events: ['invoice.paid'] } })).rejects.toThrow('unsupported GitHub App');
    await expect(h.scheduler.update(sch.id, { webhookTrigger: { source: { preset: 'github-app', repositories: ['https://github.com/owner/repo'] } } })).rejects.toThrow('repository');
  });

  // PR #9378: UI deselect/reselect changes array order, not the subscription.
  // Real Scheduler updates, unit tier: preserve the route for equivalent sets.
  it('keeps GitHub App queue identity for equivalent repository and event sets', async () => {
    const source = { preset: 'github-app' as const, repositories: ['example/project', 'other/project'] };
    const events = ['issues.opened', 'release.published'];
    const sch = await h.scheduler.create({ ...baseInput, manual: true, webhookTrigger: { source, events } });
    for (const trigger of [
      { source, events: [...events].reverse() },
      { source: { ...source, repositories: [...source.repositories].reverse() }, events },
      { source: { ...source, repositories: ['Other/Project', 'Example/Project', 'example/project'] }, events: [...events, events[0]!] },
    ]) {
      const updated = await h.scheduler.update(sch.id, { webhookTrigger: trigger });
      expect(updated.webhookTrigger?.endpointId).toBe(sch.webhookTrigger?.endpointId);
    }
    const changed = await h.scheduler.update(sch.id, { webhookTrigger: { source, events: ['issues.opened'] } });
    expect(changed.webhookTrigger?.endpointId).not.toBe(sch.webhookTrigger?.endpointId);
  });

  it('rejects malformed webhook event filters', async () => {
    await expect(h.scheduler.create({ ...baseInput, webhookTrigger: { events: ['a b'] } })).rejects.toThrow('filter');
  });

  // Rule: an edit that omits the sender, such as one from a client that predates senders,
  // must not reset it; resetting would switch the server back to GitHub and reject every delivery.
  it('keeps the webhook sender when an edit omits it, and rejects unknown senders', async () => {
    const source = { preset: 'stripe' as const, signed: false };
    const sch = await h.scheduler.create({ ...baseInput, webhookTrigger: { events: ['invoice.paid'], source } });
    const edited = await h.scheduler.update(sch.id, { webhookTrigger: { events: ['pullrequest:created'] } });
    expect(edited.webhookTrigger).toMatchObject({ events: ['pullrequest:created'], source });
    await expect(
      h.scheduler.update(sch.id, { webhookTrigger: { source: { preset: 'unknown' } as never } }),
    ).rejects.toThrow('invalid webhook source');
    await expect(
      h.scheduler.update(sch.id, { webhookTrigger: { source: { preset: 'custom', format: { version: 1 } } as never } }),
    ).rejects.toThrow('invalid webhook format');
  });

  // Rule: the event reaches this fire only; a deferred attempt leaves no run and no cron replay.
  it('passes webhook events to the runner, marks the run, and leaves retries to the caller', async () => {
    const sch = await h.scheduler.create({ ...baseInput, webhookTrigger: {} });
    const webhook = { events: [{ deliveryId: 'd1', event: 'issues', receivedAt: 1 }], omitted: 0 };
    const onRunCreated = vi.fn(async () => {
      expect((await h.storage.listRuns(sch.id))[0]).toMatchObject({ status: 'running', triggerSource: 'webhook' });
      expect(h.runner.fire).not.toHaveBeenCalled();
    });
    await h.scheduler.runNow(sch.id, { deferToCaller: true, webhook, onRunCreated });
    expect(onRunCreated).toHaveBeenCalledOnce();
    expect(h.runner.fire.mock.calls[0]![1].webhook).toEqual(webhook);
    expect((await h.storage.listRuns(sch.id))[0]?.triggerSource).toBe('webhook');

    const before = (await h.storage.get(sch.id))?.nextFireAt;
    h.runner.fire.mockResolvedValueOnce({ sessionId: '', deferred: true, deferRetryMs: 1 });
    const result = await h.scheduler.runNow(sch.id, { deferToCaller: true, webhook });
    expect(result.deferred).toBe(true);
    expect((await h.storage.get(sch.id))?.nextFireAt).toBe(before);
    expect(await h.storage.listRuns(sch.id)).toHaveLength(1);
  });

  // PR #8470: a durable-queue handoff failure must prevent runner effects. Unit:
  // insertRun failure never hands off; handoff failure removes the unused run.
  it.each(['insert', 'handoff'] as const)('does not dispatch a webhook after %s fails', async (phase) => {
    const sch = await h.scheduler.create({ ...baseInput, manual: true, webhookTrigger: {} });
    const webhook = { events: [{ deliveryId: 'd1', event: 'issues', receivedAt: 1 }], omitted: 0 };
    const onRunCreated = vi.fn(async () => { throw new Error('handoff failed'); });
    if (phase === 'insert') vi.spyOn(h.storage, 'insertRun').mockRejectedValueOnce(new Error('insert failed'));
    await expect(h.scheduler.runNow(sch.id, { webhook, onRunCreated })).rejects.toThrow(`${phase} failed`);
    expect(onRunCreated).toHaveBeenCalledTimes(phase === 'insert' ? 0 : 1);
    expect(h.runner.fire).not.toHaveBeenCalled();
    expect(await h.storage.listRuns(sch.id)).toHaveLength(0);
    await h.scheduler.runNow(sch.id, { webhook });
    expect(h.runner.fire).toHaveBeenCalledOnce();
  });

  // PR #8470: automatic Webhook calls used manual admission. Unit: one occupied
  // slot, then two simultaneous Webhook calls; only explicit manual calls bypass.
  it('gates webhook runs with the shared slots before the first storage await', async () => {
    const gated = makeHarness({ maxConcurrentRuns: 1 });
    const a = await gated.scheduler.create({ ...baseInput, manual: true, webhookTrigger: {} });
    const b = await gated.scheduler.create({ ...baseInput, manual: true, webhookTrigger: {} });
    const webhook = { events: [{ deliveryId: 'd1', event: 'issues', receivedAt: 1 }], omitted: 0 };
    let finish!: () => void;
    gated.runner.fire.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ sessionId: '' }); }));
    const running = gated.scheduler.runNow(a.id, { webhook, deferToCaller: true });
    const blocked = await gated.scheduler.runNow(b.id, { webhook, deferToCaller: true });
    expect(blocked.deferred).toBe(true);
    expect(await gated.storage.listRuns(b.id)).toHaveLength(0);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await gated.scheduler.runNow(b.id);
    expect(gated.runner.fire).toHaveBeenCalledTimes(2);
    finish();
    await running;
    await gated.scheduler.runNow(b.id, { webhook, deferToCaller: true });
    expect(gated.runner.fire).toHaveBeenCalledTimes(3);
    await gated.scheduler.stop();
  });

  it('rechecks an approved resume inside the serialized schedule mutation', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    const approved = await h.storage.get(sch.id);
    if (!approved) throw new Error('missing schedule');
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let enterUpdate!: () => void;
    const updateEntered = new Promise<void>((resolve) => { enterUpdate = resolve; });
    const originalUpdate = h.storage.update.bind(h.storage);
    vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch, expected) => {
      if (patch.prompt === 'replacement') {
        enterUpdate();
        await updateReleased;
      }
      return originalUpdate(id, patch, expected);
    });

    const updatePromise = h.scheduler.update(sch.id, { prompt: 'replacement' });
    await updateEntered;
    const resumePromise = h.scheduler.resume(sch.id, approved);
    releaseUpdate();
    await updatePromise;
    await expect(resumePromise).rejects.toThrow('Schedule changed; refresh before executing the approved action');
    expect((await h.storage.get(sch.id))?.status).toBe('paused');
  });

  it('accepts an approval snapshot after the device-link JSON round trip', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    const approved = await h.storage.get(sch.id);
    if (!approved) throw new Error('missing schedule');
    const roundTripped = JSON.parse(JSON.stringify(approved)) as Schedule;
    const resumed = await h.scheduler.resume(sch.id, roundTripped);
    expect(resumed.status).toBe('active');
  });

  it('runner exception marks run failed but schedule stays active', async () => {
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('boom');
      },
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMsg).toBe('boom');
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active'); // not paused/expired on failure
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
  });

  it("script 任务失败消息含 'abort' 字样不误判成 aborted:记 failed 且照常重排(codex review 966)", async () => {
    // script runner 第一方接了 signal(真 abort 时 signal 必已置位),而它的失败
    // 消息携带脚本自己的 stderr——任意文本(如 "operation aborted by remote
    // server")都可能撞上 agent 模式的 /abort/i 兜底。误判成 aborted 会走"不重排
    // nextFireAt"的分支,而 claimDueFire 已把 nextFireAt 清空,recurring 任务就此
    // 静默停摆到重启。
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('script exited with code 1: fatal: operation aborted by remote server');
      },
    });
    const sch = await local.scheduler.create({
      ...baseInput,
      executionMode: 'script',
      scriptConfig: { command: 'python auto.py', capabilities: [] },
      workspaceKind: 'project',
      workingDir: '/repo',
      prompt: '',
    });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed'); // 不是 'aborted'
    expect(runs[0].errorMsg).toContain('operation aborted by remote server');
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0)); // 照常重排,不停摆
  });

  it("agent 任务错误文本 /abort/i 兜底保持原语义(runner 没接 signal 的存量路径)", async () => {
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('session aborted');
      },
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('aborted');
    // aborted 分支不重排(schedule 大概率已被 delete/pause;resume 会自己重算)
    const after = await local.storage.get(sch.id);
    expect(after?.nextFireAt).toBeUndefined();
  });

  it('deferred fire 撤销预插 run、不通知、nextFireAt 前移 deferRetryMs、不写 lastFiredAt', async () => {
    const RETRY = 90_000;
    const local = makeHarness({
      runnerImpl: async (s) => ({ sessionId: `sess-${s.id}`, deferred: true, deferRetryMs: RETRY }),
    });
    const events: string[] = [];
    let firedRunId: string | undefined;
    let deferredRunId: string | undefined;
    local.scheduler.on('fired', (e) => { firedRunId = e.runId; });
    local.scheduler.on('completed', () => events.push('completed'));
    local.scheduler.on('failed', () => events.push('failed'));
    local.scheduler.on('changed', () => events.push('changed'));
    local.scheduler.on('deferred', (e) => { events.push('deferred'); deferredRunId = e.runId; });
    const sch = await local.scheduler.create({ ...baseInput });
    const fireTime = Date.UTC(2026, 0, 1, 0, 1, 5);
    local.clock.setTo(fireTime);
    await local.scheduler.tick();

    expect(local.runner.fire).toHaveBeenCalledTimes(1);
    // 不留可见记录:预插的 running run 被 deleteRun
    expect(await local.scheduler.listRuns(sch.id)).toHaveLength(0);
    // 不通知(completed/failed 都不 emit),emit deferred(清 UI running 态)+ changed(revalidate)
    expect(events).not.toContain('completed');
    expect(events).not.toContain('failed');
    expect(events).toContain('deferred');
    expect(events).toContain('changed');
    // deferred 必须带与 fired 同一个 runId,renderer 才能精确清掉那条 ephemeral running
    expect(deferredRunId).toBe(firedRunId);
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active');
    // nextFireAt 前移到 finishedAt + deferRetryMs(防忙循环),不是正常 cron 槽位
    expect(after?.nextFireAt).toBe(fireTime + RETRY);
    // 没真跑 → 不写 lastFiredAt
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it('deferred runNow 同样撤销 run、不通知、nextFireAt 前移、还原 lastFiredAt', async () => {
    const RETRY = 90_000;
    const local = makeHarness({
      runnerImpl: async (s) => ({ sessionId: `sess-${s.id}`, deferred: true, deferRetryMs: RETRY }),
    });
    const events: string[] = [];
    let firedRunId: string | undefined;
    let deferredRunId: string | undefined;
    local.scheduler.on('fired', (e) => { firedRunId = e.runId; });
    local.scheduler.on('completed', () => events.push('completed'));
    local.scheduler.on('failed', () => events.push('failed'));
    local.scheduler.on('deferred', (e) => { events.push('deferred'); deferredRunId = e.runId; });
    const sch = await local.scheduler.create({ ...baseInput });
    const runAt = Date.UTC(2026, 0, 1, 0, 0, 45);
    local.clock.setTo(runAt);
    await local.scheduler.runNow(sch.id);

    expect(await local.scheduler.listRuns(sch.id)).toHaveLength(0);
    const after = await local.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(runAt + RETRY);
    // runNow 顺延同样:不通知,emit deferred(配对 fired 的 runId)清 UI running 态
    expect(events).not.toContain('completed');
    expect(events).not.toContain('failed');
    expect(events).toContain('deferred');
    expect(deferredRunId).toBe(firedRunId);
    // runNow 在 fire 前乐观写了 lastFiredAt=runAt;顺延必须还原回 fire 前的值
    // (这里 baseInput 没跑过 → undefined),否则顺延却显示成"已触发",且 Once 任务
    // 重启会因 lastFiredAt 已设而吞掉重试。
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it('heartbeat schedule passes targetSessionId through to runner.fire', async () => {
    await h.scheduler.create({
      ...baseInput,
      targetSessionId: 'sess-existing',
    });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
    expect(h.fireCalls[0].schedule.targetSessionId).toBe('sess-existing');
  });

  it('pre-bind fire failure persists targetSessionId and emits it on failed (runNow)', async () => {
    h = makeHarness({
      validateTargetSession: async (_id, op) => {
        if (op === 'fire') throw new Error('target session rejected');
      },
    });
    const sch = await h.scheduler.create({
      ...baseInput,
      targetSessionId: 'session-bound',
    });
    const failedEvents: Array<{ type: string; sessionId?: string; error: string }> = [];
    h.scheduler.on('failed', (e) => failedEvents.push(e));

    const { runId } = await h.scheduler.runNow(sch.id);
    const run = (await h.scheduler.listRuns(sch.id)).find((item) => item.id === runId);

    expect(h.fireCalls).toHaveLength(0);
    expect(run?.status).toBe('failed');
    expect(run?.sessionId).toBe('session-bound');
    expect(failedEvents).toEqual([
      {
        type: 'failed',
        scheduleId: sch.id,
        runId,
        error: 'target session rejected',
        sessionId: 'session-bound',
      },
    ]);
  });

  it('pre-bind fire failure persists targetSessionId on the cron path too', async () => {
    h = makeHarness({
      validateTargetSession: async (_id, op) => {
        if (op === 'fire') throw new Error('target session rejected');
      },
    });
    const sch = await h.scheduler.create({
      ...baseInput,
      targetSessionId: 'session-bound',
    });
    const failedEvents: Array<{ sessionId?: string }> = [];
    h.scheduler.on('failed', (e) => failedEvents.push(e));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].sessionId).toBe('session-bound');
    expect(failedEvents[0]?.sessionId).toBe('session-bound');
  });

  it('emits fired/completed/changed events', async () => {
    const events: Array<{ type: string; scheduleId: string }> = [];
    h.scheduler.on('fired', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('completed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('failed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('changed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    const sch = await h.scheduler.create({ ...baseInput });
    expect(events.find((e) => e.type === 'changed' && e.scheduleId === sch.id)).toBeTruthy();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(events.some((e) => e.type === 'fired' && e.scheduleId === sch.id)).toBe(true);
    expect(events.some((e) => e.type === 'completed' && e.scheduleId === sch.id)).toBe(true);
    const completedIndex = events.findIndex((e) => e.type === 'completed' && e.scheduleId === sch.id);
    const changedAfterCompletedIndex = events.findIndex((e, i) =>
      i > completedIndex &&
      e.type === 'changed' &&
      e.scheduleId === sch.id,
    );
    expect(changedAfterCompletedIndex).toBeGreaterThan(completedIndex);
  });

  it('runNow updates lastFiredAt but keeps nextFireAt; emits changed', async () => {
    // 设计说明：lastFiredAt 语义包含手动 fire（UI "Last X ago" 应反映实际执行）；
    // nextFireAt 不动是因为手动触发不该改变 cron 排定的下一次时间。
    const sch = await h.scheduler.create({ ...baseInput });
    const beforeNext = sch.nextFireAt;
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 0, 45));
    const changed: string[] = [];
    h.scheduler.on('changed', (e) => changed.push(e.scheduleId));
    await h.scheduler.runNow(sch.id);
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(beforeNext);
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 0, 45));
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(changed).toContain(sch.id);
  });

  it('fireOne marks success even when runner returns empty-string sessionId', async () => {
    const local = makeHarness({ runnerImpl: async () => ({ sessionId: '' }) });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].sessionId).toBe('');
  });

  it('delete removes schedule and emits changed', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    let sawDelete = false;
    h.scheduler.on('changed', (e) => {
      if (e.scheduleId === sch.id) sawDelete = true;
    });
    await h.scheduler.delete(sch.id);
    expect(await h.storage.get(sch.id)).toBeNull();
    expect(sawDelete).toBe(true);
  });

  it('delete rejects a missing schedule without emitting changed', async () => {
    const changed = vi.fn();
    const missingId = 'does-not-exist';
    h.scheduler.on('changed', changed);

    await expect(h.scheduler.delete(missingId)).rejects.toThrow(/schedule not found/i);
    expect(changed).not.toHaveBeenCalled();
  });

  it('start() loads active schedules and recomputes nextFireAt for stale ones', async () => {
    // 用 daily cron 避免触发 interval 自动迁移分支（那是另一个测试覆盖）
    h.storage.schedules.set('preseeded', {
      id: 'preseeded',
      name: 'old',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: Date.UTC(2020, 0, 1, 0, 0, 0), // way in the past
    });
    await h.scheduler.start();
    const after = await h.storage.get('preseeded');
    // Recomputed forward to next 09:00 UTC
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    await h.scheduler.stop();
  });

  it('start() isolates legacy invalid interval cron records instead of blocking valid schedules', async () => {
    const warn = vi.fn();
    const local = makeHarness({ logger: { warn } });
    local.storage.schedules.set('legacy-invalid', {
      id: 'legacy-invalid',
      name: 'legacy invalid cron',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '5abc * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      intervalMs: 5 * 60_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: Date.UTC(2020, 0, 1, 0, 0, 0),
    });
    local.storage.schedules.set('valid', {
      id: 'valid',
      name: 'valid cron',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: Date.UTC(2020, 0, 1, 0, 0, 0),
    });

    await expect(local.scheduler.start()).resolves.toBeUndefined();

    expect((await local.storage.get('legacy-invalid'))?.nextFireAt).toBeUndefined();
    expect((await local.storage.get('valid'))?.nextFireAt).toBe(
      Date.UTC(2026, 0, 1, 9, 0, 0),
    );
    expect(warn).toHaveBeenCalledWith(
      'scheduler: skipped invalid active schedule during startup',
      expect.objectContaining({ scheduleId: 'legacy-invalid' }),
    );

    await local.scheduler.stop();
  });

  it('keeps a legacy invalid cron quarantined when clearing its stale fire time fails', async () => {
    const local = makeHarness({ logger: { warn: vi.fn() } });
    const staleFireAt = Date.UTC(2020, 0, 1, 0, 0, 0);
    local.storage.schedules.set('legacy-invalid', {
      id: 'legacy-invalid',
      name: 'legacy invalid cron',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '5abc * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: staleFireAt,
    });
    vi.spyOn(local.storage, 'update').mockRejectedValueOnce(new Error('database is locked'));

    await local.scheduler.start();
    expect((await local.storage.get('legacy-invalid'))?.nextFireAt).toBe(staleFireAt);

    local.clock.advance(30_000);
    await local.scheduler.tick();

    expect(local.runner.fire).not.toHaveBeenCalled();
    expect(await local.scheduler.listRuns('legacy-invalid')).toHaveLength(0);
    await local.scheduler.stop();
  });

  it('quarantines an invalid interval cron first discovered during periodic DB sync', async () => {
    const local = makeHarness({ logger: { warn: vi.fn() } });
    await local.scheduler.start();
    local.storage.schedules.set('late-invalid', {
      id: 'late-invalid',
      name: 'late invalid cron',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '5abc * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      intervalMs: 5 * 60_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: Date.UTC(2020, 0, 1, 0, 0, 0),
    });

    local.clock.advance(30_000);
    await local.scheduler.tick();

    expect(local.runner.fire).not.toHaveBeenCalled();
    expect(await local.scheduler.listRuns('late-invalid')).toHaveLength(0);

    await local.storage.update('late-invalid', {
      cronExpr: '* * * * *',
      nextFireAt: local.clock.now(),
    });
    local.clock.advance(30_000);
    await local.scheduler.tick();

    expect(local.runner.fire).toHaveBeenCalledTimes(1);
    await local.scheduler.stop();
  });

  it('does not execute a schedule whose cron becomes malformed after cache sync but before due-fire claim', async () => {
    const local = makeHarness({ logger: { warn: vi.fn() } });
    await local.scheduler.start();
    const sch = await local.scheduler.create({ ...baseInput, intervalMs: 10_000 });

    // Simulate a second instance writing invalid metadata while retaining the
    // same due time. The first instance still has the valid cached copy and
    // reaches claimDueFire before its 30s DB refresh.
    await local.storage.update(sch.id, { cronExpr: '5abc * * * *' });
    local.clock.advance(10_000);
    await local.scheduler.tick();

    expect(local.runner.fire).not.toHaveBeenCalled();
    expect(await local.scheduler.listRuns(sch.id)).toHaveLength(0);
    expect((await local.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    await local.scheduler.stop();
  });

  // ── intervalMs（"上次完成 + N" 语义）──
  // 这条线和 cron-槽位 完全分支：fireOne / start / resume / create 都要分别覆盖。

  it('intervalMs create() schedules first fire at createdAt + intervalMs', async () => {
    // clock = 00:00:30, intervalMs = 5min → first fire at 00:05:30
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 5 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 5, 30));
    expect(sch.intervalMs).toBe(5 * 60_000);
  });

  it('create() rejects invalid cron metadata even when intervalMs controls the first fire', async () => {
    await expect(h.scheduler.create({
      ...baseInput,
      cronExpr: '5abc * * * *',
      intervalMs: 5 * 60_000,
    })).rejects.toThrow();
    expect(h.storage.schedules.size).toBe(0);
  });

  it('rejects enabling a legacy manual interval schedule with malformed cron metadata', async () => {
    const schedule = await h.scheduler.create({
      ...baseInput,
      manual: true,
      intervalMs: 5 * 60_000,
    });
    await h.storage.update(schedule.id, { cronExpr: '5abc * * * *' });

    await expect(h.scheduler.update(schedule.id, { manual: false })).rejects.toThrow();
    expect(await h.storage.get(schedule.id)).toMatchObject({
      manual: true,
      cronExpr: '5abc * * * *',
    });
  });

  it('rejects reactivating an expired interval schedule with malformed cron metadata', async () => {
    const schedule = await h.scheduler.create({
      ...baseInput,
      intervalMs: 5 * 60_000,
    });
    await h.storage.update(schedule.id, {
      status: 'expired',
      cronExpr: '5abc * * * *',
    });

    await expect(h.scheduler.update(schedule.id, { name: 'try to reactivate' })).rejects.toThrow();
    expect(await h.storage.get(schedule.id)).toMatchObject({
      status: 'expired',
      cronExpr: '5abc * * * *',
      name: schedule.name,
    });
  });

  it('resume() keeps an interval schedule paused when legacy cron metadata is invalid', async () => {
    const sch = await h.scheduler.create({
      ...baseInput,
      cronExpr: '*/10 * * * *',
      intervalMs: 10 * 60_000,
    });
    await h.scheduler.pause(sch.id);
    await h.storage.update(sch.id, { cronExpr: '5abc * * * *' });

    await expect(h.scheduler.resume(sch.id)).rejects.toThrow();
    expect((await h.storage.get(sch.id))?.status).toBe('paused');
  });

  it('intervalMs recurring fire schedules nextFireAt at finishedAt + intervalMs', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 30 * 60_000 });
    // 触发到 next: 00:30:30, runner 立即 resolve（同一时刻 finishedAt = firedAt）
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 30, 30));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.lastFinishedAt).toBe(Date.UTC(2026, 0, 1, 0, 30, 30));
    // 关键断言：next = finishedAt + 30min（不是壁钟槽位 01:00）
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 1, 0, 30));
  });

  it('start() does NOT backfill intervalMs onto interval-shaped cron schedules', async () => {
    // 回归：曾有"老数据迁移"在 start() 时给 `*/N` 形态的纯 cron 任务回填 intervalMs，
    // 误伤 MCP 新建的任务（被转成 interval 语义后，后续改 cron 永远不生效）。
    // 现在 start() 必须保持纯 cron 任务原样，只重算过期的 nextFireAt。
    h.storage.schedules.set('cron-30m', {
      id: 'cron-30m',
      name: 'pure cron 30m',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '*/30 * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      updatedAt: 0,
      lastFinishedAt: Date.UTC(2026, 0, 1, 0, 0, 17),
      nextFireAt: Date.UTC(2026, 0, 1, 0, 30, 0),
    });
    await h.scheduler.start();
    const after = await h.storage.get('cron-30m');
    expect(after?.intervalMs).toBeUndefined();
    // 壁钟槽位语义保持：下一次仍是 00:30:00 整
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 30, 0));
    await h.scheduler.stop();
  });

  it('start() preserves planned nextFireAt when it is still in the future (no restart-bump)', async () => {
    // 复刻线上 bug：上次跑完 17:22:25，原计划 18:22:25。app 在 18:11 重启时，
    // 旧逻辑 max(base+N, now+N) 永远取 now+N → next 被错误推到 19:11。
    // 修复后：planned > now 时尊重原计划，next 仍是 18:22:25。
    h.clock.setTo(Date.UTC(2026, 0, 1, 17, 22, 25));
    h.storage.schedules.set('hourly', {
      id: 'hourly',
      name: 'every hour',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 * * * *',
      intervalMs: 60 * 60_000,
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: Date.UTC(2026, 0, 1, 16, 0, 0),
      updatedAt: 0,
      lastFiredAt: Date.UTC(2026, 0, 1, 17, 22, 18),
      lastFinishedAt: Date.UTC(2026, 0, 1, 17, 22, 25),
      nextFireAt: Date.UTC(2026, 0, 1, 18, 22, 25),
    });
    // 模拟 49 分钟后冷启动
    h.clock.setTo(Date.UTC(2026, 0, 1, 18, 11, 0));
    await h.scheduler.start();
    const after = await h.storage.get('hourly');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 18, 22, 25));
    await h.scheduler.stop();
  });

  it('resume() with intervalMs starts a fresh N countdown from now', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 5, 0, 0));
    await h.scheduler.resume(sch.id);
    const after = await h.storage.get(sch.id);
    // 没跑过，base = createdAt = 00:00:30。max(00:10:30, 05:10:00) = 05:10:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 5, 10, 0));
  });

  it('resume() with intervalMs cold-starts from now even when the last run is recent', async () => {
    // Regression: resume is documented as a cold start ("起新一轮 N 倒计时"), matching
    // update()'s `now + intervalMs`. A schedule that finished 17:22:25 with a 1h
    // interval, resumed at 17:40:00 (well within that hour), must re-arm at
    // now + 1h = 18:40:00 — NOT lastFinishedAt + 1h = 18:22:25. The latter is
    // start()/restart's "respect the original cadence" semantics, which must not
    // leak into a user-initiated resume.
    h.storage.schedules.set('hourly', {
      id: 'hourly',
      name: 'every hour',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 * * * *',
      intervalMs: 60 * 60_000,
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'paused',
      createdAt: Date.UTC(2026, 0, 1, 16, 0, 0),
      updatedAt: 0,
      lastFiredAt: Date.UTC(2026, 0, 1, 17, 22, 18),
      lastFinishedAt: Date.UTC(2026, 0, 1, 17, 22, 25),
      nextFireAt: Date.UTC(2026, 0, 1, 18, 22, 25),
    });
    h.clock.setTo(Date.UTC(2026, 0, 1, 17, 40, 0));
    await h.scheduler.resume('hourly');
    const after = await h.storage.get('hourly');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 18, 40, 0));
  });

  // ── update() 在用户编辑时是否立刻取消 pending fire ──
  // 用户体感："Next 13:50" 还有 9 分钟到，我把 Every 10min 改成 Every 5min，
  // 应该看到 nextFireAt 立刻刷成 now+5min（取消旧的 13:50）。

  it('update(intervalMs) cancels pending fire and reschedules from now', async () => {
    // create at 00:00:30 with intervalMs=10min → nextFireAt = 00:10:30
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    // advance to 00:01:00 and shrink interval to 5min
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { intervalMs: 5 * 60_000, cronExpr: '*/5 * * * *' });
    const after = await h.storage.get(sch.id);
    // pending fire is cancelled; new fire scheduled at now+5min = 00:06:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
  });

  it('update(cronExpr) from interval to daily cancels pending fire', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // switch to daily 09:00 UTC; explicitly pass intervalMs:undefined like form does
    await h.scheduler.update(sch.id, { cronExpr: '0 9 * * *', intervalMs: undefined });
    const after = await h.storage.get(sch.id);
    // should be next 09:00, NOT old 00:10:30 and NOT now+10min
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(after?.intervalMs).toBeUndefined();
  });

  // ── intervalMs 真 partial 契约：没带 key 就不动，显式带 key(undefined)才清空 ──
  // 历史演进（两个方向都栽过，改这里前先读完）：
  //   1. 最早：cronExpr-only patch 保留旧 intervalMs → interval 永远获胜，改 cron
  //      形同虚设（当时 MCP schema 不暴露 intervalMs，调用方无法表达清空）。
  //   2. 于是加了隐式清空：cronExpr 在场且没带 intervalMs key → 清。intervalMs 对
  //      调用方开放后，它反过来成为静默事故源：只更新 prompt + cronExpr（cadence
  //      展示对齐的常见形态）就把 interval 任务打回 cron 槽位语义（2026-07-29 #211
  //      心跳实测），所有调用方被迫背「三件套一起带」。
  //   3. 现在：真 partial。清空唯一表达 = 显式带 key 且值 undefined（JSON 边界为
  //      null，由 MCP 工具层翻译）。GUI 表单恒带 key，行为不变。
  // 仍然**不做**"按形态推导 interval"：cron 就是 cron，与 create() 对称。

  it('update(cronExpr only) keeps interval authority and re-arms from now', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 模拟 MCP patch：只带 cronExpr（cadence 展示对齐），没有 intervalMs key
    await h.scheduler.update(sch.id, { cronExpr: '*/30 * * * *' });
    const after = await h.storage.get(sch.id);
    // interval 语义保持权威，不被隐式清空
    expect(after?.intervalMs).toBe(10 * 60_000);
    // 触发字段变了 → 按 interval 冷启动重排：now + 10min = 00:11:00（不是 */30 壁钟槽位）
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 11, 0));
  });

  it('rejects an invalid cronExpr update even when interval scheduling remains authoritative', async () => {
    const sch = await h.scheduler.create({
      ...baseInput,
      cronExpr: '*/10 * * * *',
      intervalMs: 10 * 60_000,
    });

    await expect(h.scheduler.update(sch.id, { cronExpr: '5abc * * * *' })).rejects.toThrow();

    const stored = await h.storage.get(sch.id);
    expect(stored).toMatchObject({
      cronExpr: '*/10 * * * *',
      intervalMs: 10 * 60_000,
    });
  });

  it('rejects interval-only re-arms when legacy cron metadata is malformed', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    await h.storage.update(sch.id, { cronExpr: '5abc * * * *' });
    const before = await h.storage.get(sch.id);

    await expect(h.scheduler.update(sch.id, { intervalMs: 5 * 60_000 })).rejects.toThrow();
    expect(await h.storage.get(sch.id)).toEqual(before);
  });

  it('update(prompt only) leaves intervalMs and nextFireAt completely untouched', async () => {
    // 2026-07-29 #211 事故形态的回归：改 prompt 绝不能动 interval 语义
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { prompt: 'new prompt' });
    const after = await h.storage.get(sch.id);
    expect(after?.intervalMs).toBe(10 * 60_000);
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
  });

  it('update with explicit intervalMs:undefined key alone clears and falls back to cron slots', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 显式清空不需要同时改 cronExpr
    await h.scheduler.update(sch.id, { intervalMs: undefined });
    const after = await h.storage.get(sch.id);
    expect(after?.intervalMs).toBeUndefined();
    // 回到现有 cron 的壁钟槽位：下一个 */10 = 00:10:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 0));
  });

  it('update with explicit intervalMs key still wins over cron-derived value', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 表单形态：cronExpr 和 intervalMs 都显式带（与 cron 不一致也尊重调用方）
    await h.scheduler.update(sch.id, { cronExpr: '*/30 * * * *', intervalMs: 5 * 60_000 });
    const after = await h.storage.get(sch.id);
    expect(after?.intervalMs).toBe(5 * 60_000);
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
  });

  // 模拟真实表单 patch 形态：full CreateScheduleInput 字段全量带过来
  // （form.toInput() 总是返回所有字段，而不是 diff）
  it('update with full form-shaped patch recomputes nextFireAt', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 模拟 useScheduleForm.toInput() 的输出：所有字段都带，intervalMs 改 5min
    await h.scheduler.update(sch.id, {
      name: 'test',
      prompt: 'do thing',
      kind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      intervalMs: 5 * 60_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
    });
    const after = await h.storage.get(sch.id);
    // 期望取消旧的 00:10:30，重排到 now(00:01:00) + 5min = 00:06:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
    expect(after?.intervalMs).toBe(5 * 60_000);
  });

  it('update revives an expired one-shot after it becomes recurring and survives restart', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect((await h.storage.get(sch.id))?.status).toBe('expired');

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 2, 10));
    const revived = await h.scheduler.update(sch.id, { recurring: true });
    expect(revived.status).toBe('active');
    expect(revived.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 3, 0));

    // 模拟重启：新 Scheduler 必须能从 storage.listActive() 重新加载并按新排期触发。
    const restarted = makeHarness({ storage: h.storage, clock: h.clock });
    await restarted.scheduler.start();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 3, 0));
    await restarted.scheduler.tick();
    expect(restarted.runner.fire).toHaveBeenCalledTimes(1);
    expect((await h.storage.get(sch.id))?.status).toBe('active');
    await restarted.scheduler.stop();
  });

  // Rule (plugin pre-run check, 2026-10-31): a newly chosen plugin is resolved to its instance id
  // and rejected when unusable, but keeping the same plugin never re-validates, so a later-disabled
  // plugin does not lock the user out of editing; null clears it. No prior case covers preRunPlugin.
  it('resolves a newly chosen pre-run plugin and only re-checks it when the plugin changes', async () => {
    const resolve = vi.fn((id: string) => {
      if (id === 'gone') throw new Error('not installed');
      return `${id}@inst`;
    });
    const p = makeHarness({ resolvePreRunPlugin: resolve });
    const sch = await p.scheduler.create({ ...baseInput, preRunPlugin: { pluginId: 'jev', onFailure: 'skip' } });
    expect(sch.preRunPlugin).toEqual({ pluginId: 'jev@inst', onFailure: 'skip' });
    const kept = await p.scheduler.update(sch.id, { preRunPlugin: { pluginId: 'jev@inst', onFailure: 'block' } });
    expect(kept.preRunPlugin).toEqual({ pluginId: 'jev@inst', onFailure: 'block' });
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(p.scheduler.update(sch.id, { preRunPlugin: { pluginId: 'gone', onFailure: 'block' } })).rejects.toThrow(/not installed/);
    expect((await p.scheduler.update(sch.id, { preRunPlugin: null })).preRunPlugin).toBeUndefined();
    await expect(h.scheduler.create({ ...baseInput, preRunPlugin: { pluginId: 'jev', onFailure: 'skip' } })).rejects.toThrow(/not available/);
  });

  it('updateFromCurrent 把读取、生成 patch 与写入放在同一任务锁内', async () => {
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'node old.mjs' },
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = h.scheduler.updateFromCurrent(sch.id, async () => {
      firstEntered();
      await firstGate;
      return { preRunHook: { command: 'node new.mjs' } };
    });
    await firstEnteredPromise;

    let secondSnapshot: Schedule | undefined;
    const second = h.scheduler.updateFromCurrent(sch.id, async (current) => {
      secondSnapshot = current;
      return { name: 'renamed', preRunHook: current.preRunHook };
    });
    await Promise.resolve();
    expect(secondSnapshot).toBeUndefined();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondSnapshot?.preRunHook?.command).toBe('node new.mjs');
    expect((await h.storage.get(sch.id))?.preRunHook?.command).toBe('node new.mjs');
  });

  it('serializes pause behind an expired schedule revival so active cache stays paused', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect((await h.storage.get(sch.id))?.status).toBe('expired');

    const storageUpdate = h.storage.update.bind(h.storage);
    let releaseRevival!: () => void;
    const revivalGate = new Promise<void>((resolve) => {
      releaseRevival = resolve;
    });
    let revivalPersisted!: () => void;
    const revivalPersistedPromise = new Promise<void>((resolve) => {
      revivalPersisted = resolve;
    });
    let pauseWriteCalls = 0;
    vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch) => {
      const updated = await storageUpdate(id, patch);
      if (patch.status === 'active') {
        revivalPersisted();
        await revivalGate;
      } else if (patch.status === 'paused') {
        pauseWriteCalls += 1;
      }
      return updated;
    });

    const revivePromise = h.scheduler.update(sch.id, { recurring: true });
    await revivalPersistedPromise;
    const pausePromise = h.scheduler.pause(sch.id);

    // 让 pause 的 microtask 有机会推进；同一 schedule 的 mutation 临界区仍被 revival 占用，
    // 因此 pause 不能越过它先写 DB / 删除缓存。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pauseWriteCalls).toBe(0);

    releaseRevival();
    await Promise.all([revivePromise, pausePromise]);
    expect((await h.storage.get(sch.id))?.status).toBe('paused');
    // @ts-expect-error 访问私有 map 仅用于验证 reviewer 指出的缓存竞态。
    expect(h.scheduler.activeSchedules.has(sch.id)).toBe(false);
  });

  it('update keeps an expired one-shot expired when it remains non-recurring', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const updated = await h.scheduler.update(sch.id, { name: 'still one-shot' });
    expect(updated.status).toBe('expired');
    expect(updated.nextFireAt).toBeUndefined();
  });

  it('update keeps an expired schedule out of auto scheduling when recurring but manual', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const updated = await h.scheduler.update(sch.id, { recurring: true, manual: true });
    expect(updated.status).toBe('expired');
    expect(updated.nextFireAt).toBeUndefined();
  });

  // ── delete/pause abort in-flight runs ─────────────────────────────────────
  //
  // 这组用例覆盖"删除/暂停时彻底中断已在跑的 run"。
  // runner.fire 永远不自然 resolve,只 await ctx.signal abort —— 模拟真实 agent
  // 长时间挂在 turnFinished 上的场景。test 用 ctx.signal abort 触发 reject,
  // 验证 engine 把 run 标 'aborted'、map 清空、schedule 状态正确。

  it('delete aborts in-flight run, marks status=aborted, leaks no entries', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    // 不 await —— tick 起飞 runner 但 runner 永远不 resolve
    const tickPromise = local.scheduler.tick();
    // 让 microtask queue 跑一圈,确保 fireOne 已注册 controller
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    // delete 触发 abort,等 fireOne 走完 finally + storage.updateRun
    await local.scheduler.delete(sch.id);
    await tickPromise;
    expect(await local.storage.get(sch.id)).toBeNull();
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
    expect(runs[0].errorMsg).toMatch(/cancelled by user/);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
  });

  it('pause aborts in-flight run, keeps schedule with status=paused', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    await local.scheduler.pause(sch.id);
    await tickPromise;
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('paused');
    // pause 不应该把 lastFinishedAt / nextFireAt 写脏(aborted 短路了重排)
    expect(after?.lastFinishedAt).toBeUndefined();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
  });

  it('getInflightCount tracks 0 → 1 → 0 across a single fire', async () => {
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: () => new Promise<{ sessionId: string }>((r) => { resolveRunner = r; }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    resolveRunner({ sessionId: 'sess-1' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
  });

  it('concurrent fires (cron + runNow) all abort cleanly on delete', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    // 先 cron tick 起一个,再 runNow 起第二个 —— 并发 2 个 in-flight
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 5));
    const runNowPromise = local.scheduler.runNow(sch.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(2);
    // delete 一次性 abort 两条
    await local.scheduler.delete(sch.id);
    await Promise.allSettled([tickPromise, runNowPromise]);
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'aborted')).toBe(true);
  });

  // ── delete/pause 的 caller-run 豁免(exemptRunId)────────────────────────────
  //
  // 场景:agent 在任务 run 内 delete/pause 自己所属的 schedule(心跳收口的标准
  // 动作)。不豁免的话 delete 会 abort 发起方自己这轮 run —— turn 被强杀、收尾
  // 汇报被掐断(2026-07-03 PR #471 心跳实锤)。豁免后该 run 自然跑完。
  //
  // 注意:InMemoryStorage.delete 不模拟 SQLite 的 ON DELETE CASCADE(上面
  // aborted 断言依赖非级联行为),所以豁免 run 的 success 落库在这里可见;
  // 真实 SQLite 下 run 行已随 schedule 级联删除,updateRun 是 no-op —— 两种
  // 语义下 fireOne 收尾都不抛错,这正是本组用例要固化的行为。

  it('delete with exemptRunId leaves caller run running; it completes normally', async () => {
    const signalAborted: boolean[] = [];
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          ctx.onTurnActive?.('sess-caller');
          resolveRunner = resolve;
          ctx.signal.addEventListener('abort', () => signalAborted.push(true));
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    const callerRunId = local.fireCalls[0].ctx.runId;

    // 豁免 caller run:delete 立即返回(不 abort 它、不等它 settle)
    const receipt = { errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED' as const, firedAt: 1, laterRunSucceeded: false };
    local.storage.latestClosureFailure = async (scheduleId, sessionId) =>
      scheduleId === sch.id && sessionId === 'sess-caller' ? receipt : undefined;
    expect(await local.scheduler.delete(sch.id, { exemptRunId: callerRunId })).toEqual(receipt);
    expect(signalAborted).toHaveLength(0);
    expect(await local.storage.get(sch.id)).toBeNull();
    // caller run 仍在 in-flight(fireOne 还没走完 finally)
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    // run 行已随 schedule 级联删除,但引擎内存仍报它在跑 —— renderer 的通知抑制标记
    // 对账靠这份快照区分「查不到 = 跑完了」与「查不到 = 自删除后仍在跑」。
    expect(local.scheduler.listInflightRunIds()).toContain(callerRunId);

    // caller run 自然跑完:fireOne 收尾不抛错,run 走 success 分支
    resolveRunner({ sessionId: 'sess-caller' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    expect(local.scheduler.listInflightRunIds()).not.toContain(callerRunId);
    const run = local.storage.runs.get(callerRunId);
    expect(run?.status).toBe('success');
    // schedule 行已删,fireOne 尾部重排的 storage.update 是 no-op,不会复活 schedule
    expect(await local.storage.get(sch.id)).toBeNull();
  });

  it('delete with exemptRunId still aborts sibling in-flight runs', async () => {
    const abortedRunIds: string[] = [];
    const resolvers = new Map<string, (v: { sessionId: string }) => void>();
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve, reject) => {
          resolvers.set(ctx.runId, resolve);
          ctx.signal.addEventListener('abort', () => {
            abortedRunIds.push(ctx.runId);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 5));
    const runNowPromise = local.scheduler.runNow(sch.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(2);
    const callerRunId = local.fireCalls[0].ctx.runId;
    const siblingRunId = local.fireCalls[1].ctx.runId;

    // 豁免 caller,兄弟 run 照常 abort;delete 等兄弟 settle 后返回
    await local.scheduler.delete(sch.id, { exemptRunId: callerRunId });
    expect(abortedRunIds).toEqual([siblingRunId]);
    expect(await local.storage.get(sch.id)).toBeNull();

    resolvers.get(callerRunId)!({ sessionId: 'sess-caller' });
    await Promise.allSettled([tickPromise, runNowPromise]);
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    expect(local.storage.runs.get(siblingRunId)?.status).toBe('aborted');
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
  });

  it('delete with an unrelated exemptRunId behaves like plain delete (all aborted)', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);

    // exemptRunId 不属于本 schedule 的 in-flight set → 豁免不命中,全部 abort
    await local.scheduler.delete(sch.id, { exemptRunId: 'run-of-another-schedule' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
  });

  it('pause with exemptRunId leaves caller run running; run lands success on a paused schedule', async () => {
    const signalAborted: boolean[] = [];
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRunner = resolve;
          ctx.signal.addEventListener('abort', () => signalAborted.push(true));
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    const callerRunId = local.fireCalls[0].ctx.runId;

    const paused = await local.scheduler.pause(sch.id, { exemptRunId: callerRunId });
    expect(paused.status).toBe('paused');
    expect(signalAborted).toHaveLength(0);

    resolveRunner({ sessionId: 'sess-caller' });
    await tickPromise;
    // run 正常 success 落库;schedule 保持 paused,fireOne 尾部不会把它加回 active
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
    expect((await local.storage.get(sch.id))?.status).toBe('paused');
    // 旧 fire 时间再到也不触发(activeSchedules 已摘除)
    local.clock.setTo(Date.UTC(2026, 0, 2, 0, 1, 5));
    await local.scheduler.tick();
    expect(local.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('one-shot schedule paused by its own run stays paused after run completes', async () => {
    // 回归：recurring=false 的 run 调 pause(exemptRunId=self) → fireOne 收尾不得把
    // 'paused' 覆盖成 'expired'。
    let resolveRunner!: (v: { sessionId: string }) => void;
    const ref: { scheduler?: Scheduler } = {};
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRunner = resolve;
          void ref.scheduler!.pause(_s.id, { exemptRunId: ctx.runId });
        }),
    });
    ref.scheduler = local.scheduler;
    const sch = await local.scheduler.create({ ...baseInput, recurring: false });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    const callerRunId = local.fireCalls[0].ctx.runId;

    // run 内 pause 已将 schedule 标为 paused
    expect((await local.storage.get(sch.id))?.status).toBe('paused');

    // runner 完成 → fireOne 收尾不得把 paused 覆盖成 expired
    resolveRunner({ sessionId: 'sess-one-shot' });
    await tickPromise;
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
    expect((await local.storage.get(sch.id))?.status).toBe('paused');
  });

  // tick 验证：编辑后旧时间到了不会再触发（nextFireAt 已被重排）
  it('after update, old pending fire time is skipped by tick', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { intervalMs: 5 * 60_000, cronExpr: '*/5 * * * *' });
    // 推进到原来的 00:10:30 触发点
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 10, 30));
    await h.scheduler.tick();
    // 新 nextFireAt = 00:06:00，已经过了 → 应该 fire 一次（new schedule 触发）
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    const after = await h.storage.get(sch.id);
    // fireOne 完成后，nextFireAt = finishedAt + 5min = 00:10:30 + 5min = 00:15:30
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 15, 30));
  });

  // ── fireOne 收尾重排必须用 DB 最新行，不能用 fire 时刻的快照 ──
  // 真实场景：PR 跟进任务在 run 内调 schedule_update 自适应降档改 cron，
  // 修复前 run 结束的重排按旧快照把 nextFireAt 覆盖回旧 cron 的槽位。

  it('mid-run cronExpr update is not clobbered by post-run recompute', async () => {
    const ref: { scheduler?: Scheduler } = {};
    const local = makeHarness({
      runnerImpl: async (s) => {
        // run 内 agent 把节奏从 */10 降档到每天 09:00
        await ref.scheduler!.update(s.id, { cronExpr: '0 9 * * *' });
        return { sessionId: 'sess-mid-update' };
      },
    });
    ref.scheduler = local.scheduler;
    const sch = await local.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *' });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 10, 5));
    await local.scheduler.tick();
    const after = await local.storage.get(sch.id);
    // 按新 cron 排到 09:00，而不是旧 */10 的下一个槽位 00:20:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(after?.intervalMs).toBeUndefined();
  });

  // ---------- 静默 run(silenceRun / isRunSilenced)----------

  it('silenced run lands with readAt set (success path, fireOne)', async () => {
    // runnerImpl 在 fire 期间用本轮 ctx.runId 调 silenceRun —— 模拟任务内 agent
    // 经 MCP 工具声明"本轮无需关注"
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-x' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const events: unknown[] = [];
    h.scheduler.on('silenced', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    // 生而已读:readAt = finishedAt,小红点计算(!readAt && 终态)排除本条
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      { type: 'silenced', scheduleId: sch.id, runId: runs[0].id, sessionId: 'sess-x' },
      {
        type: 'completed',
        scheduleId: sch.id,
        runId: runs[0].id,
        sessionId: 'sess-x',
        silenced: true,
      },
    ]);
    // 终态后清理内存标记,不泄漏
    expect(h.scheduler.isRunSilenced(runs[0].id)).toBe(false);
  });

  it('silenced run via runNow also lands read', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        return { sessionId: 'sess-x' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const { runId } = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(h.scheduler.isRunSilenced(runId)).toBe(false);
  });

  it('keeps unclassified reminders audible and preserves explicit quiet checks and script mode', async () => {
    const reminder = await h.scheduler.create({ ...baseInput });
    expect(reminder.silentWhenIdle).toBe(false);
    const { runId } = await h.scheduler.runNow(reminder.id);
    expect((await h.scheduler.listRuns(reminder.id)).find((run) => run.id === runId)?.readAt).toBeUndefined();
    expect((await h.scheduler.create({ ...baseInput, preRunHook: { command: 'node check.mjs' } })).silentWhenIdle).toBe(false);
    const check = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    expect(check.silentWhenIdle).toBe(true);
    expect((await h.scheduler.create({ ...baseInput, executionMode: 'script', workspaceKind: 'project', workingDir: '/repo', scriptConfig: { command: 'node check.mjs', capabilities: [] } })).silentWhenIdle).toBe(false);
    const scriptPatch = { executionMode: 'script' as const, workspaceKind: 'project' as const, workingDir: '/repo', scriptConfig: { command: 'node check.mjs', capabilities: [] } };
    await expect(h.scheduler.update(check.id, { ...scriptPatch, silentWhenIdle: true })).rejects.toThrow('does not support silentWhenIdle');
    expect((await h.scheduler.update(check.id, scriptPatch)).silentWhenIdle).toBe(false);
  });

  it('silentWhenIdle run is silent by default', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-silent');
        ctx.onTurnActive?.('sess-silent');
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-silent' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    const events: unknown[] = [];
    h.scheduler.on('fired', (e) => events.push(e));
    h.scheduler.on('session-bound', (e) => events.push(e));
    h.scheduler.on('silenced', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    const { runId, silenced } = await h.scheduler.runNow(sch.id);
    expect(silenced).toBe(true);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      { type: 'fired', scheduleId: sch.id, runId, silent: true },
      { type: 'session-bound', scheduleId: sch.id, runId, sessionId: 'sess-silent' },
      { type: 'silenced', scheduleId: sch.id, runId, sessionId: 'sess-silent' },
      { type: 'completed', scheduleId: sch.id, runId, sessionId: 'sess-silent', silenced: true },
    ]);
  });

  it('notifyRun restores notification for a silentWhenIdle run', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-notify');
        ctx.onTurnActive?.('sess-notify');
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        expect(h.scheduler.notifyRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(false);
        return { sessionId: 'sess-notify' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    const events: unknown[] = [];
    h.scheduler.on('notified', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    const { runId, silenced } = await h.scheduler.runNow(sch.id);
    expect(silenced).not.toBe(true);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBeUndefined();
    expect(events).toEqual([
      { type: 'notified', scheduleId: sch.id, runId, sessionId: 'sess-notify' },
      { type: 'completed', scheduleId: sch.id, runId, sessionId: 'sess-notify' },
    ]);
  });

  it('failed run ignores silence mark (fail-safe: 异常保持未读)', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        throw new Error('agent exploded after silencing');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].readAt).toBeUndefined();
    // 失败路径同样清理标记
    expect(h.scheduler.isRunSilenced(runs[0].id)).toBe(false);
  });

  it('silenceRun 只静默指定 run,不误伤同 schedule 的其它并发 run', async () => {
    // 两条 run 并发在跑:只静默第一条,第二条照常通知(线程 3 的回归)
    const gates: Array<() => void> = [];
    h = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise((resolve) => {
          // 第一条 run 静默自己,第二条不静默;都挂起等闸门放行
          ctx.onTurnActive?.(`sess-${ctx.runId}`);
          if (gates.length === 0) expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
          gates.push(() => resolve({ sessionId: `sess-${ctx.runId}` }));
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: false });
    const p1 = h.scheduler.runNow(sch.id);
    const p2 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates.forEach((g) => g());
    const [r1, r2] = await Promise.all([p1, p2]);
    const runs = await h.scheduler.listRuns(sch.id);
    const run1 = runs.find((r) => r.id === r1.runId)!;
    const run2 = runs.find((r) => r.id === r2.runId)!;
    expect(run1.readAt).toBe(run1.finishedAt); // 静默 → 已读
    expect(run2.readAt).toBeUndefined(); // 未静默 → 保持未读,会通知
  });

  it('silenceRun 对不存在 / 已结束的 runId 返回 false', () => {
    expect(h.scheduler.silenceRun('no-such-run')).toBe(false);
  });

  it('silenceRun 显式 runId 路径不依赖 active turn 映射', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-no-active-turn');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-no-active-turn' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: false });
    const events: unknown[] = [];
    h.scheduler.on('silenced', (e) => events.push(e));
    const result = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      {
        type: 'silenced',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-no-active-turn',
      },
    ]);
  });

  it('silenceRun 早于 onSessionBound 时在 session 绑定后广播静默事件', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        await ctx.onSessionBound?.('sess-late-bound');
        return { sessionId: 'sess-late-bound' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const events: unknown[] = [];
    h.scheduler.on('session-bound', (e) => events.push(e));
    h.scheduler.on('silenced', (e) => events.push(e));
    const result = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      {
        type: 'session-bound',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-late-bound',
      },
      {
        type: 'silenced',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-late-bound',
      },
    ]);
  });

  // ---------- 按 session 解析 in-flight run(resolveInflightRunForSession)----------

  it('resolveInflightRunForSession 返回本会话 in-flight runId,run 结束后清空', async () => {
    let gate: (() => void) | undefined;
    let boundRunId: string | undefined;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        boundRunId = ctx.runId;
        // 反向映射在 turn 被接受时写(onTurnActive),不在 onSessionBound(send 前)
        ctx.onTurnActive?.('sess-A');
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-A' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    // in-flight 期间:按 sessionId 反查到本轮 runId
    expect(h.scheduler.resolveInflightRunForSession('sess-A')).toBe(boundRunId);
    gate!();
    await p;
    // 结束后清空,不泄漏
    expect(h.scheduler.resolveInflightRunForSession('sess-A')).toBeUndefined();
  });

  it('按 session 静默:resolve → silenceRun 让本轮落地已读(MCP 工具路径,不靠 agent 传 runId)', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-S');
        // 模拟 MCP 工具:不读 ctx.runId,纯按 sessionId 反查并静默
        const rid = h.scheduler.resolveInflightRunForSession('sess-S');
        expect(rid).toBe(ctx.runId);
        expect(h.scheduler.silenceRun(rid!)).toBe(true);
        return { sessionId: 'sess-S' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('success');
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
  });

  it('同 session 两轮都被接受:映射覆盖为最新 runId,先结束的清理不误删新映射', async () => {
    const gates: Array<() => void> = [];
    const runIds: string[] = [];
    h = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise((resolve) => {
          runIds.push(ctx.runId);
          ctx.onTurnActive?.('sess-D');
          gates.push(() => resolve({ sessionId: 'sess-D' }));
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p1 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const p2 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    // 第二轮覆盖:resolve 返回最新 runId
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBe(runIds[1]);
    // 先放行先绑定的第一轮 —— 其 cleanup 不能误删指向第二轮的映射
    gates[0]();
    await p1;
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBe(runIds[1]);
    gates[1]();
    await p2;
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBeUndefined();
  });

  it('同 session 重叠:被拒 run(只 onSessionBound 未 onTurnActive)不污染活跃 run 映射(codex P2)', async () => {
    // 复刻 review 场景:run A 已被接受并执行中(onTurnActive 落映射);run B 撞同
    // session,send 被 SESSION_RUNNING 拒 —— B 只走到 onSessionBound(send 前),never
    // onTurnActive,随后抛错失败。断言:A 的映射不被 B 覆盖/带走,A 仍能解析到自己。
    let releaseA: (() => void) | undefined;
    let runIdA: string | undefined;
    let n = 0;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        n += 1;
        if (n === 1) {
          runIdA = ctx.runId;
          ctx.onTurnActive?.('sess-O'); // A 被接受,落映射
          await new Promise<void>((r) => {
            releaseA = r;
          });
          return { sessionId: 'sess-O' };
        }
        // B:send 被拒 —— 只调 onSessionBound(早于 send),不调 onTurnActive,然后失败
        await ctx.onSessionBound?.('sess-O');
        throw new Error('SESSION_RUNNING: session busy');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const pA = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(runIdA).toBeDefined());
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBe(runIdA);
    // B 触发并失败
    await h.scheduler.runNow(sch.id);
    // A 仍在执行,映射必须还指向 A(没被 B 覆盖、也没被 B 的 cleanup 删掉)
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBe(runIdA);
    releaseA!();
    await pA;
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBeUndefined();
  });

  it('stop() 清空 sessionId→runId 映射', async () => {
    let gate: (() => void) | undefined;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-Z');
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-Z' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    expect(h.scheduler.resolveInflightRunForSession('sess-Z')).toBeDefined();
    await h.scheduler.stop();
    expect(h.scheduler.resolveInflightRunForSession('sess-Z')).toBeUndefined();
    gate!();
    await p;
  });
});

// ── 多实例共库互斥(dev / release 双开)────────────────────────────────────
// 两个 Scheduler 实例共享同一 storage,模拟两个 app 进程共用同一 SQLite。
// 触发互斥靠 fireOne 的 claimDueFire CAS;这里验证同一次到点只会真跑一次。
describe('Scheduler cross-instance dedupe', () => {
  it('两个实例同时 tick 同一到点任务,只有一个真正执行', async () => {
    const storage = new InMemoryStorage();
    const clock = new FakeClock();
    const a = makeHarness({ storage, clock, generateId: (() => { let n = 0; return () => `a-${++n}`; })() });
    const b = makeHarness({ storage, clock, generateId: (() => { let n = 0; return () => `b-${++n}`; })() });
    const sch = await a.scheduler.create({ ...baseInput });
    // 模拟实例 B 冷启动:从共享 DB 加载 actives 进自己的内存
    await b.scheduler.start();
    await b.scheduler.stop(); // 停掉真实 interval;stop 会清内存,重新手动灌入
    const fromDb = await storage.get(sch.id);
    // @ts-expect-error 访问私有 map 仅测试用:模拟 B 内存里已有这条任务
    b.scheduler.activeSchedules.set(sch.id, fromDb!);

    clock.advance(60_000); // 双方都判定到点
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);

    const totalFires = a.fireCalls.length + b.fireCalls.length;
    expect(totalFires).toBe(1);
    // run 记录也只有一条(没有重复触发的双记录)
    const runs = await storage.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
  });

  it('claimDueFire 输掉 CAS 时:不跑 runner、不留 run 记录、不发 fired 事件', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput });
    const firedEvents: unknown[] = [];
    h.scheduler.on('fired', (e) => firedEvents.push(e));
    // 模拟另一进程在本进程 CAS 前一瞬抢先认领
    vi.spyOn(h.storage, 'claimDueFire').mockResolvedValueOnce(null);
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    expect(await h.storage.listRuns(sch.id)).toHaveLength(0);
    expect(firedEvents).toHaveLength(0);
  });

  it('claimDueFire 抛错时:放回内存,下个 tick 重试成功', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput });
    vi.spyOn(h.storage, 'claimDueFire').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    // 第二个 tick:spy 只挡一次,这次 CAS 正常走 → 真跑
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    expect(await h.storage.listRuns(sch.id)).toHaveLength(1);
  });

  it('周期性 DB 同步:另一实例新建/接管的任务,本实例 30s 后能看到并接管触发', async () => {
    const h = makeHarness();
    await h.scheduler.start();
    await h.scheduler.stop(); // 关掉真实 interval,手动 tick
    // stop 清空了内存;直接往共享 storage 写入一条"另一实例创建"的任务
    const now = h.clock.now();
    await h.storage.insert({
      ...baseInput,
      id: 'other-created',
      manual: false,
      persistentSession: false,
      silentWhenIdle: false,
      // CreateScheduleInput.preRunHook / scriptConfig / webhookTrigger 允许 null(JSON 边界),Schedule 只有两态
      preRunHook: undefined,
      preRunPlugin: undefined,
      scriptConfig: undefined,
      webhookTrigger: undefined,
      workspaceKind: 'dialogue',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      nextFireAt: now + 60_000,
    });
    // 越过 DB 同步间隔(30s)+ 到点时刻
    h.clock.advance(61_000);
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    expect(h.fireCalls[0].schedule.id).toBe('other-created');
  });
});

// ── 被动模式(双开时 dev 端让出自动触发)──────────────────────────────────
describe('Scheduler passive mode', () => {
  it('reports passive mode so host triggers can stay out', () => {
    expect(makeHarness({ passive: true }).scheduler.isPassive()).toBe(true);
    expect(makeHarness().scheduler.isPassive()).toBe(false);
  });
  it('start() 不清僵尸、不加载 actives、不装时钟;runNow 照常可用', async () => {
    const storage = new InMemoryStorage();
    const h = makeHarness({ storage, passive: true });
    const markSpy = vi.spyOn(storage, 'markRunningAsInterrupted');
    const listActiveSpy = vi.spyOn(storage, 'listActive');
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.start();
    expect(markSpy).not.toHaveBeenCalled();
    expect(listActiveSpy).not.toHaveBeenCalled();
    // 手动触发不受被动模式影响
    await h.scheduler.runNow(sch.id);
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    await h.scheduler.stop();
  });
});

describe('Scheduler preRunHook results', () => {
  it('前置检查结果落库暂时失败时不覆盖 skip 判定', async () => {
    const logger: Logger = { warn: vi.fn() };
    const preRunHookResult: NonNullable<ScheduleRun['preRunHookResult']> = {
      status: 'skipped',
      decision: 'skip',
      exitCode: 2,
      durationMs: 6,
      stdout: 'no work',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    };
    const h = makeHarness({
      logger,
      runnerImpl: async (_schedule, ctx) => {
        await ctx.onPreRunHookCompleted?.(preRunHookResult);
        return { sessionId: '', skipped: true, resultText: 'exit 2: no work' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    vi.spyOn(h.storage, 'updateRun').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const failedEvents: unknown[] = [];
    h.scheduler.on('failed', (event) => failedEvents.push(event));

    const { runId } = await h.scheduler.runNow(sch.id);
    const run = (await h.scheduler.listRuns(sch.id)).find((item) => item.id === runId);

    expect(run?.status).toBe('skipped');
    expect(run?.readAt).toBeDefined();
    expect(run?.preRunHookResult).toBeUndefined();
    expect(failedEvents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('persist pre-run hook result failed', {
      runId,
      error: 'SQLITE_BUSY',
    });
  });

  it('runNow fail-closed:检查结果在无 session 时仍落库，run 记 failed 且未读', async () => {
    const preRunHookResult: NonNullable<ScheduleRun['preRunHookResult']> = {
      status: 'failed',
      decision: 'block',
      exitCode: 1,
      durationMs: 6,
      stdout: '',
      stderr: 'syntax error',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    };
    const h = makeHarness({
      runnerImpl: async (_schedule, ctx) => {
        await ctx.onPreRunHookCompleted?.(preRunHookResult);
        throw new Error('pre-run hook failed with exit code 1');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });

    const { runId } = await h.scheduler.runNow(sch.id);
    const run = (await h.scheduler.listRuns(sch.id)).find((item) => item.id === runId);

    expect(run?.status).toBe('failed');
    expect(run?.sessionId).toBeUndefined();
    expect(run?.readAt).toBeUndefined();
    expect(run?.preRunHookResult).toEqual(preRunHookResult);
  });

  it('cron fire skipped: run 保留为 skipped(生而已读)、照常重排、发 skipped 事件', async () => {
    const h = makeHarness({
      runnerImpl: async () => ({
        sessionId: '',
        skipped: true,
        resultText: 'exit 2: no new PRs',
      }),
    });
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'node check.mjs' },
    });
    const skippedEvents: Array<{ scheduleId: string; runId: string; sessionId: string }> = [];
    const completedEvents: unknown[] = [];
    const failedEvents: unknown[] = [];
    h.scheduler.on('skipped', (e) => skippedEvents.push(e));
    h.scheduler.on('completed', (e) => completedEvents.push(e));
    h.scheduler.on('failed', (e) => failedEvents.push(e));

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    // 生而已读:不产生未读红点
    expect(runs[0].readAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));
    expect(runs[0].resultText).toBe('exit 2: no new PRs');
    expect(runs[0].sessionId).toBeUndefined();

    // 与 deferred 不同:照常按 cron 重排下一槽位,不是短延重试
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));

    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].sessionId).toBe('');
    expect(completedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(0);
  });

  it('runNow skipped: run 保留为 skipped,nextFireAt 不被打乱', async () => {
    const h = makeHarness({
      runnerImpl: async () => ({ sessionId: '', skipped: true }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const before = await h.storage.get(sch.id);
    const skippedEvents: Array<{ sessionId: string }> = [];
    h.scheduler.on('skipped', (e) => skippedEvents.push(e));

    const { runId } = await h.scheduler.runNow(sch.id);

    const run = (await h.scheduler.listRuns(sch.id)).find((r) => r.id === runId);
    expect(run?.status).toBe('skipped');
    expect(run?.readAt).toBeDefined();
    expect(run?.sessionId).toBeUndefined(); // 空串 sessionId 不落库
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].sessionId).toBe('');
    // runNow 不动 cron 排期(与 success 路径一致)
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(before?.nextFireAt);
  });

  // #8351, unit: real tick/persistence/runNow. Existing once-skip coverage did
  // not assert the retained reason, zero cost, or recovery after expiry.
  it('one-shot undispatched skip retains its reason and permits manual recovery after expiry', async () => {
    const reason = '[QUEUE_WAIT_TIMEOUT] queued heartbeat was not dispatched within 30min';
    let recovered = false;
    const h = makeHarness({
      runnerImpl: async () => recovered
        ? { sessionId: 'bound-session', resultText: 'Recovered prompt' }
        : { sessionId: 'bound-session', skipped: true, resultText: reason },
    });
    const sch = await h.scheduler.create({ ...baseInput, recurring: false, targetSessionId: 'bound-session' });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('expired');
    expect(after?.nextFireAt).toBeUndefined();
    expect(await h.scheduler.listRuns(sch.id)).toMatchObject([{
      status: 'skipped', resultText: reason, sessionId: 'bound-session',
      costAttribution: 'zero', readAt: h.clock.now(),
    }]);
    expect((await h.scheduler.listRuns(sch.id))[0]?.errorMsg).toBeUndefined();
    // Expiry consumes the automatic fire, but the existing Run now remains usable.
    recovered = true;
    h.clock.advance(60_000);
    await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(2);
    expect(runs.find(run => run.status === 'success')?.resultText).toBe('Recovered prompt');
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
  });

  it.each([
    { recurring: true, manual: false, intervalMs: undefined },
    { recurring: true, manual: false, intervalMs: 600_000 },
    { recurring: false, manual: false, intervalMs: undefined },
    { recurring: false, manual: true, intervalMs: undefined },
  ])('settles an undispatched Stop without losing normal scheduling: %j', async (timing) => {
    const h = makeHarness({
      runnerImpl: async () => ({
        sessionId: 'stopped-session',
        skipped: true,
        resultText: 'Scheduled turn stopped before vendor dispatch',
      }),
    });
    const sch = await h.scheduler.create({ ...baseInput, ...timing });
    const firedAt = sch.nextFireAt ?? h.clock.now();
    h.clock.setTo(firedAt);
    if (timing.manual) await h.scheduler.runNow(sch.id);
    else await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'skipped', sessionId: 'stopped-session', readAt: firedAt });
    const after = await h.storage.get(sch.id);
    if (timing.recurring) {
      expect(after?.status).toBe('active');
      expect(after?.nextFireAt).toBe(firedAt + (timing.intervalMs ?? 60_000));
      h.clock.setTo(after!.nextFireAt!);
      await h.scheduler.tick();
      expect(await h.scheduler.listRuns(sch.id)).toHaveLength(2);
    } else {
      expect(after?.nextFireAt).toBeUndefined();
      if (!timing.manual) expect(after?.status).toBe('expired');
    }
  });

  it('create() 透传 preRunHook 配置', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'python check.py', timeoutMs: 5000 },
    });
    expect(sch.preRunHook).toEqual({ command: 'python check.py', timeoutMs: 5000 });
    // 未配置的任务字段为 undefined,零行为变化
    const plain = await h.scheduler.create({ ...baseInput });
    expect(plain.preRunHook).toBeUndefined();
  });
});

// ── 心跳租约与僵尸 run 清理(多实例共库安全)──────────────────────────────
// 回归背景:markRunningAsInterrupted 曾无条件把所有 'running' 行标 interrupted,
// 双开时一个实例启动会误杀另一个活实例正在执行的 run(对方静默完成后,本实例
// UI 留下永远消不掉的假失败红点 + errorMsg 残留)。现在只回收心跳过期的行。
describe('Scheduler run heartbeat lease & zombie sweep', () => {
  function insertRunningRun(
    storage: InMemoryStorage,
    id: string,
    scheduleId: string,
    firedAt: number,
    heartbeatAt?: number,
  ): void {
    storage.runs.set(id, {
      id,
      scheduleId,
      firedAt,
      status: 'running',
      ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
    });
  }

  it('start() 只清心跳过期的僵尸;另一活实例心跳新鲜的 in-flight run 不动', async () => {
    const storage = new InMemoryStorage();
    const clock = new FakeClock();
    const a = makeHarness({ storage, clock });
    const sch = await a.scheduler.create({ ...baseInput, manual: true });
    const now = clock.now();
    // 对方活实例正在跑(心跳刚续过)
    insertRunningRun(storage, 'run-alive', sch.id, now - 300_000, now - 5_000);
    // 真僵尸:心跳停在过期窗口之外
    insertRunningRun(storage, 'run-dead', sch.id, now - 300_000, now - RUN_HEARTBEAT_STALE_MS - 1_000);
    // 老版本写入的行(无心跳字段):按 firedAt 兜底,同样过期
    insertRunningRun(storage, 'run-legacy', sch.id, now - RUN_HEARTBEAT_STALE_MS - 1_000);

    const b = makeHarness({ storage, clock });
    await b.scheduler.start();
    expect(storage.runs.get('run-alive')?.status).toBe('running');
    expect(storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(storage.runs.get('run-dead')?.errorMsg).toBe('app restarted');
    expect(storage.runs.get('run-legacy')?.status).toBe('interrupted');
    await b.scheduler.stop();
  });

  it('运行期清扫:暖场窗口后把心跳过期的行改写 interrupted 并广播 changed', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const changedIds: string[] = [];
    h.scheduler.on('changed', (e: { scheduleId: string }) => changedIds.push(e.scheduleId));
    // 启动后才出现的僵尸(另一实例此刻崩溃):心跳停在 start 时刻
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    // 老版本实例正在跑的 run(无心跳字段):它活着也不会续心跳,60s 心跳窗口内
    // 绝不能按 firedAt 秒杀 —— NULL 行走独立的 RUN_LEGACY_STALE_MS 宽窗口。
    insertRunningRun(h.storage, 'run-old-version', sch.id, h.clock.now());
    // 以 ≤SUSPEND_GAP 的步长推进(模拟正常连续 tick,不触发挂起宽限):
    // 暖场窗口(start + RUN_HEARTBEAT_STALE_MS)内清扫不动手 ——
    h.clock.advance(25_000);
    await h.scheduler.tick();
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // —— 过了暖场窗口且心跳过期后,清扫在下一个 DB-sync 周期(清扫挂在它上面,
    // 30s 一轮)改写并广播
    h.clock.advance(25_000);
    await h.scheduler.tick();
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-old-version')?.status).toBe('running');
    expect(changedIds).toContain(sch.id);
    await h.scheduler.stop();
  });

  it('运行期清扫排除本进程 in-flight run(自家心跳停摆也不自伤)', async () => {
    let gate: (() => void) | undefined;
    const h = makeHarness({
      runnerImpl: async () => {
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-long' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    // 真实心跳定时器在 fake clock 下永不触发 → heartbeatAt 停在 firedAt,
    // 从 DB 视角看已"过期";但它在本进程 inflight 名单里,清扫必须放过。
    for (let i = 0; i < 5; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    const runs = await h.storage.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    gate!();
    await p;
    expect((await h.storage.listRuns(sch.id))[0].status).toBe('success');
    await h.scheduler.stop();
  });

  it('挂起唤醒(tick 大缺口)后清扫延迟一个完整过期窗口再恢复', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    // 一次性跳 10 分钟模拟系统睡眠:同机所有实例的心跳都停在睡前,
    // 唤醒后的第一波 tick 不许清扫(对方可能马上续心跳)。
    h.clock.advance(600_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // 宽限窗口内继续小步 tick 仍不动手
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // 宽限过后(且撞上下一个 DB-sync 周期)恢复清扫
    for (let i = 0; i < 3; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    await h.scheduler.stop();
  });

  it('in-flight 期间周期续心跳;结束后定时器停止', async () => {
    vi.useFakeTimers();
    try {
      let gate: (() => void) | undefined;
      const h = makeHarness({
        runnerImpl: async () => {
          await new Promise<void>((r) => {
            gate = r;
          });
          return { sessionId: 'sess-hb' };
        },
      });
      const touchSpy = vi.spyOn(h.storage, 'touchRunHeartbeats');
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      const p = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(gate).toBeDefined());
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      const firedAt = (await h.storage.listRuns(sch.id))[0].firedAt;
      // 初始 run 落库即带心跳(= firedAt),不给"插入后第一拍前"留过期空窗
      expect(h.storage.runs.get(runId)?.heartbeatAt).toBe(firedAt);
      // 推进一个心跳周期:touch 落到 storage,时间戳取引擎时钟
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(touchSpy).toHaveBeenCalledWith([runId], h.clock.now());
      expect(h.storage.runs.get(runId)?.heartbeatAt).toBe(h.clock.now());
      // run 结束 → inflight 清空 → 定时器停止,不再 touch
      gate!();
      await p;
      const callsAfterDone = touchSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 3);
      expect(touchSpy.mock.calls.length).toBe(callsAfterDone);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 清扫善后:恢复崩溃认领悬置的排期(codex review P1)────────────────────
  // claimDueFire 认领会把 nextFireAt 置空,认领方崩溃后没有 fireOne 收口重排;
  // 只标 run 不补排的话,幸存实例的 DB 同步会一直重灌回"active 但无排期"的
  // schedule,任务无声停摆直到某个实例重启。
  async function advancePastSweep(h: Harness): Promise<void> {
    // 25s × 4 步:跨过暖场窗口(start + 60s)并命中 DB-sync 周期(30s,清扫挂其上),
    // 步长 ≤ SUSPEND_GAP 不触发挂起宽限。
    for (let i = 0; i < 4; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
  }

  it('清扫崩溃认领的僵尸后,按 start() 归一语义恢复 nextFireAt', async () => {
    const h = makeHarness();
    // interval 1h:测试窗口内不会自然触发,专注清扫路径
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    // 模拟另一实例认领后崩溃:nextFireAt 被置空 + 留下心跳过期的 running 行
    await h.storage.update(sch.id, { nextFireAt: undefined });
    insertRunningRun(h.storage, 'run-claimed-dead', sch.id, h.clock.now(), h.clock.now());
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-claimed-dead')?.status).toBe('interrupted');
    // 排期已恢复:interval 语义 = base(createdAt,没跑完过) + intervalMs
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(sch.createdAt + 3_600_000);
    await h.scheduler.stop();
  });

  it('清扫后该 schedule 仍有 running 行(另一活实例在执行)→ 不抢排', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    await h.storage.update(sch.id, { nextFireAt: undefined });
    // 心跳过期的僵尸 + 心跳新鲜的活 run 并存(如 runNow 僵尸 + 认领执行中)
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    insertRunningRun(h.storage, 'run-live', sch.id, h.clock.now(), h.clock.now() + 90_000);
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-live')?.status).toBe('running');
    // 执行方 fireOne 收口时会按 recurring 语义重排,这里不抢
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    await h.scheduler.stop();
  });

  it('老版本 NULL 心跳残留:60s 窗口内放过,超过 RUN_LEGACY_STALE_MS 后运行期收掉', async () => {
    // 回归(codex review P2):NULL 行曾被运行期清扫一刀切跳过 —— 启动时未过期的
    // 老版本崩溃残留(如老 app 崩溃后 60s 内新版本就启动)将永远无人收,running
    // 行永久卡死,auto-relaunch busy probe 一直看到"忙"。现在 NULL 行按 firedAt
    // 走独立的 2h 宽窗口:短期内不误杀跨版本活 run,真僵尸有界回收。
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const bornAt = h.clock.now();
    insertRunningRun(h.storage, 'run-legacy-zombie', sch.id, bornAt);
    // 心跳窗口(60s)过后仍在宽限内:不收
    for (let i = 0; i < 4; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-legacy-zombie')?.status).toBe('running');
    // 跨过 RUN_LEGACY_STALE_MS(以 ≤SUSPEND_GAP 步长推进避免挂起宽限;步进本身
    // 远超 2h,末段小步 tick 让 DB-sync 周期命中清扫)
    const target = bornAt + RUN_LEGACY_STALE_MS + 120_000;
    while (h.clock.now() < target) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-legacy-zombie')?.status).toBe('interrupted');
    await h.scheduler.stop();
  });

  it('活 run 被 10+ 条更新的终态行挤出 listRuns 窗口时,守卫仍能看见它、不误补排', async () => {
    // 回归(codex review P2):守卫曾用 listRuns(scheduleId, 10) 查活 run,长跑的
    // claim run 之后又落了 10+ 条 runNow/终态行时会被挤出窗口 → 漏判 → 误补排 →
    // due 循环在原认领仍在执行时再开一轮。现在必须走无上限的 hasRunningRuns。
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    await h.storage.update(sch.id, { nextFireAt: undefined });
    const t0 = h.clock.now();
    // 长跑中的活 claim run(心跳新鲜),firedAt 最老
    insertRunningRun(h.storage, 'run-live-old', sch.id, t0 - 600_000, t0 + 90_000);
    // 其后落库的 12 条终态行,把活 run 挤出 listRuns(…, 10) 的窗口
    for (let i = 0; i < 12; i++) {
      h.storage.runs.set(`run-done-${i}`, {
        id: `run-done-${i}`,
        scheduleId: sch.id,
        firedAt: t0 - 500_000 + i * 1_000,
        finishedAt: t0 - 499_000 + i * 1_000,
        status: 'success',
      });
    }
    // 心跳过期的僵尸,触发清扫善后
    insertRunningRun(h.storage, 'run-dead', sch.id, t0, t0);
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-live-old')?.status).toBe('running');
    // 活 run 仍在 → 绝不能补排
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    await h.scheduler.stop();
  });

  it('清扫 runNow 僵尸(排期未被认领置空)→ nextFireAt 原样不动', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    const plannedNext = (await h.storage.get(sch.id))?.nextFireAt;
    expect(plannedNext).toBeDefined();
    insertRunningRun(h.storage, 'run-manual-dead', sch.id, h.clock.now(), h.clock.now());
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-manual-dead')?.status).toBe('interrupted');
    expect((await h.storage.get(sch.id))?.nextFireAt).toBe(plannedNext);
    await h.scheduler.stop();
  });
});

describe('Scheduler concurrency gate(并发闸门)', () => {
  /** runner.fire 挂起直到测试手动 resolve —— 模拟长跑 run 占用槽位。 */
  function makePendingRunner(): {
    impl: (s: Schedule, ctx: FireContext) => Promise<FireResult>;
    resolveNext: () => void;
    pendingCount: () => number;
  } {
    const pending: Array<() => void> = [];
    return {
      impl: (s: Schedule) =>
        new Promise<FireResult>((resolve) => {
          pending.push(() => resolve({ sessionId: `sess-${s.id}` }));
        }),
      resolveNext: () => {
        const r = pending.shift();
        if (r) r();
      },
      pendingCount: () => pending.length,
    };
  }

  it('in-flight 达上限时 tick 扣住到点任务;槽位释放后按等待最久优先接力', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ maxConcurrentRuns: 1, runnerImpl: runnerCtl.impl });
    // A 先到点(00:01:00),B 后到点(00:02:00)
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 10));
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });
    expect(a.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(b.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));

    // 两个都到点,cap=1 → 只放行等得最久的 A
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 2, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.fireCalls[0].schedule.id).toBe(a.id);

    // A 还在跑 → 后续 tick 不放行 B(B 留在队列,不丢)
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);

    // A 跑完释放槽位 → 下个 tick 接力放行 B
    runnerCtl.resolveNext();
    await tick1;
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));
    expect(h.fireCalls[1].schedule.id).toBe(b.id);
    runnerCtl.resolveNext();
    await tick2;
  });

  it('未配置时默认上限 DEFAULT_MAX_CONCURRENT_RUNS,同 tick 只放行上限数量', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ runnerImpl: runnerCtl.impl });
    const total = DEFAULT_MAX_CONCURRENT_RUNS + 2;
    for (let i = 0; i < total; i++) {
      await h.scheduler.create({ ...baseInput, name: `S${i}` });
    }
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() =>
      expect(h.runner.fire).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_RUNS),
    );
    // 再 tick 也不超发
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_RUNS);
    // 首批跑完释放槽位 → 下个 tick 放行剩余 2 个
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_RUNS; i++) runnerCtl.resolveNext();
    await tick1;
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(total));
    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await tick2;
  });

  it('runNow 不受闸门拦截(用户显式动作),但计入 in-flight 占用', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ maxConcurrentRuns: 1, runnerImpl: runnerCtl.impl });
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });

    // A 经 tick 占满唯一槽位
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.fireCalls[0].schedule.id).toBe(a.id);

    // 槽位已满,runNow(B) 仍然立即执行
    const runNowP = h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));
    expect(h.fireCalls[1].schedule.id).toBe(b.id);

    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await tick1;
    await runNowP;

    // 锁定既有语义:手动 runNow **不消耗** cron 槽位(runNow 注释:「nextFireAt
    // 不动 —— 手动触发不应改变下一次按 cron 排定的时间」)。B 排队期间被手动跑过,
    // 槽位释放后下个 tick 仍按计划把 B 的这次到点触发补上 —— 闸门只延后计划触发,
    // 不改变「手动与计划相互独立」的语义。
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(3));
    expect(h.fireCalls[2].schedule.id).toBe(b.id);
    runnerCtl.resolveNext();
    await tick2;
  });

  it('runtime snapshot 精确列出 in-flight 来源和真实排队任务', async () => {
    const runnerCtl = makePendingRunner();
    const runtimeEvents: unknown[] = [];
    const info = vi.fn();
    const h = makeHarness({
      maxConcurrentRuns: 1,
      runnerImpl: runnerCtl.impl,
      logger: { info },
    });
    h.scheduler.on('runtime-state', (event) => runtimeEvents.push(event.snapshot));
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({
      ...baseInput,
      name: 'B',
      executionMode: 'script',
      workspaceKind: 'project',
      workingDir: '/repo',
      scriptConfig: { command: 'node task.mjs', capabilities: [] },
    });

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));

    const snapshot = h.scheduler.getRuntimeSnapshot();
    expect(snapshot).toMatchObject({
      schedulerInstanceId: 'test-scheduler',
      processId: 1234,
      inFlight: 1,
      maxConcurrentRuns: 1,
    });
    expect(snapshot.inFlightRuns).toEqual([
      expect.objectContaining({
        scheduleId: a.id,
        scheduleName: 'A',
        source: 'automatic',
        executionMode: 'agent',
        slotWaitMs: 5_000,
        phase: 'running',
      }),
    ]);
    expect(snapshot.waitingSchedules).toEqual([
      { scheduleId: b.id, scheduleName: 'B', waitingSince: b.nextFireAt },
    ]);
    expect(info).toHaveBeenCalledWith(
      'scheduler: concurrency gate holding due fires',
      expect.objectContaining({
        schedulerInstanceId: 'test-scheduler',
        processId: 1234,
        inFlightRuns: [
          expect.objectContaining({ scheduleId: a.id, source: 'automatic', phase: 'claiming' }),
        ],
        gatedSchedules: [expect.objectContaining({ scheduleId: b.id, scheduleName: 'B' })],
      }),
    );
    expect(runtimeEvents.length).toBeGreaterThan(0);

    runnerCtl.resolveNext();
    await tick;
  });

  it('runNow 合法超额时标明来源，完成终态仍配对释放', async () => {
    const info = vi.fn();
    const runnerCtl = makePendingRunner();
    const h = makeHarness({
      maxConcurrentRuns: 1,
      runnerImpl: runnerCtl.impl,
      logger: { info },
    });
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const automatic = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    const manual = h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));

    expect(h.scheduler.getRuntimeSnapshot().inFlightRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scheduleId: a.id, source: 'automatic' }),
        expect.objectContaining({ scheduleId: b.id, source: 'run-now' }),
      ]),
    );
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(2);

    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await automatic;
    await manual;
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run registered')).toHaveLength(2);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run released')).toHaveLength(2);
  });

  it('stop 立即清空结构化占用，迟到 finally 不会把计数减成负数', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ runnerImpl: runnerCtl.impl });
    const schedule = await h.scheduler.create({ ...baseInput });
    const run = h.scheduler.runNow(schedule.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(1);

    await h.scheduler.stop();
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    runnerCtl.resolveNext();
    await run;
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
  });

  it('runner 抛错时也释放结构化占用', async () => {
    const info = vi.fn();
    const h = makeHarness({
      runnerImpl: async () => {
        throw new Error('runner exploded');
      },
      logger: { info },
    });
    const schedule = await h.scheduler.create({ ...baseInput });

    await expect(h.scheduler.runNow(schedule.id)).resolves.toEqual({ runId: expect.any(String) });
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run registered')).toHaveLength(1);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run released')).toHaveLength(1);
  });
});

// ── 纯等待不占槽 + 卡死守卫 ───────────────────────────────────────────────
// 2026-07-29 事故:4 个心跳 run 排在忙会话的队列里等派发,各挂 3.5 小时,占满全部
// 执行槽,其余任务全部停摆。两道修复:① 'queued' 的纯等待项不计入并发闸门;
// ② 占槽的 run 连续无进展就 abort,abort 不生效则强制收回槽位。
describe('Scheduler: 排队不占槽与卡死守卫', () => {
  it("排队中的 run 不占并发槽,闸门照常放行新触发", async () => {
    const queued: FireContext[] = [];
    const h = makeHarness({
      maxConcurrentRuns: 2,
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>(() => {
          // 进入纯等待后永不 settle —— 模拟目标会话长时间不空闲。
          ctx.onQueueWaitStart?.();
          queued.push(ctx);
        }),
    });
    // 上限 2:先让两条任务进入排队等待
    const a = await h.scheduler.create({ ...baseInput, manual: true });
    const b = await h.scheduler.create({ ...baseInput, manual: true });
    void h.scheduler.runNow(a.id);
    void h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(queued).toHaveLength(2));

    const snap = h.scheduler.getRuntimeSnapshot();
    expect(snap.inFlight).toBe(2); // 两条 in-flight 记录仍在
    expect(snap.slotsInUse).toBe(0); // 但都不占槽
    expect(snap.inFlightRuns.every((r) => r.phase === 'queued')).toBe(true);

    // 闸门此刻应视作"零占用":两个到点的自动任务都能放行。
    const c = await h.scheduler.create({ ...baseInput });
    const d = await h.scheduler.create({ ...baseInput });
    h.clock.advance(60_000);
    void h.scheduler.tick();
    await vi.waitFor(() => expect(queued).toHaveLength(4));
    expect(h.fireCalls.map((call) => call.schedule.id)).toContain(c.id);
    expect(h.fireCalls.map((call) => call.schedule.id)).toContain(d.id);
    await h.scheduler.stop();
  });

  it('离开排队等待后重新占槽(不过闸门、不阻塞)', async () => {
    let ctxRef: FireContext | undefined;
    const h = makeHarness({
      maxConcurrentRuns: 1,
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>(() => {
          ctx.onQueueWaitStart?.();
          ctxRef = ctx;
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    void h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(ctxRef).toBeDefined());
    expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);

    // 派发被接受 → 要回槽位（有空槽，必然成功）
    expect(ctxRef!.endQueueWait?.(true)).toBe(true);
    const snap = h.scheduler.getRuntimeSnapshot();
    expect(snap.slotsInUse).toBe(1);
    expect(snap.inFlightRuns[0]?.phase).toBe('running');
    await h.scheduler.stop();
  });

  it('全部 in-flight 都在排队时,心跳仍然续期(否则被僵尸清扫误标 interrupted)', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.onQueueWaitStart?.();
          }),
      });
      const touchSpy = vi.spyOn(h.storage, 'touchRunHeartbeats');
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() =>
        expect(h.scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('queued'),
      );
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(touchSpy).toHaveBeenCalledWith([runId], h.clock.now());
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('无进展超阈值 → abort;宽限内仍不 settle → 强制收回槽位、run 记 failed、重排下次触发', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const error = vi.fn();
      let sawAbort = false;
      const h = makeHarness({
        // interval 模式:重排结果可预期(finishedAt + intervalMs)
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        logger: { warn, error },
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
            });
          }),
      });
      // 走自动触发路径（不是 runNow）：只有它会经 claimDueFire 清空 nextFireAt，
      // 也只有它需要守卫补排 —— manual 任务按语义本就不该被续命。
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      // 认领已把 nextFireAt 清空 —— 不补排的话这条任务会永久停摆
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();

      // 跨过无进展阈值 → 心跳 loop 上的守卫发出 abort
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(sawAbort).toBe(true);
      // 仍未 settle,但槽位还在(宽限期内)
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);

      // 跨过宽限 → 强制收回
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
      const run = h.storage.runs.get(runId);
      expect(run?.status).toBe('failed');
      expect(run?.errorMsg).toMatch(/stalled/);
      // 重排:claimDueFire 清空过 nextFireAt,守卫必须补排,否则任务永久停摆
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined();
      expect(error).toHaveBeenCalledWith(
        'scheduler: force-releasing stalled run slot (runner never settled)',
        expect.anything(),
      );
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('有进展信号时不触发卡死守卫(判无反馈而非总时长)', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      let ctxRef: FireContext | undefined;
      const h = makeHarness({
        runStallMs: 60_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctxRef = ctx;
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
            });
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(ctxRef).toBeDefined());
      // 总时长远超阈值,但每个心跳周期都有进展 → 不该被判卡死
      for (let i = 0; i < 6; i++) {
        h.clock.advance(30_000);
        ctxRef!.onProgress?.();
        await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      }
      expect(sawAbort).toBe(false);
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('排队中的 run 不被卡死守卫判定(等忙会话是正常状态)', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const h = makeHarness({
        runStallMs: 60_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
            });
            ctx.onQueueWaitStart?.();
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() =>
        expect(h.scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('queued'),
      );
      h.clock.advance(600_000);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
      expect(sawAbort).toBe(false);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口后迟到的 settle 不覆写已呈现的 failed', async () => {
    vi.useFakeTimers();
    try {
      let release: ((r: FireResult) => void) | undefined;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () =>
          new Promise<FireResult>((resolve) => {
            release = resolve;
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      const p = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(release).toBeDefined());
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).toBe('failed'));
      const finishedAt = h.storage.runs.get(runId)?.finishedAt;

      // runner 几小时后才 settle:不得把 failed 改回 success
      release!({ sessionId: 'sess-late' });
      await p;
      const run = h.storage.runs.get(runId);
      expect(run?.status).toBe('failed');
      expect(run?.finishedAt).toBe(finishedAt);
      expect(run?.sessionId).toBeUndefined();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── review #944 抓到的回归 ────────────────────────────────────────────────
  it('守卫 abort 被 runner 响应时:记 failed(不是 aborted)且照常重排 nextFireAt', async () => {
    // 这是最严重的一条:守卫「正常工作」(runner 老实响应 abort)时,原实现把它当成
    // 用户 pause/delete —— 记 aborted 且跳过重排,而 claimDueFire 已清空 nextFireAt,
    // recurring 任务就此永久停摆,比不加守卫更糟。
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>((_resolve, reject) => {
            // 老实响应 abort:抛 AbortError（真实 runner 的约定行为）
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted by signal'));
            });
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();

      // 跨过无进展阈值 → 守卫 abort → runner 立刻响应并 settle
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).not.toBe('running'));

      const run = h.storage.runs.get(runId);
      expect(run?.status).toBe('failed'); // 不是 aborted —— 卡死是异常,必须可见
      expect(run?.errorMsg).toMatch(/stall guard/);
      // 关键断言:schedule 排期必须被恢复,否则任务永久停摆
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined();
      expect((await h.storage.get(sch.id))?.status).toBe('active');
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户 pause/delete 的 abort 仍记 aborted 且不重排(不被守卫改动波及)', async () => {
    let ctxRef: FireContext | undefined;
    const h = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>((_resolve, reject) => {
          ctxRef = ctx;
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(ctxRef).toBeDefined());
    const runId = (await h.storage.listRuns(sch.id))[0].id;
    await h.scheduler.pause(sch.id);
    await p;
    expect(h.storage.runs.get(runId)?.status).toBe('aborted');
    expect(h.storage.runs.get(runId)?.errorMsg).toMatch(/cancelled by user/);
  });

  it('stop() 之后迟到的 settle 仍不覆写被强制收口的 run', async () => {
    // stop() 曾清空 abandonedRuns,导致这条保护在切账号/退出路径上失效。
    vi.useFakeTimers();
    try {
      let release: ((r: FireResult) => void) | undefined;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () =>
          new Promise<FireResult>((resolve) => {
            release = resolve;
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      const p = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(release).toBeDefined());
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).toBe('failed'));

      await h.scheduler.stop(); // ← 曾在这里丢掉保护
      release!({ sessionId: 'sess-late-after-stop' });
      await p;

      expect(h.storage.runs.get(runId)?.status).toBe('failed');
      expect(h.storage.runs.get(runId)?.sessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口时同 schedule 还有 runNow 在跑,也要恢复排期', async () => {
    // rescheduleAfterSweep 遇到「该 schedule 仍有 running 行」就放弃补排,而 runNow
    // 收口从不重排 —— 两者叠加会让任务永久停摆。
    vi.useFakeTimers();
    try {
      const gates: Array<(r: FireResult) => void> = [];
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () =>
          new Promise<FireResult>((resolve) => {
            gates.push(resolve);
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      // 自动触发占一个槽
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      // 同 schedule 再来一个手动 runNow（它会一直挂着 → hasRunningRuns 恒为 true）
      const manual = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();

      // 让自动那条被守卫强制收口
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      await vi.waitFor(async () =>
        expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined(),
      );
      gates[1]!({ sessionId: 'sess-manual' });
      await manual;
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口经 notifyForcedFailure 出口投通知', async () => {
    vi.useFakeTimers();
    try {
      const notified: Array<{ scheduleId: string; runId: string; errorMsg: string }> = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: { fire: () => new Promise<FireResult>(() => {}) },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0, // 见 makeHarness 同名注释:假时钟跳表 ≠ 系统睡眠
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-notify',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      void scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(notified).toHaveLength(1));
      expect(notified[0]!.scheduleId).toBe(sch.id);
      expect(notified[0]!.errorMsg).toMatch(/stalled/);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态落库失败时不广播 failed(避免 UI 与 DB 分叉)', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () => new Promise<FireResult>(() => {}),
      });
      const failedEvents: unknown[] = [];
      h.scheduler.on('failed', (e) => failedEvents.push(e));
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      // 让终态写入失败
      vi.spyOn(h.storage, 'updateRun').mockRejectedValue(new Error('disk on fire'));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      // 槽位仍然要收回（目的达到），但不得广播一个 DB 里不存在的终态
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect(failedEvents).toHaveLength(0);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('script 模式不参与卡死守卫(静默长跑是它的正常形态)', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const h = makeHarness({
        runStallMs: 60_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
            });
          }),
      });
      const sch = await h.scheduler.create({
        ...baseInput,
        manual: true,
        prompt: '',
        executionMode: 'script',
        workspaceKind: 'project',
        workingDir: '/repo',
        scriptConfig: { command: 'node long-sync.mjs', capabilities: [] },
      });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(24 * 3_600_000);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
      expect(sawAbort).toBe(false);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('排队 run 恢复派发时要不到槽 → endQueueWait(true) 返回 false,峰值严格不超上限', async () => {
    // 排队 run 让出的槽会被 tick 补上新任务。恢复派发时必须重新过闸门:拿不到就由
    // runner 在 vendor dispatch 之前站下(顺延),否则实际并发突破 maxConcurrentRuns。
    const ctxs: FireContext[] = [];
    const h = makeHarness({
      maxConcurrentRuns: 2,
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>(() => {
          ctxs.push(ctx);
        }),
    });
    const a = await h.scheduler.create({ ...baseInput, manual: true });
    const b = await h.scheduler.create({ ...baseInput, manual: true });
    void h.scheduler.runNow(a.id);
    void h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(ctxs).toHaveLength(2));

    // 两条都进纯等待 → 槽位全部让出
    for (const ctx of ctxs) ctx.onQueueWaitStart?.();
    expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);

    // 让出的两个槽被新的自动任务补满
    const c = await h.scheduler.create({ ...baseInput });
    const d = await h.scheduler.create({ ...baseInput });
    h.clock.advance(60_000);
    void h.scheduler.tick();
    await vi.waitFor(() => expect(ctxs).toHaveLength(4));
    expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(2);
    void c;
    void d;

    // 此刻两条排队 run 都要不回槽 —— 必须被拒
    expect(ctxs[0]!.endQueueWait?.(true)).toBe(false);
    expect(ctxs[1]!.endQueueWait?.(true)).toBe(false);
    expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(2); // 没有超发

    // 站下(reclaimSlot=false)只复位记账:转 'cancelling' —— 卡死守卫看得住它,但它
    // 明确不会执行,所以**不占槽**。曾经复位成 'running',于是这里会变成 3/2、UI 上冒出
    // 9/8,也与 endQueueWait 契约里"只复位记账"矛盾(review #944 第十五轮)。
    expect(ctxs[0]!.endQueueWait?.(false)).toBe(true);
    expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(2);
    expect(
      h.scheduler.getRuntimeSnapshot().inFlightRuns.filter((r) => r.phase === 'cancelling'),
    ).toHaveLength(1);
    await h.scheduler.stop();
  });

  it('守卫 abort 被 runner 响应时不重复投通知(runner 自己已投过)', async () => {
    // 判据是 runner 有没有经 onRunnerNotified 上报"我投过失败通知",不是"它有没有
    // 抛错" —— 后者会把"abort 落在通知之前"的那批 run 一并当成已通知(见下一个用例)。
    vi.useFakeTimers();
    try {
      const notified: unknown[] = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: {
          fire: (_s, ctx) =>
            new Promise<FireResult>((_resolve, reject) => {
              // 老实响应守卫 abort:先按自己的 notify 配置投一条失败通知,再 settle
              ctx.signal.addEventListener('abort', () => {
                ctx.onRunnerNotified?.('failure');
                reject(new Error('aborted by signal'));
              });
            }),
        },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0, // 见 makeHarness 同名注释:假时钟跳表 ≠ 系统睡眠
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-no-dup-notify',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      const p = scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await storage.listRuns(sch.id))[0].id;

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await p;

      // run 仍记 failed（可见），但通知出口不被调用（避免与 runner 侧重复）
      expect(storage.runs.get(runId)?.status).toBe('failed');
      expect(notified).toHaveLength(0);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('守卫 abort 落在 runner 投通知之前时补发失败通知', async () => {
    // 守卫的 abort 可能命中前置检查脚本、workspace / session 创建这类 setup await:
    // runner 从那里抛出,压根没走到任何 notifier 调用 —— 有 runError 却一条通知都没投。
    // 旧判据(runError !== undefined 即视为已通知)会静默吞掉唯一的失败提醒,配了桌面/
    // 飞书通知的用户什么都收不到(review #944 第五轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: { scheduleId: string; runId: string; errorMsg: string }[] = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: {
          fire: (_s, ctx) =>
            new Promise<FireResult>((_resolve, reject) => {
              // 响应 abort 并 settle,但**不**调 onRunnerNotified:复刻"还没走到通知
              // 就被打断"的 setup 阶段失败。
              ctx.signal.addEventListener('abort', () =>
                reject(new Error('aborted while creating the session')),
              );
            }),
        },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0, // 见 makeHarness 同名注释:假时钟跳表 ≠ 系统睡眠
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-notify-unnotified-stall',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      const p = scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await storage.listRuns(sch.id))[0].id;

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await p;

      expect(storage.runs.get(runId)?.status).toBe('failed');
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({ scheduleId: sch.id, runId });
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态落库卡死时保持追踪:controller 缺席不等于这条 fire 结束了', async () => {
    // runner 返回后 unregisterInflight 已经摘掉 controller、phase 进 'finalizing',此时
    // 终态落库(updateRun / get / update)若卡住,"controller 缺席"会被误读成"已 settle":
    // 旧实现删掉 attempt 就返回,于是这条仍在往下写的 fire 从槽位记账和守卫视野里一起
    // 消失,run 行停在 'running'、自动认领清空的 nextFireAt 也没人补(第六轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: unknown[] = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      let releaseUpdateRun: (() => void) | null = null;
      const realUpdateRun = storage.updateRun.bind(storage);
      storage.updateRun = (id: string, patch: Partial<ScheduleRun>) =>
        new Promise<ScheduleRun | null>((resolve) => {
          releaseUpdateRun = () => resolve(realUpdateRun(id, patch));
        });
      const scheduler = new Scheduler({
        storage,
        // runner 正常返回;卡住的是它之后的终态落库
        runner: { fire: async (s) => ({ sessionId: `sess-${s.id}` }) },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0, // 见 makeHarness 同名注释:假时钟跳表 ≠ 系统睡眠
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-finalizing-stall',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      const p = scheduler.runNow(sch.id);
      const runId = await vi.waitFor(async () => {
        const runs = await storage.listRuns(sch.id);
        expect(releaseUpdateRun).not.toBeNull(); // 已经卡在终态落库上
        return runs[0].id;
      });
      expect(scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('finalizing');

      // 走完"超阈值 → 宽限到点"两拍:旧实现在这里就把 attempt 删了
      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);
      expect(scheduler.getRuntimeSnapshot().inFlightRuns).toHaveLength(1);
      expect(notified).toHaveLength(0);

      // 落库最终返回后走正常收口,槽位由 fire 自己的 finally 释放
      releaseUpdateRun!();
      await p;
      expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      expect(storage.runs.get(runId)?.status).toBe('success');
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('第一拍心跳之前就睡下去,醒来同样不判卡死', async () => {
    // 基准若等第一拍回调才播种,醒来那一拍还没有可比的间隔 → 整段睡眠被当成无反馈,
    // 一条健康 run 直接被砍(review #944 第十四轮 P1)。
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        suspendGapMs: 30_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => { sawAbort = true; });
          }),
      });
      await h.scheduler.create({ ...baseInput, intervalMs: 24 * 3_600_000 });
      h.clock.advance(24 * 3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 还没跑过任何一拍心跳就合盖睡 8 小时,醒来第一拍
      h.clock.advance(8 * 3_600_000);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(sawAbort).toBe(false);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('系统挂起(合盖睡眠)醒来后不把睡着的时间当成无反馈', async () => {
    // 判据用壁钟:机器睡 8 小时,醒来第一次心跳看到的 noProgressMs 就是 8 小时,于是把
    // 一条完全健康、睡前正在跑长工具的 run 直接 abort(review #944 第十二轮 P1)。
    // 心跳每 15s 一拍,间隔突然出现远大于它的缺口只可能是进程被冻结过。
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        suspendGapMs: 30_000, // 本用例专门验挂起吸收,显式打开
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => { sawAbort = true; });
          }),
      });
      await h.scheduler.create({ ...baseInput, intervalMs: 24 * 3_600_000 });
      h.clock.advance(24 * 3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 第一拍心跳:建立基准(此时还没有可比的间隔)
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(sawAbort).toBe(false);

      // 合盖睡 8 小时:定时器在睡眠期间不跑,醒来这一拍的壁钟间隔是 8 小时
      h.clock.advance(8 * 3_600_000);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(sawAbort).toBe(false); // 睡着的时间不算无反馈

      // 醒来后继续静默,额度要从醒来那一刻重新算:再睡前额度已用掉 15s,还差 ~60s
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(sawAbort).toBe(false);
      for (let i = 0; i < 4; i++) {
        h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      }
      // 真正连续静默满一分钟(清醒时间)之后,守卫照常开火 —— 吸收不等于豁免
      expect(sawAbort).toBe(true);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态落库抛错不吞掉排期恢复', async () => {
    // 守卫已中断 run、runner 在强制收口前老实返回,而这一步的 updateRun 撞上存储瞬时
    // 错误 → 异常直接冒出 fireOneInner,把下面的 schedule 重排一起跳过。claimDueFire
    // 已清空 nextFireAt,这条活跃的 recurring 任务就此静默停摆到进程重启
    // (review #944 第九轮 P1)。
    vi.useFakeTimers();
    try {
      const storage = new InMemoryStorage();
      storage.updateRun = () => Promise.reject(new Error('database is locked'));
      const h = makeHarness({
        storage,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>((_resolve, reject) => {
            // 老实响应守卫 abort 并 settle → 走 fireOneInner 的 stallAborted 分支
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined(); // 认领已清空

      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      // 落库失败(run 行留给僵尸清扫兜底),但排期必须已恢复
      await vi.waitFor(async () =>
        expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined(),
      );
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('补排本身失败时挂进重试队列,后续 tick 就地修好(不停摆到重启)', async () => {
    // 补排的存储调用抛瞬时错误时,旧实现只记一行 warn 就放手,理由写的是"周期清扫 / 重启
    // 归一会兜底" —— 那是错的:周期 DB sync 只把行重新灌进内存,nextFireAt 仍是空、tick
    // 永远选不到它;僵尸清扫只看 'running' 的 run 行,而这条已是终态。于是一条活跃的
    // recurring 任务静默停摆到**进程重启**(第十八轮 P1)。
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () => new Promise<FireResult>(() => {}), // 卡死且不理 abort
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realUpdate = h.storage.update.bind(h.storage);
      let failNextReplanWrite = true;
      h.storage.update = (id: string, patch: Partial<Schedule>) => {
        // 只打掉补排那一次写(nextFireAt),别的写照常
        if (failNextReplanWrite && patch.nextFireAt !== undefined) {
          failNextReplanWrite = false;
          return Promise.reject(new Error('database is locked'));
        }
        return realUpdate(id, patch);
      };

      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      // 槽位已收回,但补排那次写被打掉 → 这条 recurring 任务此刻没有排期
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
      expect((await h.storage.get(sch.id))?.status).toBe('active'); // 仍是活跃任务,不是过期

      // 下一个 tick 就地重试 → 排期被修好
      await h.scheduler.tick();
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重试发现别的路径已补好排期:凭据必须摘除,不能永久上膛', async () => {
    // 重试的每一个"确定性结论"(补上了 / 行已删 / 已 paused / 已消耗 / 别人已补过)都要摘
    // 凭据。留着的话它永久上膛:等那次合法触发被认领、nextFireAt 又被清空时,重叠的 tick
    // 会把这条陈旧重试再应用一次,凭空排出一次触发并与正在跑的那一轮重叠
    // (第十八轮 P1 —— 这是我上一版修法自己引入的洞:早退分支绕过了 delete)。
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () => new Promise<FireResult>(() => {}), // 卡死且不理 abort
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      const realUpdate = h.storage.update.bind(h.storage);
      let failNextReplanWrite = true;
      h.storage.update = (id: string, patch: Partial<Schedule>) => {
        if (failNextReplanWrite && patch.nextFireAt !== undefined) {
          failNextReplanWrite = false;
          return Promise.reject(new Error('database is locked'));
        }
        return realUpdate(id, patch);
      };

      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));

      // 别的路径先把排期补好(用户改了 cron / 另一实例重排),重试于是走"已有排期"早退
      const repairedAt = h.clock.now() + 3_600_000;
      await h.storage.update(sch.id, { nextFireAt: repairedAt });
      await h.scheduler.tick();
      expect((await h.storage.get(sch.id))?.nextFireAt).toBe(repairedAt); // 没被覆盖

      // 那次合法触发被认领 → nextFireAt 又成空。此刻若凭据还在,tick 会凭空补一次触发。
      h.clock.advance(3_600_001);
      await h.storage.update(sch.id, { nextFireAt: undefined });
      await h.scheduler.tick();
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口一次性任务:过期而不是又排一次', async () => {
    // 强制收口不走 fireOneInner 的正常终态段,lastFiredAt 从未落定,computeNextFireAt 会
    // 把 Once 当成"还没跑过"又排一次 —— 一个失败的一次性任务自己再跑一遍(第七轮 P1)。
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () => new Promise<FireResult>(() => {}), // 卡死且不理 abort
      });
      // recurring=false 的一次性任务(cron 到点触发一次就该消耗掉)
      const sch = await h.scheduler.create({ ...baseInput, recurring: false });
      h.clock.advance(60_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await h.storage.listRuns(sch.id))[0].id;

      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).toBe('failed'));

      const row = await h.storage.get(sch.id);
      expect(row?.status).toBe('expired'); // 已消耗
      expect(row?.nextFireAt).toBeUndefined(); // 不得又排一次
      expect(row?.lastFiredAt).toBeDefined();
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口的终态落库失败时仍要投失败通知', async () => {
    // 不广播 'failed' 事件是为了不让 UI 和 DB 分叉,但通知是另一条通道:这一轮确实失败了,
    // 用户配的桌面 / 飞书提醒不该因为一次写盘失败就消失。尤其当 runner 迟到 settle 并已
    // 因 isRunAbandoned 主动让出通知权时,这里再跳过就等于两边都不投
    // (review #944 第十五轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: unknown[] = [];
      const storage = new InMemoryStorage();
      storage.updateRun = () => Promise.resolve(null); // 行不存在 / 写失败
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: { fire: () => new Promise<FireResult>(() => {}) }, // 卡死且不理 abort
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-notify-on-persist-fail',
      });
      const sch = await scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      clock.advance(3_600_000);
      void scheduler.tick();
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      // 落库失败 → 不广播 failed,但通知照投,且排期照恢复
      await vi.waitFor(() => expect(notified).toHaveLength(1));
      expect((await storage.get(sch.id))?.nextFireAt).toBeDefined();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('守卫 abort 被响应后终态落库抛错:通知不被外层 catch 一起吞掉', async () => {
    // 上一个用例走的是"runner 完全不理 abort → 强制收口"那条路;这里 runner 老实响应
    // abort,走的是 fireOneInner 自己的 stallAborted 分支。该分支整段包在一层 catch 里
    // (职责是保住 claimDueFire 清空的排期),落库一抛错控制流就跳出分支 —— 补发通知被
    // 顺带跳过,而"abort 落在 setup、runner 一条通知都没投"恰恰是最需要补发的场景:
    // 用户配了桌面 / 飞书通知却什么都收不到(review #944 第十八轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: { scheduleId: string; runId: string; errorMsg: string }[] = [];
      const storage = new InMemoryStorage();
      storage.updateRun = () => Promise.reject(new Error('database is locked'));
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: {
          fire: (_s, ctx) =>
            new Promise<FireResult>((_resolve, reject) => {
              // 响应 abort 并 settle,但**不**调 onRunnerNotified:复刻"还没走到通知
              // 就被打断"的 setup 阶段失败。
              ctx.signal.addEventListener('abort', () =>
                reject(new Error('aborted while creating the session')),
              );
            }),
        },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-notify-when-terminal-write-throws',
      });
      const sch = await scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      clock.advance(3_600_000);
      void scheduler.tick();
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      await vi.waitFor(() => expect(notified).toHaveLength(1));
      expect(notified[0]?.scheduleId).toBe(sch.id);
      // 外层 catch 的既有职责不能因这次改动回归:排期照恢复、槽位照释放
      expect((await storage.get(sch.id))?.nextFireAt).toBeDefined();
      expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runNow 守卫 abort:落库抛错照旧向调用方冒泡,但通知已经投出', async () => {
    // runNow 那条分支没有(也不该有)吞错的 catch —— 用户主动触发,写盘失败必须让调用方
    // 知道。补发通知因此要放在 finally,而不是靠"落库成功"顺序执行(第十八轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: { scheduleId: string; runId: string; errorMsg: string }[] = [];
      const storage = new InMemoryStorage();
      storage.updateRun = () => Promise.reject(new Error('database is locked'));
      const clock = new FakeClock();
      const scheduler = new Scheduler({
        storage,
        runner: {
          fire: (_s, ctx) =>
            new Promise<FireResult>((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () =>
                reject(new Error('aborted while creating the session')),
              );
            }),
        },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-runnow-notify-when-write-throws',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      // 立刻挂 handler:落库的拒绝发生在下面推时钟的那一拍,晚接会被记成 unhandled rejection
      const settled = scheduler.runNow(sch.id).then(
        () => null,
        (err: unknown) => err,
      );
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      expect(String(await settled)).toMatch(/database is locked/);
      expect(notified).toHaveLength(1);
      expect(notified[0]?.runId).toBeDefined();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口已投通知后,迟到 settle 的 runner 不再重复投', async () => {
    // 常见顺序:引擎先投失败通知,runner 几分钟后才 settle 并走自己的 finalizeRun ——
    // 用户为同一轮收到两条通知。runner 侧必须自查 isRunAbandoned(review #944 第十四轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: unknown[] = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      let settleRunner: (() => void) | null = null;
      let abandonedSeenByRunner: boolean | null = null;
      const scheduler = new Scheduler({
        storage,
        runner: {
          fire: (_s, ctx) =>
            new Promise<FireResult>((resolve) => {
              settleRunner = () => {
                // runner 在真正投通知前查询引擎(生产里就是 finalizeRun 的那次自查)
                abandonedSeenByRunner = scheduler.isRunAbandoned(ctx.runId);
                resolve({ sessionId: 'sess-late' });
              };
            }),
        },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-no-late-dup-notify',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      const p = scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      // 引擎已强制收口并投过通知
      await vi.waitFor(() => expect(notified).toHaveLength(1));

      // runner 现在才 settle:它自查到本轮已被强制收口 → 生产里据此跳过自己的通知
      settleRunner!();
      await p;
      expect(abandonedSeenByRunner).toBe(true);
      // 引擎侧也没有再补第二条
      expect(notified).toHaveLength(1);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('收口期间迟到的 settle 不得替强制收口删掉 attempt', async () => {
    // runner 在 abandonedRuns 标记之后、收口 await 期间才 settle:fireOne 自己的外层
    // finally 会调 finishInflightAttempt 把同一条 attempt 删掉,未完成的收口就此从槽位
    // 记账和守卫视野里消失 —— 落库若卡住,run 行停在 'running'、自动认领清空的 nextFireAt
    // 也没人补,而新任务照常放行(review #944 第十三轮 P1)。
    vi.useFakeTimers();
    try {
      const errorLogs: string[] = [];
      const logger = {
        debug() {}, info() {}, warn() {},
        error(msg: string) { errorLogs.push(msg); },
      } as unknown as Logger;
      const storage = new InMemoryStorage();
      let releaseUpdateRun: (() => void) | null = null;
      const realUpdateRun = storage.updateRun.bind(storage);
      storage.updateRun = (id: string, patch: Partial<ScheduleRun>) =>
        new Promise<ScheduleRun | null>((resolve) => {
          releaseUpdateRun = () => resolve(realUpdateRun(id, patch));
        });
      let settleRunner: (() => void) | null = null;
      const h = makeHarness({
        storage,
        logger,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        // 一直不理 abort,直到测试显式放它 settle
        runnerImpl: () =>
          new Promise<FireResult>((resolve) => {
            settleRunner = () => resolve({ sessionId: 'sess-late' });
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 走到强制收口,并卡在它自己的 updateRun 上
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(releaseUpdateRun).not.toBeNull());
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);

      // 此刻 runner 迟到 settle → fireOne 的外层 finally 跑起来
      settleRunner!();
      await vi.advanceTimersByTimeAsync(0);

      // 收口还没结束:attempt 必须仍在账上(旧实现这里已经是 0 了)
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);
      expect(h.scheduler.getRuntimeSnapshot().inFlightRuns).toHaveLength(1);
      // 落库继续卡着 → 超过阈值仍要有存储卡死诊断
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(errorLogs.filter((m) => m.includes('storage await appears wedged'))).toHaveLength(1);

      // 放行落库 → 收口走完,槽位由强制收口这一个出口释放,排期已恢复
      releaseUpdateRun!();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口自己的落库卡住时也保持追踪', async () => {
    // forceReleaseStalledRun 曾经先删 attempt 再 await 落库/重排。落库卡住时:run 行还停在
    // 'running'、自动认领清空的 nextFireAt 还没补,而这条 run 已经从槽位记账和守卫视野里
    // 一起消失 —— 与第六轮修的 runner-finalization 同一个坑(第七轮 P1)。
    vi.useFakeTimers();
    try {
      const errorLogs: string[] = [];
      const logger = {
        debug() {}, info() {}, warn() {},
        error(msg: string) { errorLogs.push(msg); },
      } as unknown as Logger;
      const storage = new InMemoryStorage();
      let releaseUpdateRun: (() => void) | null = null;
      const realUpdateRun = storage.updateRun.bind(storage);
      storage.updateRun = (id: string, patch: Partial<ScheduleRun>) =>
        new Promise<ScheduleRun | null>((resolve) => {
          releaseUpdateRun = () => resolve(realUpdateRun(id, patch));
        });
      const h = makeHarness({
        storage,
        logger,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: () => new Promise<FireResult>(() => {}), // 卡死且不理 abort
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 走到强制收口,然后卡在它自己的 updateRun 上
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(releaseUpdateRun).not.toBeNull());

      // 收口没结束 → 仍在账上、仍受守卫观测(旧实现这里已经是 0 了)
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);
      expect(h.scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('finalizing');

      // 落库一直卡着 → 超过阈值后要有存储卡死诊断,不能静默
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(errorLogs.filter((m) => m.includes('storage await appears wedged'))).toHaveLength(1);

      // 落库返回后走完收口,槽位由统一出口释放
      releaseUpdateRun!();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0));
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeDefined(); // 排期已恢复
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('守卫 abort 被响应后的正常落库不报存储卡死', async () => {
    // finalizing 卡死若按 lastProgressAt 判定,守卫 abort 生效的正常路径会在落库刚开始那
    // 一刻就误报:此时 lastProgressAt 已经旧了整个 runStallMs。判定必须从进入 finalizing
    // 起算(finalizingSince)。
    vi.useFakeTimers();
    try {
      const errorLogs: string[] = [];
      const logger = {
        debug() {}, info() {}, warn() {},
        error(msg: string) { errorLogs.push(msg); },
      } as unknown as Logger;
      // 落库刻意慢一拍,好让心跳在 finalizing 期间抓到这条 attempt —— 真机上 SQLite 忙时
      // 就是这个窗口。InMemoryStorage 太快,不挂住的话根本复现不出误报。
      const storage = new InMemoryStorage();
      let releaseUpdateRun: (() => void) | null = null;
      const realUpdateRun = storage.updateRun.bind(storage);
      storage.updateRun = (id: string, patch: Partial<ScheduleRun>) =>
        new Promise<ScheduleRun | null>((resolve) => {
          releaseUpdateRun = () => resolve(realUpdateRun(id, patch));
        });
      const h = makeHarness({
        storage,
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        logger,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await h.storage.listRuns(sch.id))[0].id;

      // 无进展超阈值 → 守卫 abort → runner 立刻响应 → 进 finalizing 并卡在终态落库
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => {
        expect(h.scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('finalizing');
        expect(releaseUpdateRun).not.toBeNull();
      });

      // 再走一拍心跳:此刻 lastProgressAt 已经旧了整个阈值,但 finalizing 才刚开始 ——
      // 按 lastProgressAt 判定会在这里误报卡死。
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(errorLogs.filter((m) => m.includes('storage await appears wedged'))).toHaveLength(0);

      releaseUpdateRun!();
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).toBe('failed'));
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口一条手动 run 时不替自动 claim 补排', async () => {
    // runNow 从不认领自动触发、也从不改 nextFireAt。强制收口手动 run 时顺手补排等于替一个
    // 自己没持有的 claim 写排期:同 schedule 上真正在跑的自动 run 会与新排出来的这次重叠,
    // 一次性任务还会因为 lastFiredAt 尚未落定而被当成没消耗过、就此复活(第六轮 P1)。
    vi.useFakeTimers();
    try {
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        // 手动 run 卡死且不理 abort → 走到强制收口
        runnerImpl: () => new Promise<FireResult>(() => {}),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      // 模拟同 schedule 上的自动 run 已经认领本次触发(claimDueFire 会清空 nextFireAt)
      await h.storage.update(sch.id, { nextFireAt: undefined });

      const p = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      const runId = (await h.storage.listRuns(sch.id))[0].id;

      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      // 自己的槽位和 run 行照常收口
      await vi.waitFor(() => expect(h.storage.runs.get(runId)?.status).toBe('failed'));
      expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      // 但**不得**替自动 claim 补排 —— 那个 claim 不归这条手动 run 管
      expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
      void p;
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('前置 await 卡死时保持追踪:不删 attempt、不强制收口', async () => {
    // attempt 在第一次 await 前就登记,而 AbortController 只在 run 行插入之后注册。
    // 卡在这段前置窗口(claimDueFire / insertRun / runNow 的 storage.get)时,守卫既
    // 无从 abort(没有 controller),也**不能**强制收口 —— 删掉 attempt 后,挂起的
    // await 一旦返回,fire 会照原路启动 runner,此时它既不计入 maxConcurrentRuns、
    // 也不再受守卫保护,正是本 PR 要消灭的隐形泄漏(review #944 第五轮 P1)。
    vi.useFakeTimers();
    try {
      const notified: unknown[] = [];
      const storage = new InMemoryStorage();
      const clock = new FakeClock();
      let releaseInsert: (() => void) | null = null;
      const realInsertRun = storage.insertRun.bind(storage);
      storage.insertRun = (run: ScheduleRun) =>
        new Promise<ScheduleRun>((resolve) => {
          releaseInsert = () => resolve(realInsertRun(run));
        });
      const errorLogs: string[] = [];
      const logger = {
        debug() {}, info() {}, warn() {},
        error(msg: string) { errorLogs.push(msg); },
      } as unknown as Logger;
      const scheduler = new Scheduler({
        storage,
        runner: { fire: async (s) => ({ sessionId: `sess-${s.id}` }) },
        clock,
        generateId: makeIdGen(),
        tickIntervalMs: 60_000_000,
        suspendGapMs: 0, // 见 makeHarness 同名注释:假时钟跳表 ≠ 系统睡眠
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        logger,
        notifyForcedFailure: (input) => {
          notified.push(input);
        },
        instanceId: 'test-pre-registration-stall',
      });
      const sch = await scheduler.create({ ...baseInput, manual: true });
      const p = scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));

      // 阈值之内的前置窗口是正常形态(每次 fire 都会有几毫秒),不许报卡死
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(errorLogs).toHaveLength(0);

      // 走完"无进展超阈值 → 宽限也到点"的完整两拍:强制收口的条件已经齐了
      clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

      // 仍在账上(继续占槽、继续出现在诊断快照里),也没被记成 failed / 投通知
      expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(1);
      expect(scheduler.getRuntimeSnapshot().inFlightRuns).toHaveLength(1);
      expect(notified).toHaveLength(0);
      // 但必须留下诊断:静默占槽才是这个洞真正的危险处。节流后仍只有一条。
      expect(errorLogs.filter((m) => m.includes('before its abort controller'))).toHaveLength(1);

      // 挂起的写入返回后照常跑完,槽位由正常路径释放
      releaseInsert!();
      await p;
      expect(scheduler.getRuntimeSnapshot().slotsInUse).toBe(0);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runStallMs=0 关闭卡死守卫', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const h = makeHarness({
        runStallMs: 0,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
            });
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      void h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(24 * 3_600_000);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
      expect(sawAbort).toBe(false);
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #1016:attempt 生命周期状态机(转移统一入口 + 单一出口清单) ──────────────
describe('Scheduler: attempt 生命周期状态机(#1016)', () => {
  function spyLogger(): { logger: Logger; warns: unknown[][] } {
    const warns: unknown[][] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn((...args: unknown[]) => warns.push(args)),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    return { logger, warns };
  }

  it('完整生命周期(含排队往返)合法收口:零非法转移、出口零残留告警', async () => {
    const { logger, warns } = spyLogger();
    let ctxRef: FireContext | undefined;
    let release: (() => void) | undefined;
    const h = makeHarness({
      logger,
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>((resolve) => {
          ctxRef = ctx;
          ctx.onQueueWaitStart?.();
          release = () => {
            // 排队 → 回收槽位 → 正常完成:覆盖 running→queued→running→finalizing 全链。
            expect(ctx.endQueueWait?.(true)).toBe(true);
            resolve({ sessionId: 'sess-full-lifecycle' });
          };
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(ctxRef).toBeDefined());
    expect(h.scheduler.getRuntimeSnapshot().inFlightRuns[0]?.phase).toBe('queued');
    release?.();
    await p;
    const snap = h.scheduler.getRuntimeSnapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.slotsInUse).toBe(0);
    // 单一出口清单未发现任何残留登记(残留 = 某条路径漏了收口,响亮告警)。
    expect(
      warns.some((args) => String(args[0]).includes('unreaped registrations')),
    ).toBe(false);
    await h.scheduler.stop();
  });

  it('排队中 runner 直接抛错(不经过 endQueueWait)→ queued→finalizing 合法收口为 failed', async () => {
    const { logger, warns } = spyLogger();
    let reject: ((err: Error) => void) | undefined;
    const h = makeHarness({
      logger,
      runnerImpl: (_s, ctx) =>
        new Promise<FireResult>((_resolve, rej) => {
          ctx.onQueueWaitStart?.();
          reject = rej;
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(reject).toBeDefined());
    reject?.(new Error('queued turn interrupted'));
    await p;
    const runs = await h.storage.listRuns(sch.id);
    expect(runs[0]?.status).toBe('failed');
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    expect(
      warns.some((args) => String(args[0]).includes('unreaped registrations')),
    ).toBe(false);
    await h.scheduler.stop();
  });

  it('强制收口后 runner 迟到调用 onQueueWaitStart → no-op,不抛非法转移(#1016 review)', async () => {
    vi.useFakeTimers();
    try {
      let ctxRef: FireContext | undefined;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctxRef = ctx;
          }),
      });
      await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0));
      // 强制收口已完成,runner 的 continuation 迟到调排队回调:必须是安静的 no-op。
      expect(() => ctxRef?.onQueueWaitStart?.()).not.toThrow();
      expect(() => ctxRef?.endQueueWait?.(true)).not.toThrow();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('强制收口后迟到的 onTurnActive/onSessionBound 不留悬挂登记(#1016 review)', async () => {
    vi.useFakeTimers();
    try {
      let ctxRef: FireContext | undefined;
      const h = makeHarness({
        runStallMs: 60_000,
        runStallAbortGraceMs: 30_000,
        runnerImpl: (_s, ctx) =>
          new Promise<FireResult>(() => {
            ctxRef = ctx;
          }),
      });
      const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      h.clock.advance(60_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      h.clock.advance(30_001);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0));
      // attempt 已删并 reap:迟到的 turn-active / session-bound 上报必须整体 no-op,
      // 不写 session 映射 / 绑定映射(悬挂登记会让下一次 begin 的不变量断言抛错)。
      expect(() => ctxRef?.onTurnActive?.('sess-late-turn')).not.toThrow();
      await ctxRef?.onSessionBound?.('sess-late-bind');
      expect(h.scheduler.resolveInflightRunForSession('sess-late-turn')).toBeUndefined();
      // 下一轮 fire 的 beginInflightAttempt 会跑 assertAttemptRegistryInvariants
      // (含 bound-session / silenced 覆盖)——迟到写入若真落了账,这里会响亮抛错。
      h.clock.advance(3_600_000);
      void h.scheduler.tick();
      await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().slotsInUse).toBe(1));
      expect(sch.id).toBeTruthy();
      await h.scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() 清 silencedRuns:静默 run 执行中停机后再 runNow 不被不变量断言误杀(#1016 review)', async () => {
    const h = makeHarness({
      runnerImpl: () => new Promise<FireResult>(() => {}),
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    const first = h.scheduler.runNow(sch.id);
    first.catch(() => {});
    await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(1));
    const [running] = await h.scheduler.listRuns(sch.id);
    expect(h.scheduler.isRunSilenced(running.id)).toBe(true);
    await h.scheduler.stop();
    // stop 清空 attempts 的同时必须一并清 silencedRuns:留着的话,同实例后续第一次
    // beginInflightAttempt 的不变量断言会把它当悬挂登记抛错(codex review P1)。
    expect(h.scheduler.isRunSilenced(running.id)).toBe(false);
    const second = h.scheduler.runNow(sch.id);
    second.catch(() => {});
    await vi.waitFor(() => expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(1));
    await h.scheduler.stop();
  });

  it('stop() 打在前置 await 期间:恢复的 continuation 不登记悬挂 controller(#1016 review)', async () => {
    // stop() 清 attempt 时 continuation 还没有 controller,无从 abort;恢复后若照常
    // registerInflight,controller/索引就成了没有 attempt 的悬挂登记,此后同实例每次
    // begin 都被不变量断言拦下(codex review P1)。守卫应放弃本轮并(runNow 契约)抛错。
    const storage = new InMemoryStorage();
    let releaseInsert: (() => void) | null = null;
    let gated = true;
    const realInsertRun = storage.insertRun.bind(storage);
    storage.insertRun = (run: ScheduleRun) => {
      if (!gated) return realInsertRun(run);
      return new Promise<ScheduleRun>((resolve) => {
        releaseInsert = () => resolve(realInsertRun(run));
      });
    };
    const h = makeHarness({
      storage,
      runnerImpl: async () => ({ sessionId: 'sess-after-stop' }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const first = h.scheduler.runNow(sch.id);
    const firstOutcome = first.then(
      () => 'resolved',
      (e) => String(e),
    );
    await vi.waitFor(() => expect(releaseInsert).not.toBeNull());
    await h.scheduler.stop();
    gated = false;
    releaseInsert!();
    expect(await firstOutcome).toMatch(/stopped while starting runNow/);
    // 无悬挂登记:同实例再 runNow,begin 的不变量断言不抛,run 正常收尾。
    const second = await h.scheduler.runNow(sch.id);
    expect(second.runId).toBeTruthy();
    await h.scheduler.stop();
  });
});

describe('caller-owned deferred dispatch', () => {
  it('returns deferred without arming a manual schedule or recording a failure', async () => {
    const canDispatch = vi.fn(() => false);
    const h = makeHarness({ runnerImpl: async (_schedule, ctx) => {
      expect(ctx.deferToCaller).toBe(true);
      expect(ctx.canDispatch).toBe(canDispatch);
      expect(ctx.canDispatch?.()).toBe(false);
      return { sessionId: 'bot-task', deferred: true, deferRetryMs: 1000 };
    } });
    const schedule = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const failed = vi.fn();
    h.scheduler.on('failed', failed);
    const result = await h.scheduler.runNow(schedule.id, { deferToCaller: true, canDispatch });
    expect(result.deferred).toBe(true);
    expect(await h.storage.listRuns(schedule.id)).toEqual([]);
    expect(await h.storage.get(schedule.id)).toMatchObject({
      nextFireAt: undefined, lastFiredAt: undefined,
    });
    h.clock.advance(120000);
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    await h.scheduler.stop();
  });
});

it('keeps internal routine schedules out of public management while retaining host execution and cleanup', async () => {
  const h = makeHarness();
  const publicSchedule = await h.scheduler.create(baseInput);
  const internal = { ...publicSchedule, id: 'routine-owned', source: 'bot' as const, manual: true, nextFireAt: undefined };
  await h.storage.insert(internal);
  expect(await h.scheduler.list()).toEqual([publicSchedule]);
  expect(await h.scheduler.get(internal.id)).toBeNull();
  const buildPatch = vi.fn(async () => ({ name: 'changed' }));
  const actions = [
    () => h.scheduler.listRuns(internal.id),
    () => h.scheduler.update(internal.id, { name: 'changed' }),
    () => h.scheduler.updateFromCurrent(internal.id, buildPatch),
    () => h.scheduler.pause(internal.id),
    () => h.scheduler.resume(internal.id),
    () => h.scheduler.delete(internal.id),
    () => h.scheduler.runNow(internal.id),
  ];
  for (const action of actions) await expect(action()).rejects.toThrow('not found');
  expect(buildPatch).not.toHaveBeenCalled();
  expect(h.runner.fire).not.toHaveBeenCalled();
  expect(await h.storage.get(internal.id)).toEqual(internal);
  const result = await h.scheduler.runNow(internal.id, { internalRoutine: true, deferToCaller: true });
  expect(h.runner.fire).toHaveBeenCalledTimes(1);
  await expect(h.scheduler.deleteRun(result.runId)).rejects.toThrow('not found');
  expect(await h.storage.listRuns(internal.id)).toHaveLength(1);
  await h.scheduler.pause(internal.id, { internalRoutine: true });
  await h.scheduler.delete(internal.id, { internalRoutine: true });
  expect(await h.storage.get(internal.id)).toBeNull();
  await h.scheduler.runNow(publicSchedule.id);
  expect(h.runner.fire).toHaveBeenCalledTimes(2);
  await h.scheduler.stop();
});
