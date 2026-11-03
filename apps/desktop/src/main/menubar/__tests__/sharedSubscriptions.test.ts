import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import { SharedQuotaReader, sharedSubscription } from '../sharedSubscriptions';
import type { ProviderShareInsights } from '../../../shared/providerShareInsights';
import type { MenubarSubscriptionInput } from '../snapshot';

// Unit: the new visible-panel consumer must honor provider-sharing §7.5. Existing local
// collection tests do not exercise share permission, group ambiguity or close/reopen races.
// Minimal input is one received share with one weekly account; timers are virtual.
const share: ProviderShareReceived = {
  shareId: 'one', memberId: 'member', providerId: 'anthropic', providerLabel: 'Claude',
  deviceName: 'Cindy', hostDeviceId: 'not-disclosed', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true,
};
function quota(): ProviderShareInsights {
  return { version: 1, capabilities: { quota: true, usage: false }, status: { quota: 'ready', usage: 'disabled' },
    usage: null, quota: { group: false, partial: false, accounts: [{ state: 'ready', updatedAt: Date.now(), balance: null,
      windows: [{ kind: 'week', remainingPercent: 46, resetsAt: Date.now() + 60_000, windowMinutes: 10_080, label: null }] }] } };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('maps authorized weekly allowance without leaking identities, balances or reset controls', () => {
  expect(sharedSubscription(share, quota(), Date.now())).toMatchObject({
    id: 'share:one', brand: 'Claude', account: null, credits: null,
    windows: [{ kind: 'week', usedPercent: 54 }],
  });
  expect(sharedSubscription(share, quota(), Date.now())).not.toHaveProperty('device');
});

it.each(['disabled', 'group', 'partial', 'multiple', 'unavailable', 'expired', 'malformed', 'balance'])(
  'does not turn %s data into a single percentage', kind => {
    const value = quota();
    if (kind === 'disabled') value.capabilities.quota = false;
    if (kind === 'group') value.quota!.group = true;
    if (kind === 'partial') value.quota!.partial = true;
    if (kind === 'multiple') value.quota!.accounts.push(value.quota!.accounts[0]!);
    if (kind === 'unavailable') value.quota!.accounts[0]!.state = 'offline';
    if (kind === 'expired') value.quota!.accounts[0]!.windows[0]!.resetsAt = Date.now();
    if (kind === 'malformed') value.quota!.accounts[0]!.windows[0]!.remainingPercent = NaN;
    if (kind === 'balance') value.quota!.accounts[0]!.balance = { remaining: 1, total: 10, currency: 'USD', resetsAt: null, pools: [] };
    expect(sharedSubscription(share, value, Date.now())).toBeNull();
  },
);

function harness() {
  vi.useFakeTimers();
  let owner: string | null = 'owner:1';
  let shares = [share];
  let changed = () => {};
  let sources: MenubarSubscriptionInput[] = [];
  const read = vi.fn().mockResolvedValue(quota());
  const reader = new SharedQuotaReader({ scope: () => owner, shares: () => shares, read,
    subscribe: callback => { changed = callback; return () => { changed = () => {}; }; },
    publish: value => { sources = value; },
  });
  return { reader, read, get sources() { return sources; },
    changeShares(value: ProviderShareReceived[]) { shares = value; changed(); },
    changeOwner() { owner = 'owner:2'; shares = []; changed(); },
  };
}

it('reads only while open, removes revoked/failed quotas, and restores an authorized read', async () => {
  const h = harness();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.read).not.toHaveBeenCalled();
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toHaveLength(1);
  const reading = h.sources;
  h.changeShares([{ ...share }]);
  expect(h.sources).toBe(reading);
  expect(h.read).toHaveBeenCalledTimes(1);
  h.read.mockResolvedValueOnce({ ...quota(), capabilities: { quota: false, usage: false } });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.sources).toEqual([]);
  h.read.mockRejectedValueOnce(new Error('offline'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.sources).toEqual([]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.sources).toHaveLength(1);
  h.reader.setOpen(false);
  expect(h.sources).toEqual([]);
  const count = h.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.read).toHaveBeenCalledTimes(count);
});

it.each(['close', 'owner', 'relationship'])('drops late responses after %s changes', async kind => {
  const h = harness();
  let resolve!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.reader.setOpen(true);
  if (kind === 'close') { h.reader.setOpen(false); h.reader.setOpen(true); }
  if (kind === 'owner') h.changeOwner();
  if (kind === 'relationship') h.changeShares([{ ...share, status: 'paused' }]);
  await vi.advanceTimersByTimeAsync(0);
  const before = h.sources;
  resolve(quota());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toBe(before);
  if (kind !== 'close') expect(h.sources).toEqual([]);
  h.reader.setOpen(false);
});
