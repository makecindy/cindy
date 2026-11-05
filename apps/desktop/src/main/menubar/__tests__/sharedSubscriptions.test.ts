import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import { SharedQuotaReader, sharedSubscription } from '../sharedSubscriptions';
import type { ProviderShareInsights } from '../../../shared/providerShareInsights';
import type { MenubarSubscriptionInput } from '../snapshot';

// Unit: the new visible-panel consumer must honor provider-sharing §7.5. Existing local
// collection tests do not exercise share permission, multi-account selection or close/reopen races.
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
    shared: { label: 'Owner', ownerName: 'Owner' },
    windows: [{ kind: 'week', usedPercent: 54 }],
  });
  expect(sharedSubscription(share, quota(), Date.now())).not.toHaveProperty('device');
});

it.each(['disabled', 'unavailable', 'expired', 'malformed', 'balance'])(
  'does not turn %s data into a single percentage', kind => {
    const value = quota();
    if (kind === 'disabled') value.capabilities.quota = false;
    if (kind === 'unavailable') value.quota!.accounts[0]!.state = 'offline';
    if (kind === 'expired') value.quota!.accounts[0]!.windows[0]!.resetsAt = Date.now();
    if (kind === 'malformed') value.quota!.accounts[0]!.windows[0]!.remainingPercent = NaN;
    if (kind === 'balance') value.quota!.accounts[0]!.balance = { remaining: 1, total: 10, currency: 'USD', resetsAt: null, pools: [] };
    expect(sharedSubscription(share, value, Date.now())).toBeNull();
  },
);

// User's 2026-11-05 example: 82% vs 28%. The winning account must supply every detail,
// even when the other account has a higher short-window allowance or resets sooner.
it.each([false, true])('selects the highest readable weekly account without mixing its details (partial=%s)', partial => {
  const value = quota();
  const first = value.quota!.accounts[0]!;
  first.windows[0]!.remainingPercent = 28;
  first.windows.push({ kind: 'session', remainingPercent: 99, resetsAt: Date.now() + 30_000, windowMinutes: 300, label: null });
  const winner = { ...first, updatedAt: Date.now() - 1_000, windows: [
    { ...first.windows[0]!, remainingPercent: 82, resetsAt: Date.now() + 120_000 },
    { ...first.windows[1]!, remainingPercent: 90 },
  ] };
  value.quota = { group: true, partial, accounts: [first, winner] };
  expect(sharedSubscription(share, value, Date.now())).toMatchObject({
    updatedAtMs: winner.updatedAt, shared: { highestWeekly: true },
    windows: [{ kind: 'week', usedPercent: 18, resetsAtMs: winner.windows[0]!.resetsAt },
      { kind: 'session', usedPercent: 10 }],
  });
});

it('ignores unavailable, expired and balance accounts even when their percentage is higher', () => {
  const value = quota();
  const account = value.quota!.accounts[0]!;
  const high = { ...account, windows: [{ ...account.windows[0]!, remainingPercent: 99 }] };
  value.quota = { group: true, partial: true, accounts: [
    { ...high, state: 'offline' },
    { ...high, windows: [{ ...high.windows[0]!, resetsAt: Date.now() }] },
    { ...high, balance: { remaining: 99, total: 100, currency: 'USD', resetsAt: null, pools: [] } },
    account,
  ] };
  expect(sharedSubscription(share, value, Date.now())?.windows[0]?.usedPercent).toBe(54);
  value.quota.accounts.pop();
  expect(sharedSubscription(share, value, Date.now())).toBeNull();
});

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

it('reselects the weekly maximum on refresh without retaining the former account details', async () => {
  const h = harness();
  const value = quota();
  const first = value.quota!.accounts[0]!;
  const second = { ...first, windows: [{ ...first.windows[0]!, remainingPercent: 82, resetsAt: Date.now() + 120_000 }] };
  value.quota = { group: true, partial: false, accounts: [first, second] };
  h.read.mockResolvedValue(value);
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources[0]?.windows[0]).toMatchObject({ usedPercent: 18, resetsAtMs: second.windows[0]!.resetsAt });
  second.windows[0]!.remainingPercent = 20;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(h.sources[0]?.windows[0]).toMatchObject({ usedPercent: 54, resetsAtMs: first.windows[0]!.resetsAt });
  h.reader.setOpen(false);
});

// Regression: removing the source for even one publication makes the native detail page
// return to main. A same-identity refresh must keep it until the new result is available.
it('keeps the source during a manual refresh and replaces it when the read completes', async () => {
  const h = harness();
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  const previous = h.sources;
  let resolve!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.reader.refresh();
  expect(h.sources).toBe(previous);
  const next = quota();
  next.quota!.accounts[0]!.windows[0]!.remainingPercent = 82;
  resolve(next);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources[0]?.windows[0]?.usedPercent).toBe(18);
  h.reader.setOpen(false);
});

it.each(['failed', 'permission'])('clears a preserved reading after a manual refresh is %s', async kind => {
  const h = harness();
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  const previous = h.sources;
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  h.read.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  h.reader.refresh();
  expect(h.sources).toBe(previous);
  if (kind === 'failed') reject(new Error('offline'));
  else resolve({ ...quota(), capabilities: { quota: false, usage: false } });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toEqual([]);
  h.reader.setOpen(false);
});

it.each(['owner', 'relationship'])('clears a populated reading immediately on %s change during refresh', async kind => {
  const h = harness();
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  let resolve!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.reader.refresh();
  expect(h.sources).toHaveLength(1);
  if (kind === 'owner') h.changeOwner();
  else h.changeShares([{ ...share, status: 'paused' }]);
  expect(h.sources).toEqual([]);
  resolve(quota());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toEqual([]);
  h.reader.setOpen(false);
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
