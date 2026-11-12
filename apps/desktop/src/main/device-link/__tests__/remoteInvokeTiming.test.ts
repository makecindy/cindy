import { expect, it, vi } from 'vitest';
import { RemoteInvokeTiming, observeRemoteInvoke } from '../remoteInvokeTiming';
it('records failed stages without changing the error and separates subsequent work', async () => {
  let now = 0;
  const timing = new RemoteInvokeTiming(() => now);
  const failure = new Error('private');
  await expect(timing.measure('authorizeBefore', async () => { now += 125; throw failure; })).rejects.toBe(failure);
  expect(await timing.measure('handler', async () => { now += 250; return 42; })).toBe(42);
  expect(timing.stages).toEqual({ authorizeBefore: 125, handler: 250 });
  expect(JSON.stringify(timing)).not.toContain('private');
});

// Unit: a hanging handler used to produce no stage evidence at default INFO.
it('reports the live stage before completion and preserves the eventual result', async () => {
  vi.useFakeTimers();
  try {
    const report = vi.fn();
    const timing = new RemoteInvokeTiming();
    const finish = observeRemoteInvoke(timing, report);
    let resolve!: (value: number) => void;
    const result = timing.measure('handler', () => new Promise<number>(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenCalledExactlyOnceWith({ outcome: 'waiting', executionMs: 5000,
      activeStage: 'handler', stagesMs: {} });
    resolve(42); expect(await result).toBe(42); finish();
    expect(report.mock.calls.at(-1)?.[0]).toEqual({ outcome: 'settled', executionMs: 5000,
      activeStage: null, stagesMs: { handler: 5000 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
