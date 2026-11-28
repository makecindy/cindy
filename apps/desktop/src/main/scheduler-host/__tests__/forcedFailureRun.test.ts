import { describe, expect, it, vi } from 'vitest';

import type { FireContext, Schedule, ScheduleRun, ScheduleRunner } from '@cindy/maker-scheduler';

import { buildForcedFailureRun, deliverForcedFailureNotification } from '../forcedFailureRun';
import { createSchedulerHost } from '../index';
import type { MakerScheduleRunner } from '../runner';
import type { ScriptScheduleRunner } from '../script-runner';
import type { DrizzleScheduleStorage } from '../storage';

const BASE = {
  scheduleId: 'schedule-1',
  runId: 'run-1',
  errorMsg: 'no progress for 60 minutes; aborted by stall guard',
  now: 1_700_000_100_000,
};

function runRow(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId: 'schedule-1',
    firedAt: 1_700_000_000_000,
    status: 'running',
    ...overrides,
  };
}

describe('buildForcedFailureRun', () => {
  it('行还停在 running(终态落库失败)→ 覆盖成 failed 并带上卡死原因', () => {
    // 这条补发出口最要紧的调用场景就是"终态落库失败 / updateRun 返回 null":库里那行
    // 仍是 running 且没有 errorMsg。透传下去飞书会渲染成"运行中"、移动端拿不到卡死详情,
    // 补发通知等于白发(review #944 第十八轮 P1)。
    const out = buildForcedFailureRun({ ...BASE, run: runRow({ sessionId: 'sess-9' }) });

    expect(out.status).toBe('failed');
    expect(out.errorMsg).toBe(BASE.errorMsg);
    expect(out.finishedAt).toBe(BASE.now);
    // 行里的事实字段照旧复用,通知内容不该凭空造一个新的 firedAt / 会话
    expect(out.firedAt).toBe(1_700_000_000_000);
    expect(out.sessionId).toBe('sess-9');
  });

  it('行已落到终态 → 原样使用,通知内容与运行历史一致', () => {
    const row = runRow({
      status: 'failed',
      finishedAt: 1_700_000_050_000,
      errorMsg: 'agent 自己报的错',
      costAttribution: 'exact',
    });

    expect(buildForcedFailureRun({ ...BASE, run: row })).toBe(row);
  });

  it('非 failed 的终态(如 aborted)也不被改写', () => {
    const row = runRow({ status: 'aborted', finishedAt: 1_700_000_050_000 });

    expect(buildForcedFailureRun({ ...BASE, run: row }).status).toBe('aborted');
  });

  it('行根本查不到 → 造一条最小可读的 failed run', () => {
    const out = buildForcedFailureRun({ ...BASE, run: undefined });

    expect(out).toMatchObject({
      id: BASE.runId,
      scheduleId: BASE.scheduleId,
      status: 'failed',
      firedAt: BASE.now,
      finishedAt: BASE.now,
      errorMsg: BASE.errorMsg,
    });
  });

  it('running 行已带 finishedAt 时保留它(不拿"现在"覆盖真实完成时间)', () => {
    const out = buildForcedFailureRun({
      ...BASE,
      run: runRow({ finishedAt: 1_700_000_040_000 }),
    });

    expect(out.finishedAt).toBe(1_700_000_040_000);
  });
});

// 回归: 取消调度派发阶段提前写 userSendAt 后, 卡死守卫强制收口绕过 runner.finalizeRun,
// 必须在强制失败通知出口同步补记 touchUserSendInDb 以唤回「稍后处理」并推进排序时间。
describe('deliverForcedFailureNotification', () => {
  const baseSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
    id: BASE.scheduleId,
    name: 'PR #13016',
    prompt: 'follow PR',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/5 * * * *',
    timezone: 'UTC',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
    workingDir: '/repo',
    useWorktree: false,
    silentWhenIdle: true,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('stamps touchUserSendInDb from run.sessionId (or targetSessionId fallback) before notifying', async () => {
    const touchUserSendInDb = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);

    await deliverForcedFailureNotification({
      schedule: baseSchedule({ targetSessionId: 'target-fallback' }),
      runId: BASE.runId,
      errorMsg: BASE.errorMsg,
      run: runRow({ sessionId: 'bound-sess' }),
      now: BASE.now,
      notifier: { notify },
      touchUserSendInDb,
    });
    expect(touchUserSendInDb).toHaveBeenCalledWith('bound-sess', BASE.now);
    expect(notify).toHaveBeenCalledTimes(1);

    touchUserSendInDb.mockClear();
    notify.mockClear();
    await deliverForcedFailureNotification({
      schedule: baseSchedule({ targetSessionId: 'target-fallback' }),
      runId: BASE.runId,
      errorMsg: BASE.errorMsg,
      run: undefined,
      now: BASE.now,
      notifier: { notify },
      touchUserSendInDb,
    });
    expect(touchUserSendInDb).toHaveBeenCalledWith('target-fallback', BASE.now);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('still delivers the forced failure notification if touchUserSendInDb fails', async () => {
    const touchUserSendInDb = vi.fn(async () => { throw new Error('db busy'); });
    const notify = vi.fn(async () => undefined);
    const warn = vi.fn();

    await deliverForcedFailureNotification({
      schedule: baseSchedule({ targetSessionId: 'target-sess' }),
      runId: BASE.runId,
      errorMsg: BASE.errorMsg,
      run: runRow({ sessionId: 'target-sess' }),
      now: BASE.now,
      notifier: { notify },
      touchUserSendInDb,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// 回归: 插件前置检查 will-schedule-run 拦停(notifyPluginStop)属于同一失败通知族，
// 必须与 finalizeRun / notifyFailureSilent / notifyForcedFailure 一致地在发失败通知前
// 对绑定任务补记 touchUserSendInDb，否则稍后处理中的任务收到失败通知却不会被唤回。
describe('createSchedulerHost notifyPluginStop', () => {
  function pluginSchedule(overrides: Partial<Schedule> = {}): Schedule {
    return {
      id: 'sched-plugin-stop',
      name: 'PR #13016',
      prompt: 'follow PR',
      jobType: 'prompt',
      source: 'user',
      kind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'codex',
      workspaceKind: 'project',
      workingDir: '/repo',
      useWorktree: false,
      silentWhenIdle: true,
      targetSessionId: 'snoozed-task',
      preRunPlugin: { pluginId: 'guard', onFailure: 'block' },
      notify: { desktop: true, feishu: false },
      status: 'active',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  function fireContext(overrides: Partial<FireContext> = {}): FireContext {
    return {
      runId: 'run-plugin-stop',
      firedAt: 1_700_000_000_000,
      signal: new AbortController().signal,
      onRunnerNotified: vi.fn(),
      ...overrides,
    };
  }

  function makeStorageStub(): DrizzleScheduleStorage {
    return {
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      recordRun: vi.fn(async () => undefined),
      updateRun: vi.fn(async () => null),
      listRuns: vi.fn(async () => []),
      deleteOrphanRuns: vi.fn(async () => 0),
      markStaleRunningRunsInterrupted: vi.fn(async () => []),
      listActiveProjectSchedules: vi.fn(async () => []),
    } as unknown as DrizzleScheduleStorage;
  }

  async function startHostForPluginStop(opts: {
    action: 'block' | 'skip';
    touchUserSendInDb: (sessionId: string, atMs?: number) => Promise<void>;
    notify: (schedule: Schedule, run: ScheduleRun) => Promise<void>;
    warn?: ReturnType<typeof vi.fn>;
  }) {
    const captured: { runner?: ScheduleRunner } = {};
    const promptFire = vi.fn(async () => ({ sessionId: 'should-not-run' }));
    const host = createSchedulerHost({
      createStorage: () => makeStorageStub(),
      createRunners: () => ({
        notifier: { notify: opts.notify },
        promptRunner: {
          attachScheduler: vi.fn(),
          fire: promptFire,
        } as unknown as MakerScheduleRunner,
        scriptRunner: {
          attachScheduler: vi.fn(),
          fire: vi.fn(),
        } as unknown as ScriptScheduleRunner,
      }),
      wrapRunner: (runner) => {
        captured.runner = runner;
        return runner;
      },
      isPassive: () => true,
      dialogueWorkspaceRoots: () => [],
      onStarted: () => undefined,
      touchUserSendInDb: opts.touchUserSendInDb,
      beforeReset: async () => undefined,
    });
    await host.startScheduler({
      maker: {} as never,
      getDb: () => ({ select: vi.fn() }) as never,
      logger: { info: vi.fn(), warn: opts.warn ?? vi.fn(), error: vi.fn(), debug: vi.fn() },
      screenControlPoint: vi.fn(async () => ({
        action: opts.action,
        ghostId: 'guard',
        ghostName: 'Guard Plugin',
        reason: 'off hours',
        failure: false,
      })),
    });
    if (!captured.runner) throw new Error('expected wrapRunner to capture base runner');
    return { host, runner: captured.runner, promptFire };
  }

  it('stamps touchUserSendInDb on schedule.targetSessionId before notifying when plugin stops a run', async () => {
    const order: string[] = [];
    const touchUserSendInDb = vi.fn(async (_sessionId: string, _atMs?: number) => { order.push('touch'); });
    const notify = vi.fn(async (_schedule: Schedule, _run: ScheduleRun) => { order.push('notify'); });
    const { host, runner, promptFire } = await startHostForPluginStop({
      action: 'block',
      touchUserSendInDb,
      notify,
    });
    try {
      const ctx = fireContext();
      await expect(runner.fire(pluginSchedule(), ctx)).rejects.toThrow('Stopped by plugin "Guard Plugin": off hours');

      expect(promptFire).not.toHaveBeenCalled();
      expect(ctx.onRunnerNotified).toHaveBeenCalledWith('failure');
      expect(touchUserSendInDb).toHaveBeenCalledTimes(1);
      const [sid, atMs] = touchUserSendInDb.mock.calls[0];
      expect(sid).toBe('snoozed-task');
      expect(atMs).toBeGreaterThanOrEqual(ctx.firedAt);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toMatchObject({
        id: ctx.runId,
        status: 'failed',
        errorMsg: 'Stopped by plugin "Guard Plugin": off hours',
      });
      expect(order).toEqual(['touch', 'notify']);
    } finally {
      await host.resetScheduler();
    }
  });

  it('still delivers the plugin-stop failure notification if touchUserSendInDb fails', async () => {
    const touchUserSendInDb = vi.fn(async (_sessionId: string, _atMs?: number) => { throw new Error('db busy'); });
    const notify = vi.fn(async (_schedule: Schedule, _run: ScheduleRun) => undefined);
    const warn = vi.fn();
    const { host, runner } = await startHostForPluginStop({
      action: 'block',
      touchUserSendInDb,
      notify,
      warn,
    });
    try {
      await expect(runner.fire(pluginSchedule(), fireContext())).rejects.toThrow('Stopped by plugin');
      expect(warn).toHaveBeenCalledWith(
        '[scheduler-host] touchUserSend on plugin stop failed',
        expect.objectContaining({
          scheduleId: 'sched-plugin-stop',
          sessionId: 'snoozed-task',
          error: 'db busy',
        }),
      );
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      await host.resetScheduler();
    }
  });

  it('does not stamp touchUserSendInDb or notify when plugin skips a run', async () => {
    const touchUserSendInDb = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const { host, runner } = await startHostForPluginStop({
      action: 'skip',
      touchUserSendInDb,
      notify,
    });
    try {
      const result = await runner.fire(pluginSchedule(), fireContext());
      expect(result.skipped).toBe(true);
      expect(touchUserSendInDb).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      await host.resetScheduler();
    }
  });
});
