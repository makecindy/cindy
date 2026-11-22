import { afterEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import {
  beginNewSessionBackgroundDelivery,
  canDeliverNewSessionInBackground,
  endNewSessionBackgroundDelivery,
} from '@/session/newSessionBackgroundDelivery';
import type { DurableOutboxRecord } from '@/session/durableOutbox';

vi.mock('@/notifications/backgroundWork', () => ({
  beginBackgroundWork: async () => ({ budgetMs: 8_000, end: () => {} }),
}));

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
    else if (endReason === 'receipt') endNewSessionBackgroundDelivery(record);
    else await vi.advanceTimersByTimeAsync(8_000);
    expect(release).toHaveBeenCalledOnce();
    expect(canDeliverNewSessionInBackground(record)).toBe(false);
  },
);
