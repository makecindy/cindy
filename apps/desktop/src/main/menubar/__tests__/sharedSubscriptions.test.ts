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
  const publications: MenubarSubscriptionInput[][] = [];
  const accessEpochs = new Map<string, number>();
  const read = vi.fn().mockResolvedValue(quota());
  const reader = new SharedQuotaReader({ scope: () => owner, shares: () => shares, read,
    accessEpoch: id => accessEpochs.get(id) ?? 0,
    subscribe: callback => { changed = callback; return () => { changed = () => {}; }; },
    publish: value => { sources = value; publications.push(value); },
  });
  return { reader, read, publications, get sources() { return sources; },
    changeShares(value: ProviderShareReceived[]) { shares = value; changed(); },
    changeOwner() { owner = 'owner:2'; shares = []; changed(); },
    refuseAccess(id = share.shareId, notify = true) {
      accessEpochs.set(id, (accessEpochs.get(id) ?? 0) + 1);
      if (notify) changed();
    },
  };
}

// A three-share pending batch plus two native refresh commands formerly issued nine RPCs.
// Keep the actual request fanout bounded for both the initial read and a periodic read.
it('joins repeated same-identity refreshes to the pending batch and publishes its result', async () => {
  const h = harness();
  h.changeShares([share, { ...share, shareId: 'two' }, { ...share, shareId: 'three' }]);
  const pending: ((value: unknown) => void)[] = [];
  h.read.mockImplementation(() => new Promise(done => { pending.push(done); }));
  try {
    h.reader.setOpen(true);
    h.reader.refresh(); h.reader.refresh();
    expect(h.read).toHaveBeenCalledTimes(3);
    pending.splice(0).forEach(done => done(quota()));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sources).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    h.reader.refresh(); h.reader.refresh();
    expect(h.read).toHaveBeenCalledTimes(6);
    const next = quota(); next.quota!.accounts[0]!.windows[0]!.remainingPercent = 82;
    pending.splice(0).forEach(done => done(next));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sources).toHaveLength(3);
    expect(h.sources.every(source => source.windows[0].usedPercent === 18)).toBe(true);
    h.reader.refresh();
    expect(h.read).toHaveBeenCalledTimes(9);
  } finally {
    h.reader.setOpen(false);
    pending.splice(0).forEach(done => done(quota()));
  }
});

it('starts a new visible lease while an old read is pending and keeps its single flight after the old reply', async () => {
  const h = harness();
  let finishOld!: (value: unknown) => void;
  let finishNew!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { finishOld = done; }))
    .mockImplementationOnce(() => new Promise(done => { finishNew = done; }));
  try {
    h.reader.setOpen(true);
    h.reader.setOpen(false); h.reader.setOpen(true);
    expect(h.read).toHaveBeenCalledTimes(2);
    finishOld(quota());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sources).toEqual([]);
    h.reader.refresh(); h.reader.refresh();
    expect(h.read).toHaveBeenCalledTimes(2);
    finishNew(quota());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sources).toHaveLength(1);
  } finally {
    h.reader.setOpen(false);
    finishOld?.(quota()); finishNew?.(quota());
  }
});

// One fast share can expire while a sibling read is pending. Projection must use the
// final publication time, including reselecting a still-live account from a group.
it.each([false, true])('rechecks weekly validity after the whole batch finishes (fallback=%s)', async fallback => {
  const h = harness();
  const secondShare = { ...share, shareId: 'two' };
  h.changeShares([share, secondShare]);
  const first = quota();
  first.quota!.accounts[0]!.windows[0]!.remainingPercent = 82;
  first.quota!.accounts[0]!.windows[0]!.resetsAt = Date.now() + 1_000;
  if (fallback) {
    first.quota!.group = true;
    first.quota!.accounts.push(quota().quota!.accounts[0]!);
  }
  let finishSlow!: (value: unknown) => void;
  h.read.mockImplementation((id: string) => id === share.shareId
    ? Promise.resolve(first) : new Promise(done => { finishSlow = done; }));
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_000);
  finishSlow(quota());
  await vi.advanceTimersByTimeAsync(0);
  const firstSource = h.sources.find(source => source.id === 'share:one');
  if (fallback) expect(firstSource?.windows[0]?.usedPercent).toBe(54);
  else expect(firstSource).toBeUndefined();
  expect(h.sources.find(source => source.id === 'share:two')).toBeDefined();
  for (const source of h.sources) for (const window of source.windows) {
    expect(window.resetsAtMs === null || window.resetsAtMs > Date.now()).toBe(true);
  }
  h.reader.setOpen(false);
});

it('clears a published quota on access refusal even while the received DTO is unchanged', async () => {
  const h = harness();
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toHaveLength(1);
  h.read.mockRejectedValue(new Error('access denied'));
  const calls = h.read.mock.calls.length;
  h.refuseAccess();
  expect(h.sources).toEqual([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toEqual([]);
  expect(h.read).toHaveBeenCalledTimes(calls);
  h.reader.setOpen(false);
});

it('bounds epoch-only refusal retries and lets healthy siblings publish', async () => {
  const h = harness();
  h.changeShares([share, { ...share, shareId: 'two' }]);
  let refusals = 0;
  h.read.mockImplementation((id: string) => {
    if (id !== share.shareId) return Promise.resolve(quota());
    // Cap the simulated notifications so the pre-fix recursive implementation fails fast.
    if (++refusals <= 4) h.refuseAccess();
    return Promise.reject(new Error('access denied'));
  });
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.sources.map(source => source.id)).toEqual(['share:two']);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(h.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.read).toHaveBeenCalledTimes(4);
  expect(h.sources.map(source => source.id)).toEqual(['share:two']);
  h.reader.setOpen(false);
});

it.each(['failed', 'permission'])('removes a share as soon as its read is %s while a sibling is pending', async kind => {
  const h = harness();
  h.changeShares([share, { ...share, shareId: 'two' }]);
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources).toHaveLength(2);
  let finishSlow!: (value: unknown) => void;
  h.read.mockImplementation((id: string) => id !== share.shareId
    ? new Promise(done => { finishSlow = done; })
    : kind === 'failed' ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ...quota(), capabilities: { quota: false, usage: false } }));
  h.reader.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources.map(source => source.id)).toEqual(['share:two']);
  finishSlow(quota());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources.map(source => source.id)).toEqual(['share:two']);
  h.reader.setOpen(false);
});

it('rechecks access epochs before publishing a fast result held by a slow sibling', async () => {
  const h = harness();
  h.changeShares([share, { ...share, shareId: 'two' }]);
  let denied = false;
  let finishSlow!: (value: unknown) => void;
  const slow = new Promise(done => { finishSlow = done; });
  h.read.mockImplementation((id: string) => id === share.shareId
    ? denied ? Promise.reject(new Error('access denied')) : Promise.resolve(quota()) : slow);
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  denied = true;
  // Omit the notification to independently verify the final-publication guard.
  h.refuseAccess(share.shareId, false);
  finishSlow(quota());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources.map(source => source.id)).toEqual(['share:two']);
  expect(h.publications.flat().some(source => source.id === 'share:one')).toBe(false);
  h.reader.setOpen(false);
});

it.each([false, true])('invalidates published windows locally during a pending refresh (fallback=%s)', async fallback => {
  const h = harness();
  const value = quota();
  value.quota!.accounts[0]!.windows[0]!.remainingPercent = 82;
  value.quota!.accounts[0]!.windows[0]!.resetsAt = Date.now() + 1_000;
  if (fallback) {
    value.quota!.group = true;
    value.quota!.accounts.push(quota().quota!.accounts[0]!);
  }
  h.read.mockResolvedValue(value);
  h.reader.setOpen(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sources[0]?.windows[0]?.usedPercent).toBe(18);
  let finish!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  h.reader.refresh();
  await vi.advanceTimersByTimeAsync(1_000);
  if (fallback) expect(h.sources[0]?.windows[0]?.usedPercent).toBe(54);
  else expect(h.sources).toEqual([]);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.reader.setOpen(false);
  finish(value);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.sources).toEqual([]);
  expect(h.read).toHaveBeenCalledTimes(2);
});

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

it.each(['close', 'owner', 'relationship', 'access'])('drops late responses after %s changes', async kind => {
  const h = harness();
  let resolve!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  h.reader.setOpen(true);
  if (kind === 'close') { h.reader.setOpen(false); h.reader.setOpen(true); }
  if (kind === 'owner') h.changeOwner();
  if (kind === 'relationship') h.changeShares([{ ...share, status: 'paused' }]);
  if (kind === 'access') {
    h.refuseAccess();
  }
  await vi.advanceTimersByTimeAsync(0);
  const before = h.sources;
  resolve(quota());
  await vi.advanceTimersByTimeAsync(0);
  if (kind === 'access') expect(h.sources).toEqual(before);
  else expect(h.sources).toBe(before);
  if (kind !== 'close') expect(h.sources).toEqual([]);
  h.reader.setOpen(false);
});
