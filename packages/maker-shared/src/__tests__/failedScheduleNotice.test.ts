import { describe, expect, it } from 'vitest';
import { compareFailedScheduleRuns, shouldShowFailedScheduleNotice } from '../scheduleModel';
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
    expect(info?.latestFailedRun).toEqual(run);
    expect(info?.hasUnreadFailedRun).toBe(false);
  });
  it.each(['readOnly', 'tailError', 'interrupted', 'continuationPending', 'error', 'credentialWait', 'streaming', 'running'])(
    'yields to %s', (field) => {
      expect(shouldShowFailedScheduleNotice(visible)).toBe(true);
      expect(shouldShowFailedScheduleNotice({ ...visible, [field]: true })).toBe(false);
    });
  it('requires a failed run', () => expect(shouldShowFailedScheduleNotice({ ...visible, latestFailedRun: null })).toBe(false));
});
