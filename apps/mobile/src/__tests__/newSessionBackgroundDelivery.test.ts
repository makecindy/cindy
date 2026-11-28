import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  beginNewSessionBackgroundDelivery,
  canDeliverNewSessionInBackground,
  endNewSessionBackgroundDelivery,
} from '@/session/newSessionBackgroundDelivery';
import type { DurableOutboxRecord } from '@/session/durableOutbox';

const native = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ id: 0, remainingMs: 0 })),
  end: vi.fn(async (_id: number) => {}),
  waitUntilEnded: vi.fn(async (_id: number) => {}),
  task: undefined as undefined | (() => (data: { id: number }) => Promise<void>),
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppRegistry: { registerHeadlessTask: (_key: string, task: typeof native.task) => { native.task = task; } },
}));

beforeEach(() => {
  native.begin.mockReset().mockResolvedValue({ id: 0, remainingMs: 0 });
  native.end.mockReset().mockResolvedValue(undefined);
  native.waitUntilEnded.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  setMobileAuthOwner(null);
  vi.useRealTimers();
});

// Unit: a persisted first send can continue after leaving the foreground.
// Cover the gaps in the foreground-only bridge tests: a different message on
// the same task, an expired window, an account change, and a durable receipt.
it.each(['deadline', 'account switch', 'receipt'] as const)(
  'only admits the submitted first message and releases its hold on %s',
  async (endReason) => {
    vi.useFakeTimers();
    setMobileAuthOwner('alice', 'cn');
    const owner = getMobileAuthOwner();
    const release = vi.fn();
    const record = {
      accountId: owner.accountKey, deviceId: 'desktop',
      item: { sessionId: 'task', clientId: 'first' },
    } as DurableOutboxRecord;
    beginNewSessionBackgroundDelivery(owner, 'desktop', 'task', 'first', () => release);
    await Promise.resolve();
    expect(canDeliverNewSessionInBackground(record)).toBe(true);
    expect(canDeliverNewSessionInBackground({ ...record, deviceId: 'other' })).toBe(false);
    expect(canDeliverNewSessionInBackground({
      ...record, item: { ...record.item, clientId: 'second' },
    })).toBe(false);
    if (endReason === 'account switch') setMobileAuthOwner('bob', 'cn');
    else if (endReason === 'receipt') endNewSessionBackgroundDelivery({ ...record, state: 'host-owned', retrySafe: true });
    else await vi.advanceTimersByTimeAsync(8_000);
    expect(release).toHaveBeenCalledOnce();
    expect(canDeliverNewSessionInBackground(record)).toBe(false);
  },
);

// #11841, unit: use the real native adapter and first-send owner fence. The
// previous mocked beginBackgroundWork could not detect Android ignoring its
// native grant. A native task must end on receipt/account change/deadline, and
// a late grant must not revive a completed handoff. Native timer liveness is
// separately exercised on the Xiaomi device; this test does not simulate RN.
it.each(['receipt', 'account switch', 'deadline', 'late grant'] as const)(
  'returns Android execution time after %s', async reason => {
    vi.useFakeTimers();
    setMobileAuthOwner('alice', 'cn');
    const owner = getMobileAuthOwner();
    let grant!: (value: { id: number; remainingMs: number }) => void;
    native.begin.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
    const released = vi.fn();
    const record = { accountId: owner.accountKey, deviceId: 'desktop',
      item: { sessionId: 'native-task', clientId: 'first' } } as DurableOutboxRecord;
    beginNewSessionBackgroundDelivery(owner, 'desktop', 'native-task', 'first', () => released);
    if (reason === 'late grant') endNewSessionBackgroundDelivery({ ...record, state: 'host-owned', retrySafe: true });
    grant({ id: 7, remainingMs: 20_000 });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'receipt') {
      // Receiving enqueue's reply alone is not a durable phone-side receipt.
      endNewSessionBackgroundDelivery({ ...record, state: 'sending' });
      expect(native.end).not.toHaveBeenCalled();
      endNewSessionBackgroundDelivery({ ...record, state: 'host-owned', retrySafe: true });
      endNewSessionBackgroundDelivery({ ...record, state: 'host-owned', retrySafe: true });
    }
    if (reason === 'account switch') setMobileAuthOwner('bob', 'cn');
    if (reason === 'deadline') {
      await vi.advanceTimersByTimeAsync(19_999);
      expect(canDeliverNewSessionInBackground(record)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(native.end).toHaveBeenCalledExactlyOnceWith(7);
    expect(released).toHaveBeenCalledOnce();
    expect(canDeliverNewSessionInBackground(record)).toBe(false);
  },
);

// Unit, #11841: overlapping first sends must release only their own native grant.
it('keeps the second first send alive when the first receipt is persisted', async () => {
  vi.useFakeTimers();
  setMobileAuthOwner('alice', 'cn');
  const owner = getMobileAuthOwner();
  const start = (id: number) => {
    native.begin.mockResolvedValueOnce({ id, remainingMs: 20_000 });
    const item = { sessionId: 'task-' + id, clientId: 'message-' + id };
    const record = { accountId: owner.accountKey, deviceId: 'desktop', item,
      state: 'host-owned', retrySafe: true } as DurableOutboxRecord;
    const release = vi.fn();
    beginNewSessionBackgroundDelivery(owner, record.deviceId, item.sessionId, item.clientId, () => release);
    return { record, release };
  };
  const first = start(1);
  const second = start(2);
  await vi.advanceTimersByTimeAsync(0);
  endNewSessionBackgroundDelivery(first.record);
  expect(native.end).toHaveBeenCalledExactlyOnceWith(1);
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.release).not.toHaveBeenCalled();
  expect(canDeliverNewSessionInBackground(second.record)).toBe(true);
  endNewSessionBackgroundDelivery(second.record);
  expect(native.end.mock.calls).toEqual([[1], [2]]);
  expect(second.release).toHaveBeenCalledOnce();
});

it('keeps the Android headless task pending until native release', async () => {
  let finish!: () => void;
  native.waitUntilEnded.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const settled = vi.fn();
  const task = native.task!()({ id: 8 }).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(native.waitUntilEnded).toHaveBeenCalledExactlyOnceWith(8);
  finish();
  await task;
  expect(settled).toHaveBeenCalledOnce();
});
