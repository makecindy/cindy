import { describe, expect, it } from 'vitest';

import {
  findLatestSidebarIndexRunForSession,
  type ScheduleSidebarIndexRun,
} from '../scheduleSidebarIndexRuns';

const run = (partial: Partial<ScheduleSidebarIndexRun>): ScheduleSidebarIndexRun => ({
  runId: 'run-1',
  scheduleId: 'schedule-1',
  scheduleName: 'Automation',
  scheduleStatus: 'active',
  status: 'success',
  ...partial,
});

describe('findLatestSidebarIndexRunForSession', () => {
  it('chooses the latest Automation mapping when an older unread run appears first', () => {
    const olderUnread = run({
      runId: 'run-old',
      scheduleId: 'schedule-old',
      sessionId: 'session-1',
      firedAt: 100,
    });
    const latest = run({
      runId: 'run-latest',
      scheduleId: 'schedule-latest',
      sessionId: 'session-1',
      firedAt: 200,
    });

    expect(findLatestSidebarIndexRunForSession([olderUnread, latest], 'session-1')).toBe(latest);
  });

  it('uses run id as the deterministic tie-breaker used by the database projection', () => {
    const first = run({ runId: 'run-a', sessionId: 'session-1', firedAt: 200 });
    const second = run({ runId: 'run-b', sessionId: 'session-1', firedAt: 200 });

    expect(findLatestSidebarIndexRunForSession([second, first], 'session-1')).toBe(second);
  });
});
