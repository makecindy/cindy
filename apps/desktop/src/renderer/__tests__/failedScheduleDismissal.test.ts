// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissScheduleFailure,
  failedScheduleDismissalPrefix,
  readLatestDismissedScheduleFailure,
} from '@/features/scheduler/lib/failedScheduleDismissal';

const prefix = failedScheduleDismissalPrefix('owner', 'session');
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('bounded failed schedule dismissal', () => {
  it('keeps one record after many failures and preserves other owners, tasks and preferences', () => {
    const otherOwner = failedScheduleDismissalPrefix('other', 'session');
    const otherTask = failedScheduleDismissalPrefix('owner', 'other');
    const older = { runId: 'original', firedAt: 0 };
    dismissScheduleFailure(otherOwner, older);
    dismissScheduleFailure(otherTask, older);
    localStorage.setItem('unrelated', 'keep');
    for (let i = 1; i <= 100; i++)
      dismissScheduleFailure(prefix, { runId: `run-${i}`, firedAt: i });
    expect(localStorage.length).toBe(4);
    expect(readLatestDismissedScheduleFailure(prefix)).toEqual({ runId: 'run-100', firedAt: 100 });
    expect(readLatestDismissedScheduleFailure(otherOwner)).toEqual(older);
    expect(readLatestDismissedScheduleFailure(otherTask)).toEqual(older);
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('uses run identity to order equal timestamps, regardless of close order', () => {
    dismissScheduleFailure(prefix, { runId: 'z', firedAt: 10 });
    dismissScheduleFailure(prefix, { runId: 'a', firedAt: 10 });
    expect(localStorage.length).toBe(1);
    expect(readLatestDismissedScheduleFailure(prefix)).toEqual({ runId: 'z', firedAt: 10 });
  });

  it.each(['before-scan', 'during-cleanup'] as const)(
    'preserves newer writes interleaved %s',
    (point) => {
      const older = { runId: 'old', firedAt: 1 };
      const newer = { runId: 'new', firedAt: 2 };
      const newest = { runId: 'newest', firedAt: 3 };
      dismissScheduleFailure(prefix, older);
      if (point === 'before-scan') {
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(function (
          this: Storage,
          key,
          value,
        ) {
          setItem.call(this, key, value);
          dismissScheduleFailure(prefix, newest);
        });
      } else {
        const removeItem = Storage.prototype.removeItem;
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(function (
          this: Storage,
          key,
        ) {
          dismissScheduleFailure(prefix, newest);
          removeItem.call(this, key);
        });
      }
      dismissScheduleFailure(prefix, newer);
      expect(localStorage.length).toBe(1);
      expect(readLatestDismissedScheduleFailure(prefix)).toEqual(newest);
    },
  );

  it('preserves the previous record on write failure and catches up after cleanup failure', () => {
    const older = { runId: 'old', firedAt: 1 };
    const newer = { runId: 'new', firedAt: 2 };
    dismissScheduleFailure(prefix, older);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() => dismissScheduleFailure(prefix, newer)).toThrow('quota');
    expect(readLatestDismissedScheduleFailure(prefix)).toEqual(older);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    expect(() => dismissScheduleFailure(prefix, newer)).toThrow('unavailable');
    expect(readLatestDismissedScheduleFailure(prefix)).toEqual(newer);
    dismissScheduleFailure(prefix, older);
    expect(localStorage.length).toBe(1);
    expect(readLatestDismissedScheduleFailure(prefix)).toEqual(newer);
  });
});
