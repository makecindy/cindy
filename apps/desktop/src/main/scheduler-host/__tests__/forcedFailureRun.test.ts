import { describe, expect, it, vi } from 'vitest';

import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

import { buildForcedFailureRun, deliverForcedFailureNotification } from '../forcedFailureRun';

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
