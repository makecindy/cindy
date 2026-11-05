// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteSessionSubscription } from '@/lib/remoteSessionSubscription';

const subscribe = vi.fn(async () => ({ ok: true }));
const unsubscribe = vi.fn(async () => ({ ok: true }));
Object.assign(window, { electronAPI: { deviceLink: { subscribe, unsubscribe } } });
afterEach(() => { subscribe.mockReset().mockResolvedValue({ ok: true }); unsubscribe.mockClear(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

it('keeps a session stream until every history and live-view owner releases it', async () => {
  const first = createRemoteSessionSubscription('mac', 'shared');
  const second = createRemoteSessionSubscription('mac', 'shared');
  const live = createRemoteSessionSubscription('mac', 'shared');
  await Promise.all([first.subscribe(), second.subscribe(), live.subscribe()]);
  first.release(); second.release(); await settle();
  expect(unsubscribe).not.toHaveBeenCalled();
  live.release(); await settle();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:shared']);
});

it('does not let a pending old cleanup remove its replacement during retry', async () => {
  let finish!: (value: { ok: true }) => void;
  subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = createRemoteSessionSubscription('mac', 'retry');
  const pending = old.subscribe();
  old.release();
  const replacement = createRemoteSessionSubscription('mac', 'retry');
  await replacement.subscribe();
  finish({ ok: true }); await pending; await settle();
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
  await replacement.subscribe();
  replacement.release(); await settle();
  expect(unsubscribe).not.toHaveBeenCalled();
  finish({ ok: true }); await pending; await settle();
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith('mac', ['session:slow-ack']);
});
