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

  it('deletes hidden scheduler prompts in bounded batches and then stops', async () => {
    vi.useFakeTimers();
    const purge = vi
      .fn()
      .mockResolvedValueOnce({ deleted: 100 })
      .mockResolvedValueOnce({ deleted: 40 })
      .mockResolvedValue({ deleted: 0 });
    startRewoundSchedulerPromptCleanup({ purge, firstDelayMs: 30_000, intervalMs: 600_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenNthCalledWith(1, 100);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(purge).toHaveBeenCalledTimes(3);
  });
});
