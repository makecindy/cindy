import { describe, expect, it } from 'vitest';

import {
  __composerDraftSaveSchedulerDefaultsForTest,
  createComposerDraftSaveScheduler,
} from '@/lib/composerDraftSaveScheduler';

describe('createComposerDraftSaveScheduler', () => {
  it('keeps only the latest task and flushes it immediately', () => {
    let nextHandle = 1;
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    const ran: string[] = [];
    const scheduler = createComposerDraftSaveScheduler({
      setTimer: (callback) => {
        const handle = nextHandle++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimer: (handle) => {
        cleared.push(handle);
        timers.delete(handle);
      },
    });

    scheduler.schedule(() => ran.push('old'));
    scheduler.schedule(() => ran.push('latest'));
    expect(timers.size).toBe(1);

    scheduler.flush();
    expect(ran).toEqual(['latest']);
    expect(cleared).toEqual([1]);
  });

  it('runs the pending task when the debounce timer fires', () => {
    const callbacks: Array<() => void> = [];
    const ran: string[] = [];
    const scheduler = createComposerDraftSaveScheduler({
      setTimer: (callback) => {
        callbacks.push(callback);
        return 1;
      },
      clearTimer: () => undefined,
    });

    scheduler.schedule(() => ran.push('saved'));
    expect(ran).toEqual([]);
    callbacks[0]?.();
    expect(ran).toEqual(['saved']);
  });

  it('cancels pending work on teardown', () => {
    const callbacks: Array<() => void> = [];
    const ran: string[] = [];
    const scheduler = createComposerDraftSaveScheduler({
      setTimer: (callback) => {
        callbacks.push(callback);
        return 1;
      },
      clearTimer: () => undefined,
    });

    scheduler.schedule(() => ran.push('saved'));
    scheduler.cancel();
    callbacks[0]?.();
    expect(ran).toEqual([]);
  });

  it('keeps the intended debounce default', () => {
    expect(__composerDraftSaveSchedulerDefaultsForTest.delayMs).toBe(120);
  });
});
