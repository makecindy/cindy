import { describe, expect, it } from 'vitest';
import type { WorktreeRecycleRecord } from '../worktree/recycleJournal';
import { deferRecycle, MAX_RECYCLE_FAILED_WORK_MS, recycleFailureReason, recyclePolicy } from '../worktree/recyclePolicy';

const record = () => ({ attempts: 0, nextAttemptAt: 0 } as WorktreeRecycleRecord);
describe('worktree recycle retry budget', () => {
  it('persists exhaustion across serialized reloads', () => {
    let value = record();
    for (let i = 0; i < 3; i++) {
      deferRecycle(value, 'EBUSY', 100, 1000);
      value = JSON.parse(JSON.stringify(value));
    }
    expect(recyclePolicy(value)).toEqual({ state: 'paused', failures: 3, failedWorkMs: 300 });
    expect(value.nextAttemptAt).toBe(0);
  });
  it('pauses after the accumulated failed-work budget even below the retry count', () => {
    const value = record();
    deferRecycle(value, 'recycle-failed', MAX_RECYCLE_FAILED_WORK_MS);
    expect(recyclePolicy(value).state).toBe('paused');
  });
  it('does not charge reference waits or repeatedly schedule kept directories', () => {
    const value = record();
    deferRecycle(value, 'referenced-before-removal', 100);
    expect(recyclePolicy(value)).toEqual({ state: 'waiting', failures: 0, failedWorkMs: 0 });
    expect(value.nextAttemptAt).toBe(0);
    deferRecycle(value, 'keep-sentinel', 100);
    expect(recyclePolicy(value).state).toBe('kept');
  });
  it.each(['archive-integrity', 'ENOSPC', 'EACCES', 'directory-replaced'])('pauses %s without burning more attempts', (reason) => {
    const value = record(); deferRecycle(value, reason, 100);
    expect(recyclePolicy(value).state).toBe('paused');
  });
  it('does not convert historical reference waits into exhausted failures', () => {
    const value = { ...record(), attempts: 400, reason: 'referenced-or-runtime-unavailable' };
    expect(recyclePolicy(value)).toEqual({ state: 'waiting', failures: 0, failedWorkMs: 0 });
    value.reason = 'recycle-failed';
    expect(recyclePolicy(value).state).toBe('paused');
  });
  it('recognizes exact integrity errors without treating arbitrary errors as permanent', () => {
    expect(recycleFailureReason(new Error('archive content does not match worktree inventory'))).toBe('archive-integrity');
    expect(recycleFailureReason(new Error('temporary unavailable'))).toBe('recycle-failed');
  });
});
