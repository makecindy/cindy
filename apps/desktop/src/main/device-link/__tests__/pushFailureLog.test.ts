import { describe, expect, it, vi } from 'vitest';
import { createPushFailureLog } from '../pushFailureLog';

describe('push failure aggregation', () => {
  it('keeps exact failure counts with only an initial and summary log', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const log = createPushFailureLog(emit, () => Date.now());
    try {
      for (let i = 0; i < 1990; i++) log.record('phone', 'local-db:sessions:patched', 'BACKPRESSURE');
      expect(emit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls.map(([event]) => event.count)).toEqual([1, 1989]);
      expect(emit.mock.calls[1][0].elapsedMs).toBe(5000);
    } finally { log.flush(); vi.useRealTimers(); }
  });

  it('separates devices/channels and flushes counts at shutdown without a timer leak', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const log = createPushFailureLog(emit);
    try {
      log.record('a', 'maker:event', 'BACKPRESSURE');
      log.record('a', 'maker:event', 'BACKPRESSURE');
      log.record('b', 'maker:event', 'BACKPRESSURE');
      log.record('a', 'maker:status-changed', 'NOT_CONNECTED');
      log.flush();
      expect(emit).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.flush(); vi.useRealTimers(); }
  });
});
