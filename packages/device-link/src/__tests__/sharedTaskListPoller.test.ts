import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startSharedTaskListPoller } from '../sharedTaskListPoller.js';

// Guards the request budget of the guest directory that every signed-in
// Desktop and phone runs; a 5 s fixed poll here overloaded auth on 2026-10-22.
let visible: boolean;
let poll: ReturnType<typeof vi.fn<(read: { fresh: boolean }) => Promise<number | null>>>;
const reads = () => poll.mock.calls.length;
beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  poll = vi.fn(async () => 0);
});
afterEach(() => { vi.useRealTimers(); });

it('reads every 60 s while empty, every 30 s with shares, and keeps the cadence on failure', async () => {
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(reads()).toBe(1);
  poll.mockResolvedValue(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(reads()).toBe(2);
  poll.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reads()).toBe(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reads()).toBe(4);
  poller.dispose();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reads()).toBe(4);
});

it('pauses while hidden and rereads on return only when the last read is stale', async () => {
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  await vi.advanceTimersByTimeAsync(0);
  visible = false; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(reads()).toBe(1);
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(2);
  // A quick focus bounce reuses the fresh read and keeps the timer.
  visible = false; poller.visibilityChanged();
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(reads()).toBe(3);
  poller.dispose();
});

it('does not start hidden, and a refresh while hidden reads on return even after a recent read', async () => {
  visible = false;
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reads()).toBe(0);
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(1);
  visible = false; poller.visibilityChanged();
  poller.refresh();
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(2);
  // A clock set backwards does not suppress the read on return either.
  visible = false; poller.visibilityChanged();
  vi.setSystemTime(Date.now() - 3_600_000);
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(3);
  poller.dispose();
});

it('runs a refresh requested during a read once more after it, never concurrently', async () => {
  let finish!: (count: number) => void;
  poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  poller.refresh(); poller.refresh();
  expect(reads()).toBe(1);
  finish(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(2);
  expect(poll.mock.calls.map(([read]) => read.fresh)).toEqual([false, true]);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(reads()).toBe(2);
  poller.dispose();
});

it('defers a refresh owed by an in-flight read until the app returns to the foreground', async () => {
  let finish!: (count: number) => void;
  poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  poller.refresh();
  visible = false; poller.visibilityChanged();
  finish(0);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(reads()).toBe(1);
  visible = true; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(reads()).toBe(2);
  expect(poll.mock.calls[1][0]).toEqual({ fresh: true });
  poller.dispose();
});

it('rereads right after a read that was still in flight across a background period', async () => {
  let finish!: (count: number) => void;
  poll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const poller = startSharedTaskListPoller({ poll, isVisible: () => visible });
  visible = false; poller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(30_000);
  visible = true; poller.visibilityChanged();
  expect(reads()).toBe(1);
  finish(0);
  await vi.advanceTimersByTimeAsync(0);
  // The pre-background snapshot is not trusted; the return is paid at once.
  expect(reads()).toBe(2);
  poller.dispose();
});
