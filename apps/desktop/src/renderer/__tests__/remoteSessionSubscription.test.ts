// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteSessionSubscription } from '@/lib/remoteSessionSubscription';

const statusListeners = new Set<(p: { status: 'stopped' | 'connecting' | 'online' }) => void>();
const controlListeners = new Set<(p: { deviceId: string; enabled: boolean }) => void>();
const subscribe = vi.fn(async (_deviceId: string, _topics: string[]) => ({ ok: true as const }));
const unsubscribe = vi.fn(async () => ({ ok: true }));
Object.assign(window, { electronAPI: { deviceLink: { subscribe, unsubscribe,
  onStatusChanged: (cb: (p: { status: 'stopped' | 'connecting' | 'online' }) => void) => { statusListeners.add(cb); return () => { statusListeners.delete(cb); }; },
  onControlTargetChanged: (cb: (p: { deviceId: string; enabled: boolean }) => void) => { controlListeners.add(cb); return () => { controlListeners.delete(cb); }; },
} } });
afterEach(() => { subscribe.mockReset().mockResolvedValue({ ok: true }); unsubscribe.mockClear(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

it('keeps a session stream until every history and live-view owner releases it', async () => {
  const first = createRemoteSessionSubscription('mac', 'shared');
  const second = createRemoteSessionSubscription('mac', 'shared');
  const live = createRemoteSessionSubscription('mac', 'shared');
  await Promise.all([first.subscribe(), second.subscribe(), live.subscribe()]);
  first.release(); second.release(); await settle();
  expect(unsubscribe).not.toHaveBeenCalled();
  live.release();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:shared']);
});

it('does not let a pending old cleanup remove its replacement during retry', async () => {
  let finish!: (value: { ok: true }) => void;
  subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = createRemoteSessionSubscription('mac', 'retry');
  const pending = old.subscribe();
  old.release();
  const replacement = createRemoteSessionSubscription('mac', 'retry');
  const replacementAck = replacement.subscribe();
  finish({ ok: true }); await Promise.all([pending, replacementAck]); await settle();
  expect(unsubscribe).not.toHaveBeenCalled();
  replacement.release(); await settle();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:retry']);
});

it('forwards a fresh recovery subscription without accumulating ownership', async () => {
  const recovering = createRemoteSessionSubscription('mac', 'recovering');
  const otherDevice = createRemoteSessionSubscription('other-mac', 'recovering');
  await recovering.subscribe(); await recovering.subscribe(); await otherDevice.subscribe();
  expect(subscribe).toHaveBeenCalledTimes(3);
  recovering.release(); recovering.release(); await settle();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:recovering']);
  otherDevice.release(); await settle();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});


it('waits for older pending acquisitions before cleaning up the final replacement', async () => {
  let finish!: (value: { ok: true }) => void;
  subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = createRemoteSessionSubscription('mac', 'slow-ack');
  const pending = old.subscribe();
  old.release();
  const replacement = createRemoteSessionSubscription('mac', 'slow-ack');
  const replacementAck = replacement.subscribe();
  // Recovery may finish before the older shared acquisition settles.
  await replacement.subscribe();
  replacement.release(); await settle();
  expect(unsubscribe).not.toHaveBeenCalled();
  finish({ ok: true }); await Promise.all([pending, replacementAck]); await settle();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:slow-ack']);
});

// PR #8979 / unit: the production entry must share a slow first ACK across
// history owners. Existing tests covered release ownership, not request fan-out.
// Two owners already duplicate control traffic; 100 represents a history page
// exceeding the transport's 64-message capacity. No network or real timers.
it('shares the first ACK and settled subscription across a page of history owners', async () => {
  let finish!: (value: { ok: true }) => void;
  subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const owners = Array.from({ length: 100 }, () => createRemoteSessionSubscription('mac', 'history-page'));
  const pending = owners.map(owner => owner.subscribe());
  try {
    expect(subscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:history-page']);
    expect(pending.every(ack => ack === pending[0])).toBe(true);
    finish({ ok: true });
    await Promise.all(pending);
    const later = createRemoteSessionSubscription('mac', 'history-page');
    try {
      await later.subscribe();
      expect(subscribe).toHaveBeenCalledTimes(1);
    } finally { later.release(); }
  } finally {
    finish({ ok: true });
    await Promise.all(pending);
    owners.forEach(owner => owner.release());
  }
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:history-page']);
});

// PR #8979 / unit: a failed shared ACK must not poison later history retries.
// Existing recovery tests only repeat the same owner; this mounts a new owner.
it('lets a new owner retry after the shared subscription fails', async () => {
  const unavailable = new Error('device offline');
  subscribe.mockRejectedValueOnce(unavailable);
  const first = createRemoteSessionSubscription('mac', 'failed-ack');
  const retry = createRemoteSessionSubscription('mac', 'failed-ack');
  try {
    await expect(first.subscribe()).rejects.toBe(unavailable);
    await expect(retry.subscribe()).resolves.toBeUndefined();
    expect(subscribe).toHaveBeenCalledTimes(2);
  } finally { first.release(); retry.release(); }
});

// PR #8979 / unit: an older rejected ACK cannot evict a newer recovery ACK.
// Unlike the failed-first case, two subscription generations overlap here.
it('keeps the newer recovery ACK when an older acquisition fails late', async () => {
  let fail!: (error: Error) => void;
  let finish!: (value: { ok: true }) => void;
  subscribe.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const live = createRemoteSessionSubscription('mac', 'recovery-race');
  const history = createRemoteSessionSubscription('mac', 'recovery-race');
  const old = live.subscribe();
  const failed = expect(old).rejects.toThrow('old link closed');
  subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const fresh = live.subscribe();
  try {
    fail(new Error('old link closed'));
    await failed;
    const shared = history.subscribe();
    expect(shared).toBe(fresh);
    expect(subscribe).toHaveBeenCalledTimes(2);
    finish({ ok: true });
    await Promise.all([fresh, shared]);
  } finally {
    finish({ ok: true });
    await fresh;
    live.release(); history.release();
  }
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:recovery-race']);
});

// PR #8979: Main drops its window topic references on relay teardown, but a
// readable collapsed history remains mounted. Its old ACK cannot survive that.
it.each(['relay', 'device'])('reacquires one shared ACK after Main resets the %s subscription', async reset => {
  const refs = await import('../../main/device-link/subscriptionRefcount');
  refs.resetAll();
  subscribe.mockImplementation(async (deviceId, topics) => { refs.recordSubscribe(1, deviceId, topics); return { ok: true }; });
  const owners = [createRemoteSessionSubscription('mac', 'relay-reset'), createRemoteSessionSubscription('mac', 'relay-reset')];
  try {
    await Promise.all(owners.map(owner => owner.subscribe()));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(refs.snapshotSubscriptions()).toEqual([{ deviceId: 'mac', topics: ['session:relay-reset'] }]);
    controlListeners.forEach(cb => cb({ deviceId: 'other-mac', enabled: false }));
    await owners[0].subscribe({ reuse: true });
    expect(subscribe).toHaveBeenCalledTimes(1);
    if (reset === 'relay') {
      refs.resetAll();
      statusListeners.forEach(cb => cb({ status: 'stopped' }));
      statusListeners.forEach(cb => cb({ status: 'connecting' }));
      statusListeners.forEach(cb => cb({ status: 'online' }));
    } else {
      refs.resetDevice('mac');
      controlListeners.forEach(cb => cb({ deviceId: 'mac', enabled: false }));
      controlListeners.forEach(cb => cb({ deviceId: 'mac', enabled: true }));
    }
    const later = createRemoteSessionSubscription('mac', 'relay-reset');
    owners.push(later);
    await later.subscribe();
    await Promise.all(owners.map(owner => owner.subscribe({ reuse: true })));
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(refs.snapshotSubscriptions()).toEqual([{ deviceId: 'mac', topics: ['session:relay-reset'] }]);
    await owners[0].subscribe({ reuse: true });
    expect(subscribe).toHaveBeenCalledTimes(2);
  } finally { owners.forEach(owner => owner.release()); refs.resetAll(); }
  expect(statusListeners.size).toBe(0);
  expect(controlListeners.size).toBe(0);
});
