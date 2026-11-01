import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startRewoundSchedulerPromptCleanup,
  stopRewoundSchedulerPromptCleanup,
} from '../rewoundSchedulerPromptCleanup.js';

describe('rewound scheduler prompt cleanup', () => {
  afterEach(() => {
    stopRewoundSchedulerPromptCleanup();
    vi.useRealTimers();
  });

  it('walks the cursor across batches, stops when exhausted, and restarts from zero next sweep', async () => {
    vi.useFakeTimers();
    const purge = vi
      .fn()
      .mockResolvedValueOnce({ deleted: 100, cursor: 0 })
      .mockResolvedValueOnce({ deleted: 7, cursor: 5_000 })
      .mockResolvedValueOnce({ deleted: 0, cursor: null })
      .mockResolvedValue({ deleted: 0, cursor: null });
    startRewoundSchedulerPromptCleanup({ purge, firstDelayMs: 30_000, intervalMs: 600_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(purge.mock.calls).toEqual([[100, 0], [100, 0], [100, 5_000]]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(purge).toHaveBeenCalledTimes(4);
    expect(purge).toHaveBeenLastCalledWith(100, 0);
  });

  it('caps one sweep at five batches even when the index is not exhausted', async () => {
    vi.useFakeTimers();
    let next = 0;
    const purge = vi.fn(async (_limit: number, cursor: number) => {
      next = cursor + 500;
      return { deleted: 0, cursor: next };
    });
    startRewoundSchedulerPromptCleanup({ purge, firstDelayMs: 1_000, intervalMs: 600_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(purge).toHaveBeenCalledTimes(5);
    expect(purge).toHaveBeenLastCalledWith(100, 2_000);
  });
});
