import { describe, expect, it } from 'vitest';

import type { ScheduleRun } from '@cindy/maker-scheduler';

import { buildForcedFailureRun } from '../forcedFailureRun';

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
