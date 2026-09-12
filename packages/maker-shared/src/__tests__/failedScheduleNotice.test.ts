import { describe, expect, it } from 'vitest';
import { activeScheduleFailures, compareFailedScheduleRuns, shouldShowFailedScheduleNotice } from '../scheduleModel';
import { buildSessionScheduleIndex } from '../sessionList';
import type { RemoteScheduleRun } from '../scheduleTypes';
const run = { runId: 'b', firedAt: 10 };
const visible = { latestFailedRun: run, readOnly: false, tailError: false, interrupted: false,
  continuationPending: false, error: false, credentialWait: false, streaming: false, running: false };
describe('historical schedule failure notice', () => {
  it('uses time then run identity, independently of read state', () => {
    expect(compareFailedScheduleRuns(run, { runId: 'a', firedAt: 10 })).toBeGreaterThan(0);
    expect(compareFailedScheduleRuns(run, { runId: 'z', firedAt: 9 })).toBeGreaterThan(0);
    const rows = [
      { id: 'a', status: 'failed', firedAt: 10, readAt: 11 },
      { id: 'b', status: 'interrupted', firedAt: 10, readAt: 11 },
      { id: 'c', status: 'success', firedAt: 12, readAt: 13 },
      { id: 'd', status: 'aborted', firedAt: 14 },
    ].map((r) => ({ ...r, sessionId: 's', scheduleId: 'schedule' })) as RemoteScheduleRun[];
    const info = buildSessionScheduleIndex([], new Map([['schedule', rows]])).get('s');
    expect(info?.latestFailedRun).toBeUndefined();
    expect(info?.hasUnreadFailedRun).toBe(false);
  });
  it('recovers only the same schedule, regardless of input order, and preserves new failures', () => {
    const rows: RemoteScheduleRun[] = [
      { id: 'old-a', scheduleId: 'a', status: 'failed', firedAt: 1 },
      { id: 'old-b', scheduleId: 'b', status: 'failed', firedAt: 2 },
      { id: 'success-b', scheduleId: 'b', status: 'success', firedAt: 3 },
      { id: 'new-b', scheduleId: 'b', status: 'failed', firedAt: 4 },
      { id: 'recovered-on-host', scheduleId: 'c', status: 'failed', firedAt: 5, failureRecovered: true },
    ];
    expect([...activeScheduleFailures(rows)]).toEqual(['old-a', 'new-b']);
    expect([...activeScheduleFailures([...rows].reverse())].sort()).toEqual(['new-b', 'old-a']);
  });
  it('only an explicitly healthy check can recover a precheck failure, never an execution failure', () => {
    const rows: RemoteScheduleRun[] = [
      { id: 'execution', scheduleId: 'a', status: 'failed', firedAt: 1 },
      { id: 'check', scheduleId: 'a', status: 'failed', firedAt: 2, preRunHookResult: { decision: 'block' } },
      { id: 'backoff', scheduleId: 'a', status: 'skipped', firedAt: 3 },
    ];
    expect([...activeScheduleFailures(rows)]).toEqual(['execution', 'check']);
    rows.push({ id: 'healthy', scheduleId: 'a', status: 'skipped', firedAt: 4,
      preRunHookResult: { decision: 'skip', checkSucceeded: true } });
    expect([...activeScheduleFailures(rows)]).toEqual(['execution']);
  });
  it.each(['readOnly', 'tailError', 'interrupted', 'continuationPending', 'error', 'credentialWait', 'streaming', 'running'])(
    'yields to %s', (field) => {
      expect(shouldShowFailedScheduleNotice(visible)).toBe(true);
      expect(shouldShowFailedScheduleNotice({ ...visible, [field]: true })).toBe(false);
    });
  it('requires a failed run', () => expect(shouldShowFailedScheduleNotice({ ...visible, latestFailedRun: null })).toBe(false));
});
