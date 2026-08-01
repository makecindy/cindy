import { describe, expect, it } from 'vitest';
import {
  buildSchedulePauseConfirmation,
  countUnreadRuns,
  displayRunsForMobile,
  normalizeScheduleInflightCount,
  normalizeScheduleList,
  normalizeScheduleRuns,
  sortSchedulesForMobile,
  summarizeAutomationOverview,
  summarizeRun,
  summarizeSchedule,
} from '@/scheduler/scheduleModel';
import type { RemoteSchedule, RemoteScheduleRun } from '@/scheduler/types';

const NOW = Date.parse('2026-06-16T10:00:00.000Z');

function schedule(patch: Partial<RemoteSchedule>): RemoteSchedule {
  return {
    id: 'sched-1',
    name: '巡检 xdt-maker',
    status: 'active',
    recurring: true,
    manual: false,
    cronExpr: '0 9 * * *',
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '/repo/xdt-maker',
    updatedAt: NOW,
    ...patch,
  };
}

function run(patch: Partial<RemoteScheduleRun>): RemoteScheduleRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    status: 'success',
    firedAt: NOW - 60_000,
    ...patch,
  };
}

describe('schedule model', () => {
  it('normalizes schedule and run payloads from remote IPC results', () => {
    expect(normalizeScheduleList([
      { id: 'a', name: 'A', status: 'paused' },
      { id: 'b', status: 'unknown' },
      { name: 'missing id' },
    ])).toEqual([
      { id: 'a', name: 'A', status: 'paused' },
      { id: 'b', name: 'b', status: 'active' },
    ]);

    expect(normalizeScheduleRuns([
      { id: 'r1', scheduleId: 'a', status: 'interrupted' },
      { id: 'r2', scheduleId: 'a', status: 'bad' },
      { id: 'missing schedule' },
    ])).toEqual([
      { id: 'r1', scheduleId: 'a', status: 'interrupted' },
      { id: 'r2', scheduleId: 'a', status: 'failed' },
    ]);
  });

  it('sorts like the desktop scheduler list', () => {
    const sorted = sortSchedulesForMobile([
      schedule({ id: 'paused-new', status: 'paused', lastFiredAt: NOW }),
      schedule({ id: 'active-old', status: 'active', lastFiredAt: NOW - 1000 }),
      schedule({ id: 'expired-new', status: 'expired', lastFiredAt: NOW }),
      schedule({ id: 'active-never', status: 'active', lastFiredAt: undefined, updatedAt: NOW + 100 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      'expired-new',
      'active-old',
      'active-never',
      'paused-new',
    ]);
  });

  it('summarizes schedule timing, destination and unread state', () => {
    const summary = summarizeSchedule(
      schedule({
        lastFiredAt: NOW - 3_600_000,
        nextFireAt: NOW + 7_200_000,
      }),
      [
        run({ id: 'r1', status: 'success', readAt: undefined }),
        run({ id: 'r2', status: 'running', readAt: undefined }),
      ],
      NOW,
    );

    expect(summary).toMatchObject({
      title: '巡检 xdt-maker',
      subtitle: '上次 1 小时前 · 2 小时后',
      detail: 'cron 0 9 * * * · 新任务 · Claude · xdt-maker',
      runSessionDetail: null,
      runSessionLabel: '新任务',
      statusLabel: '运行中',
      unreadCount: 1,
    });
  });

  it('summarizes persistent and bound schedule session behavior', () => {
    expect(summarizeSchedule(schedule({
      persistentSession: true,
      targetSessionId: 'session-persistent-123',
    }), [], NOW)).toMatchObject({
      detail: 'cron 0 9 * * * · 持续任务 · Claude · xdt-maker',
      runSessionDetail: '持续任务 session-',
      runSessionLabel: '持续任务',
    });

    expect(summarizeSchedule(schedule({
      targetSessionId: 'session-bound-456',
      workingDir: '',
      useWorktree: true,
    }), [], NOW)).toMatchObject({
      detail: 'cron 0 9 * * * · 绑定任务 · Claude · 未设置目录',
      runSessionDetail: '绑定到 session-',
      runSessionLabel: '绑定任务',
    });
  });

  it('summarizes automation overview counts for the mobile dashboard', () => {
    expect(summarizeAutomationOverview([
      schedule({ id: 'active-1', status: 'active' }),
      schedule({ id: 'paused-1', status: 'paused' }),
    ], new Map([
      ['active-1', [
        run({ id: 'running', scheduleId: 'active-1', status: 'running', readAt: undefined }),
        run({ id: 'failed-unread', scheduleId: 'active-1', status: 'failed', readAt: undefined }),
      ]],
      ['paused-1', [
        run({ id: 'success-read', scheduleId: 'paused-1', status: 'success', readAt: NOW }),
      ]],
    ]), NOW)).toEqual({
      activeCount: 1,
      pausedCount: 1,
      runningRunCount: 1,
      totalCount: 2,
      unreadRunCount: 1,
    });
  });

  it('folds repeated persistent-session runs by session id', () => {
    const displayRuns = displayRunsForMobile([
      run({ id: 'old-same-session', sessionId: 's1', firedAt: NOW - 2000 }),
      run({ id: 'new-same-session', sessionId: 's1', firedAt: NOW - 1000 }),
      run({ id: 'no-session', sessionId: undefined, firedAt: NOW }),
    ]);

    expect(displayRuns.map((item) => item.id)).toEqual([
      'no-session',
      'new-same-session',
    ]);
  });

  it('summarizes run cards and counts only terminal unread runs', () => {
    const runs = [
      run({ id: 'running', status: 'running', readAt: undefined }),
      run({ id: 'failed', status: 'failed', errorMsg: 'boom', readAt: undefined }),
      run({ id: 'read', status: 'success', readAt: NOW }),
    ];

    expect(countUnreadRuns(runs, NOW)).toBe(1);
    expect(summarizeRun(runs[1], NOW)).toMatchObject({
      title: '失败',
      detail: 'boom',
      meta: '耗时未知 · 未创建任务',
      canDelete: true,
      canMarkRead: true,
      canOpenSession: false,
      canRestart: false,
      deleteLabel: '删除',
      markReadLabel: '已读',
      unread: true,
    });

    expect(summarizeRun(run({
      id: 'with-session',
      sessionId: 'session-running-123',
      status: 'running',
      firedAt: NOW - 90_000,
    }), NOW)).toMatchObject({
      title: '执行中',
      detail: null,
      meta: '已运行 1 分 30 秒 · 任务 session-',
      openSessionLabel: '打开',
      sessionDetail: '任务 session-',
      canDelete: false,
      canMarkRead: false,
      canOpenSession: true,
      canRestart: false,
      unread: false,
    });

    expect(summarizeRun(run({
      id: 'interrupted-no-session',
      status: 'interrupted',
      finishedAt: NOW - 500,
    }), NOW)).toMatchObject({
      meta: '耗时 59.5 秒 · 可重新执行',
      canRestart: true,
      restartLabel: '重跑',
      openSessionLabel: null,
      sessionDetail: null,
    });

    expect(summarizeRun(run({
      id: 'blank-session',
      sessionId: '   ',
      status: 'success',
      finishedAt: NOW,
    }), NOW)).toMatchObject({
      canOpenSession: false,
      openSessionLabel: null,
      sessionDetail: null,
    });

    expect(summarizeRun(run({
      id: 'legacy-session:s1',
      readAt: undefined,
      status: 'failed',
    }), NOW)).toMatchObject({
      canDelete: false,
      canMarkRead: false,
      canRestart: false,
      deleteLabel: null,
      markReadLabel: null,
      unread: true,
    });
  });

  it('requires pause confirmation only when desktop reports inflight runs', () => {
    expect(normalizeScheduleInflightCount('2.9')).toBe(2);
    expect(normalizeScheduleInflightCount(-1)).toBe(0);
    expect(normalizeScheduleInflightCount('bad')).toBe(0);

    expect(buildSchedulePauseConfirmation(schedule({ name: '巡检' }), 0)).toBeNull();
    expect(buildSchedulePauseConfirmation(schedule({ name: '巡检' }), 2)).toEqual({
      title: '暂停 巡检',
      detail: '这条自动化当前有 2 次执行正在进行。暂停会立即阻止后续触发,并停止这些正在进行的执行。',
      preview: '正在执行: 2 次',
    });
  });
});
