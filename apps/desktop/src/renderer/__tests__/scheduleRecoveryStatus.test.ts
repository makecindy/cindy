import { describe, expect, it } from 'vitest';
import { projectScheduleSidebarIndex } from '@/features/scheduler/lib/projectScheduleSidebarIndex';
import type { ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import { projectSidebarSessionActivity, resolveSidebarRightStatus } from '@/features/cc-agent/sidebar/sidebarRightStatus';

const failure: ScheduleSidebarIndexRun = {
  runId: 'failure', scheduleId: 'schedule', scheduleName: 'Check',
  scheduleStatus: 'active', sessionId: 'task', status: 'failed', firedAt: 1,
};
const success: ScheduleSidebarIndexRun = { ...failure, runId: 'success', status: 'success', firedAt: 2 };

function status(runs: ScheduleSidebarIndexRun[], liveError = false) {
  const info = projectScheduleSidebarIndex(runs).get('task')!;
  return {
    info,
    dot: resolveSidebarRightStatus(projectSidebarSessionActivity({
      sessionId: 'task', attentionKind: undefined,
      liveActivity: liveError ? { phase: 'error', attention: true } : undefined,
      isUrgentFromContext: info.hasUnreadFailedRun,
      hasAttentionNotification: info.hasUnreadRun,
      isRunning: false,
    })),
  };
}

describe('task status after schedule recovery', () => {
  it.each([false, true])('retires an old failure after success, independent of arrival order (reversed=%s)', (reversed) => {
    const rows = [failure, success];
    const { info, dot } = status(reversed ? rows.reverse() : rows);
    expect(info.latestFailedRun).toBeUndefined();
    expect(dot).toBe('done');
    expect(info.unreadRunIds).toEqual(['success']);
    expect(info.unreadFailedRunIds).toEqual([]);
    expect(info.latestUnreadFailedRunId).toBeUndefined();
  });

  it('does not turn recovered unread history into a new completion badge after the success was read', () => {
    const { info, dot } = status([failure, { ...success, readAt: 3 }]);
    expect(info.hasUnreadRun).toBe(false);
    expect(dot).toBe('time');
  });

  it('honors host recovery even when the successful run is absent from the lightweight snapshot', () => {
    expect(status([{ ...failure, failureRecovered: true }]).dot).toBe('time');
  });

  it('keeps real failures red: no recovery, another schedule success, and a new failure after success', () => {
    for (const rows of [[failure], [failure, { ...success, scheduleId: 'other' }],
      [failure, success, { ...failure, runId: 'new-failure', firedAt: 3 }]]) {
      expect(status(rows).dot).toBe('error');
    }
  });

  it('does not clear the actual task error when its background schedule recovers', () => {
    expect(status([failure, success], true).dot).toBe('error');
  });
});
