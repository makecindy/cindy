import { describe, expect, it } from 'vitest';

import { createComposerFrameScheduler } from '../composerFrameScheduler';

describe('createComposerFrameScheduler', () => {
  it('keeps only the latest pending frame', () => {
    let nextHandle = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let runs = 0;
    const scheduler = createComposerFrameScheduler(
      () => {
        runs += 1;
      },
      {
        requestFrame: (callback) => {
          const handle = nextHandle++;
          callbacks.set(handle, callback);
          return handle;
        },
        cancelFrame: (handle) => {
          cancelled.push(handle);
          callbacks.delete(handle);
        },
      },
    );

    scheduler.schedule();
    scheduler.schedule();
    expect(cancelled).toEqual([1]);
    expect(callbacks.size).toBe(1);
    callbacks.get(2)?.(16);
    expect(runs).toBe(1);
  });

  it('cancels pending work on teardown', () => {
    let callback: FrameRequestCallback | null = null;
    let cancelled = false;
    const scheduler = createComposerFrameScheduler(() => undefined, {
      requestFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: () => {
        cancelled = true;
        callback = null;
      },
    });

    scheduler.schedule();
    scheduler.cancel();
    expect(cancelled).toBe(true);
    expect(callback).toBeNull();
  });
});
