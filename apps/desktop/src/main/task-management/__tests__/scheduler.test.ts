import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTaskArchiveScheduler } from '../scheduler.js';
import { TASK_ARCHIVE_DAY_MS as DAY } from '../../../shared/taskManagement.js';

// #10310 startup/performance follow-up, unit: engine tests cannot cover timer
// ownership or coalesced settings/wake events. Minimal input: one ready UI and
// a trigger during its grace period or while the previous scan is still running.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function fixture() {
  let flight = Promise.resolve();
  const check = vi.fn(async (_force: boolean) => {
    await flight;
  });
  const scheduler = createTaskArchiveScheduler({
    check,
    settled: () => flight,
    invalidate: vi.fn(),
    warn: vi.fn(),
  });
  return {
    scheduler,
    check,
    block() {
      let release!: () => void;
      flight = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it('coalesces settings changes during startup without resetting or bypassing the grace period', async () => {
  const f = fixture();
  f.scheduler.request();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.check).not.toHaveBeenCalled();
  f.scheduler.setReady(true);
  await vi.advanceTimersByTimeAsync(20_000);
  f.scheduler.request();
  f.scheduler.request();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.check).toHaveBeenCalledExactlyOnceWith(true);
  await vi.advanceTimersByTimeAsync(DAY);
  expect(f.check.mock.calls.map(([force]) => force)).toEqual([true, false]);
});

it('does not revive an old timer or a queued check after shutdown/account changes', async () => {
  const f = fixture();
  const release = f.block();
  f.scheduler.setReady(true);
  await vi.advanceTimersByTimeAsync(30_000);
  f.scheduler.setReady(false);
  release();
  await vi.advanceTimersByTimeAsync(DAY);
  expect(f.check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.scheduler.setReady(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.check).toHaveBeenCalledOnce();
});

it('waits for a previous scan and combines repeated requests into one follow-up', async () => {
  const f = fixture();
  f.scheduler.setReady(true);
  await vi.advanceTimersByTimeAsync(30_000);
  const release = f.block();
  f.scheduler.request();
  await vi.advanceTimersByTimeAsync(1);
  f.scheduler.request();
  f.scheduler.request();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.check).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.check.mock.calls.map(([force]) => force)).toEqual([false, true]);
  expect(vi.getTimerCount()).toBe(1);
});

it('runs a later daily check after an interrupted scan without retrying in a tight loop', async () => {
  const f = fixture();
  f.check.mockRejectedValueOnce(new Error('database unavailable'));
  f.scheduler.setReady(true);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(DAY - 1);
  expect(f.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.check).toHaveBeenCalledTimes(2);
});
