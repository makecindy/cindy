import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostConnectionState } from '@cindy/maker-shared/host-event-stream';
import { observeHostRecovery } from '@/lib/hostConnectionRecovery';

// Unit: real recovery observer, controllable read completion and fake clocks.
// Regression: a second disconnect must fence old snapshots; successful event
// replay must not poll/reload the page or repeat input mutations.
// Measured with hostDelegation: 20 cases, < 1 s total, 4 ms observer tests.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup(recover: (current: () => boolean) => Promise<void>) {
  let notify!: (state: HostConnectionState) => void;
  const api = { onStateChanged: (cb: typeof notify) => { notify = cb; return vi.fn(); }, retry: vi.fn() };
  const view = vi.fn();
  const observer = observeHostRecovery({ api, recover, onView: view });
  const state = (status: HostConnectionState['status'], connection = 1, recovery = 1) => notify({ status, connection, recovery });
  return { observer, api, view, state };
}

it('retries failed reads, coalesces signals, and does nothing after complete replay', async () => {
  const recover = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const h = setup(recover);
  h.state('connected'); h.state('connected'); await flush();
  expect(h.view.mock.lastCall?.[0]).toMatchObject({ failed: true, restoring: false });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(recover).toHaveBeenCalledTimes(2);
  h.state('disconnected'); h.state('connected', 2); await flush();
  expect(recover).toHaveBeenCalledTimes(2);
  h.observer.dispose();
});

it('invalidates an old recovery immediately and finishes the newer connection independently', async () => {
  const pending: { current: () => boolean; resolve: () => void }[] = [];
  const h = setup(current => new Promise<void>(resolve => pending.push({ current, resolve })));
  h.state('connected');
  h.observer.retry(); // A stuck snapshot can be interrupted through the transport.
  expect(h.api.retry).toHaveBeenCalledOnce();
  h.state('disconnected');
  expect(pending[0].current()).toBe(false);
  h.state('connected', 2, 2);
  pending[0].resolve(); await flush();
  expect(h.view.mock.lastCall?.[0].restoring).toBe(true);
  pending[1].resolve(); await flush();
  expect(h.view.mock.lastCall?.[0]).toMatchObject({ restoring: false, failed: false });
  h.observer.dispose();
});

it('does not read while authorization is required and cancels all work on disposal', async () => {
  const recover = vi.fn().mockRejectedValue(new Error('unavailable'));
  const h = setup(recover);
  h.state('authorization-required'); await flush();
  expect(recover).not.toHaveBeenCalled();
  h.observer.retry(); expect(h.api.retry).toHaveBeenCalledOnce();
  h.state('connected', 2, 2); await flush();
  h.observer.dispose(); await vi.advanceTimersByTimeAsync(10_000);
  expect(recover).toHaveBeenCalledOnce();
});
