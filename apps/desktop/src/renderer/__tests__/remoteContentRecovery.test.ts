import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteContentRecovery } from '../features/cc-agent/hooks/remoteContentRecovery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe('remote content recovery', () => {
  it('waits for both subscription ACK and an applied snapshot, coalescing triggers', async () => {
    vi.useFakeTimers();
    const ack = deferred<void>();
    const snapshot = deferred<boolean>();
    const changed = vi.fn();
    const reconcile = vi.fn(() => snapshot.promise);
    const subscribe = vi.fn(() => ack.promise);
    const recovery = createRemoteContentRecovery({
      subscribe,
      reconcile,
      changed,
      completed: vi.fn(),
    });
    recovery.request();
    recovery.request();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    ack.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalledWith('ready');
    snapshot.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledWith('ready');
    recovery.dispose();
  });

  it('retries rejected subscriptions and skipped snapshots without claiming success', async () => {
    vi.useFakeTimers();
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(undefined);
    const reconcile = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const changed = vi.fn();
    const recovery = createRemoteContentRecovery({
      subscribe,
      reconcile,
      changed,
      completed: vi.fn(),
      retryMs: 10,
    });
    recovery.request();
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).not.toHaveBeenCalledWith('ready');
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(changed).toHaveBeenCalledWith('ready');
    recovery.dispose();
  });

  it('discards an old snapshot after disconnect and retries only when online again', async () => {
    vi.useFakeTimers();
    const old = deferred<boolean>();
    const current = deferred<boolean>();
    const reconcile = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => current.promise);
    const changed = vi.fn();
    const recovery = createRemoteContentRecovery({
      subscribe: async () => {},
      reconcile,
      changed,
      completed: vi.fn(),
    });
    recovery.request();
    await vi.advanceTimersByTimeAsync(0);
    recovery.invalidate(false);
    old.resolve(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).not.toHaveBeenCalledWith('ready');
    expect(reconcile).toHaveBeenCalledTimes(1);
    recovery.invalidate(true);
    recovery.request();
    await vi.advanceTimersByTimeAsync(0);
    recovery.dispose();
    current.resolve(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).not.toHaveBeenCalledWith('ready');
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
