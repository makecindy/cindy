import { describe, expect, it, vi } from 'vitest';
import { QuotaWidgetController } from '../widgets/quotaWidgetController';
import { emptyQuotaSnapshot, quotaWindowState, QUOTA_MAX_AGE_MS } from '../widgets/quotaSnapshot';
import type { WidgetQuotaReader } from '../widgets/readWidgetQuota';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const cache = new Map<string, string>();
  const storage = {
    getItem: vi.fn(async (key: string) => cache.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { cache.delete(key); }),
  };
  const native = { writeSnapshot: vi.fn(), clearSnapshot: vi.fn() };
  const revoked = new Set<string>();
  const controller = new QuotaWidgetController(storage, native, id => revoked.has(id));
  const reader: WidgetQuotaReader = {
    listProviders: async () => ({ providers: [{ id: 'openai', connected: true, auth: { method: 'oauth' } }] }),
    getCodexRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 25 } } }),
    getAccountUsage: async () => null, getSubscriptionUsage: async () => null,
  };
  return { cache, storage, native, controller, reader, revoked };
}

describe('quota widget account and cache ownership', () => {
  it('retries stopping sharing after native deletion failed and fences late responses', async () => {
    const { controller, native, reader, cache } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const pending = deferred<unknown>(); reader.getCodexRateLimits = () => pending.promise;
    const read = controller.refresh(reader); await Promise.resolve();
    native.clearSnapshot.mockImplementationOnce(() => { throw new Error('delete failed'); });
    await controller.selectDevice(null);
    expect(controller.getSnapshot()).toMatchObject({ deviceId: null, error: true, clearPending: true });
    native.clearSnapshot.mockClear(); native.writeSnapshot.mockClear();
    await controller.selectDevice(null);
    pending.resolve({ rateLimits: { planType: 'pro', primary: { usedPercent: 1 } } }); await read;
    expect(native.clearSnapshot).toHaveBeenCalledOnce();
    expect(native.writeSnapshot).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ deviceId: null, error: false, clearPending: false });
    expect(JSON.parse([...cache.values()][0])).toMatchObject({ deviceId: null, snapshot: { rows: [] } });
  });

  it('retains a failed provider observation while refreshing other providers', async () => {
    const { controller, reader } = fixture();
    reader.listProviders = async () => ({ providers: [
      { id: 'openai', connected: true, auth: { method: 'oauth' } },
      { id: 'anthropic', connected: true, auth: { method: 'oauth' } },
    ] });
    reader.getSubscriptionUsage = async () => ({ source: 'oauth-endpoint', updatedAt: Date.now(), sevenDay: { utilization: 20 } });
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const before = controller.getSnapshot().snapshot.rows[0];
    reader.getCodexRateLimits = async () => { throw new Error('temporary network failure'); };
    reader.getSubscriptionUsage = async () => ({ source: 'oauth-endpoint', updatedAt: Date.now(), sevenDay: { utilization: 30 } });
    await controller.refresh(reader);
    expect(controller.getSnapshot().snapshot.rows[0]).toEqual(before);
    expect(controller.getSnapshot().snapshot.rows[1].windows[0].remainingPercent).toBe(70);
    expect(controller.getSnapshot().error).toBe(true);
    expect(quotaWindowState(before, before.windows[0], 'online', before.observedAtMs! + QUOTA_MAX_AGE_MS)).toBe('stale');
  });

  it('keeps native-clear retry pending across repeated failures and blocks refresh', async () => {
    const { controller, native, reader } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one');
    native.clearSnapshot.mockImplementation(() => { throw new Error('disk'); });
    await controller.selectDevice(null); await controller.selectDevice(null);
    expect(controller.getSnapshot()).toMatchObject({ deviceId: null, clearPending: true, error: true });
    await controller.selectDevice('two');
    const list = vi.fn(reader.listProviders); reader.listProviders = list;
    await controller.refresh(reader); expect(list).not.toHaveBeenCalled();
    native.clearSnapshot.mockReset(); await controller.selectDevice('two');
    await controller.refresh(reader);
    expect(controller.getSnapshot()).toMatchObject({ deviceId: 'two', clearPending: false, error: false });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('retries private-cache deletion when stopping sharing could not persist', async () => {
    const { controller, storage, cache } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one');
    storage.setItem.mockRejectedValueOnce(new Error('disk'));
    await controller.selectDevice(null);
    expect(controller.getSnapshot()).toMatchObject({ clearPending: true, error: true });
    await controller.selectDevice(null);
    expect(controller.getSnapshot()).toMatchObject({ clearPending: false, error: false });
    expect(JSON.parse([...cache.values()][0]).deviceId).toBeNull();
  });

  it.each(['unauthorized', 'unsupported', 'empty', 'provider', 'device', 'owner', 'cold'])('does not retain a prior allowance across %s boundaries', async boundary => {
    const { controller: initial, reader, storage, native } = fixture();
    let controller = initial;
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    if (boundary === 'provider') reader.listProviders = async () => ({ providers: [{ id: 'other', connected: true, auth: { method: 'oauth', native: 'codex' } }] });
    if (boundary === 'device') await controller.selectDevice('two');
    if (boundary === 'owner') { await controller.setOwner('bob'); await controller.selectDevice('one'); }
    if (boundary === 'cold') { controller = new QuotaWidgetController(storage, native); await controller.setOwner('alice'); }
    reader.getCodexRateLimits = async () => {
      if (boundary === 'empty') return { rateLimits: {} };
      throw new Error(boundary === 'unauthorized' ? 'PRECONDITION_FAILED: reconnect' : boundary === 'unsupported' ? 'unsupported channel' : 'network');
    };
    await controller.refresh(reader);
    expect(controller.getSnapshot().snapshot.rows[0].windows).toEqual([]);
    expect(controller.getSnapshot().snapshot.rows[0].available).toBe(false);
  });

  it('does not revive legacy Codex data after an explicit authorization failure', async () => {
    const { controller, reader } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    reader.getCodexRateLimits = async () => { throw new Error('UNAUTHORIZED'); };
    const legacy = vi.fn(async () => ({ primary: { usedPercent: 1 }, updatedAt: Date.now() }));
    reader.getAccountUsage = legacy;
    await controller.refresh(reader);
    expect(legacy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot.rows[0]).toMatchObject({ status: 'unauthorized', windows: [] });
  });

  it('replaces a retained observation when its provider recovers', async () => {
    const { controller, reader } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    reader.getCodexRateLimits = async () => { throw new Error('network'); };
    await controller.refresh(reader); expect(controller.getSnapshot().error).toBe(true);
    reader.getCodexRateLimits = async () => ({ rateLimits: { primary: { usedPercent: 40 } } });
    await controller.refresh(reader);
    expect(controller.getSnapshot().error).toBe(false);
    expect(controller.getSnapshot().snapshot.rows[0].windows[0].remainingPercent).toBe(60);
  });

  it('rejects a source revoked while its cold-start cache read was pending', async () => {
    const { controller, storage, native, revoked, cache } = fixture();
    const pending = deferred<string | null>();
    const stored = JSON.stringify({ deviceId: 'desktop', snapshot: { ...emptyQuotaSnapshot(), source: 'demo' } });
    cache.set('cindy.quotaWidget.v1.alice', stored);
    storage.getItem.mockImplementationOnce(() => pending.promise);
    const restore = controller.setOwner('alice');
    await Promise.resolve();
    revoked.add('desktop');
    pending.resolve(stored);
    await restore;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, deviceId: null });
    expect(cache.has('cindy.quotaWidget.v1.alice')).toBe(false);
    expect(native.writeSnapshot.mock.calls.every(([json]) => !json.includes('demo'))).toBe(true);
    await controller.selectDevice('desktop');
    expect(controller.getSnapshot().deviceId).toBeNull();
  });

  it('drops a revoked source response even before a UI subscriber has cleared selection', async () => {
    const { controller, reader, native, revoked } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('desktop');
    const pending = deferred<unknown>(); reader.getCodexRateLimits = () => pending.promise;
    const read = controller.refresh(reader); await Promise.resolve();
    revoked.add('desktop'); native.writeSnapshot.mockClear();
    pending.resolve({ rateLimits: { primary: { usedPercent: 5 } } }); await read;
    expect(native.writeSnapshot).not.toHaveBeenCalled();
    expect(controller.getSnapshot().deviceId).toBeNull();
  });

  it('clears native data synchronously on logout and discards a late response', async () => {
    const { controller, native, cache, reader } = fixture();
    await controller.setOwner('global:alice'); await controller.selectDevice('desktop');
    const response = deferred<unknown>(); reader.getCodexRateLimits = () => response.promise;
    const request = controller.refresh(reader);
    await Promise.resolve();
    const clearing = controller.setOwner('');
    expect(native.clearSnapshot).toHaveBeenCalledTimes(3);
    native.writeSnapshot.mockClear();
    response.resolve({ rateLimits: { primary: { usedPercent: 10 } } });
    await Promise.all([request, clearing]);
    expect(native.writeSnapshot).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
    expect(controller.getSnapshot().deviceId).toBeNull();
  });

  it('does not resurrect an old cache whose read finishes after an account switch', async () => {
    const { controller, storage, native } = fixture();
    const pending = deferred<string | null>();
    storage.getItem.mockImplementationOnce(() => pending.promise);
    const alice = controller.setOwner('global:alice');
    await Promise.resolve();
    const bob = controller.setOwner('global:bob');
    native.writeSnapshot.mockClear();
    pending.resolve(JSON.stringify({ deviceId: 'alice-desktop', snapshot: { ...emptyQuotaSnapshot(), source: 'demo' } }));
    await Promise.all([alice, bob]);
    expect(controller.getSnapshot().deviceId).toBeNull();
    expect(native.writeSnapshot.mock.calls.every(([json]) => !json.includes('demo'))).toBe(true);
  });

  it('cancels earlier device reads and persists the new selection', async () => {
    const { controller, reader, native, cache } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one');
    const pending = deferred<unknown>(); reader.getCodexRateLimits = () => pending.promise;
    const read = controller.refresh(reader); await Promise.resolve();
    await controller.selectDevice('two'); native.writeSnapshot.mockClear();
    pending.resolve({ rateLimits: { primary: { usedPercent: 5 } } }); await read;
    expect(native.writeSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse([...cache.values()][0]).deviceId).toBe('two');
  });

  it('keeps the last observation timestamp when the relay drops', async () => {
    const { controller, reader, native } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const observed = controller.getSnapshot().snapshot.rows[0].observedAtMs;
    reader.listProviders = async () => { throw new Error('offline'); };
    await controller.refresh(reader);
    expect(controller.getSnapshot().snapshot.connection).toBe('offline');
    expect(controller.getSnapshot().snapshot.rows[0].observedAtMs).toBe(observed);
    expect(controller.getSnapshot().error).toBe(true);
    expect(JSON.parse(native.writeSnapshot.mock.lastCall![0]).connection).toBe('offline');
  });

  it('ages an inactive phone snapshot without treating redraws or late replies as observations', async () => {
    const { controller, reader } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const observed = controller.getSnapshot().snapshot.rows[0].observedAtMs!;
    const pending = deferred<unknown>(); reader.getCodexRateLimits = () => pending.promise;
    const read = controller.refresh(reader); await Promise.resolve();
    controller.offline();
    pending.resolve({ rateLimits: { primary: { usedPercent: 1 } } }); await read;
    controller.offline();
    const snapshot = controller.getSnapshot().snapshot, row = snapshot.rows[0], window = row.windows[0];
    expect(row.observedAtMs).toBe(observed);
    expect(window.remainingPercent).toBe(75);
    expect(quotaWindowState(row, window, snapshot.connection, observed + QUOTA_MAX_AGE_MS)).toBe('stale');
    expect(quotaWindowState(row, window, snapshot.connection, observed + 24 * 60 * 60_000)).toBe('stale');
  });

  it('restores only the current account cache and marks it offline', async () => {
    const { controller, cache } = fixture();
    cache.set('cindy.quotaWidget.v1.alice', JSON.stringify({ deviceId: 'one', snapshot: { ...emptyQuotaSnapshot(), connection: 'online' } }));
    await controller.setOwner('alice');
    expect(controller.getSnapshot()).toMatchObject({ ready: true, deviceId: 'one', snapshot: { connection: 'offline' } });
    await controller.setOwner('bob');
    expect(cache.has('cindy.quotaWidget.v1.alice')).toBe(false);
    expect(controller.getSnapshot().deviceId).toBeNull();
  });

  it('suspends in-flight reads without hiding fresh cached data or changing its source time', async () => {
    const { controller, reader, native, storage } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const before = controller.getSnapshot().snapshot;
    const pending = deferred<unknown>(); reader.getCodexRateLimits = () => pending.promise;
    const read = controller.refresh(reader); await Promise.resolve();
    native.writeSnapshot.mockClear(); storage.setItem.mockClear();
    controller.suspend();
    pending.resolve({ rateLimits: { primary: { usedPercent: 1 } } }); await read;
    expect(controller.getSnapshot()).toMatchObject({ busy: false, snapshot: before });
    expect(native.writeSnapshot).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    const row = before.rows[0], window = row.windows[0];
    expect(quotaWindowState(row, window, before.connection, row.observedAtMs!)).toBe('fresh');
    expect(quotaWindowState(row, window, before.connection, row.observedAtMs! + QUOTA_MAX_AGE_MS)).toBe('stale');
    reader.getCodexRateLimits = async () => ({ rateLimits: { primary: { usedPercent: 30 } } });
    await controller.refresh(reader);
    expect(controller.getSnapshot().snapshot.rows[0].windows[0].remainingPercent).toBe(70);
    expect(native.writeSnapshot).toHaveBeenCalledOnce();
  });

  it('does not turn a failed suspended read into an offline write', async () => {
    const { controller, reader, native } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one'); await controller.refresh(reader);
    const before = controller.getSnapshot().snapshot;
    const pending = deferred<unknown>(); reader.listProviders = () => pending.promise.then(() => { throw new Error('background disconnect'); });
    const read = controller.refresh(reader);
    native.writeSnapshot.mockClear(); controller.suspend(); pending.resolve(null); await read;
    expect(controller.getSnapshot().snapshot).toEqual(before);
    expect(controller.getSnapshot().error).toBe(false);
    expect(native.writeSnapshot).not.toHaveBeenCalled();
  });

  it('reports failed native clearing and disk persistence instead of claiming success', async () => {
    const { controller, storage, native } = fixture();
    await controller.setOwner('alice');
    native.clearSnapshot.mockImplementation(() => { throw new Error('disk'); });
    storage.setItem.mockRejectedValue(new Error('disk'));
    await controller.selectDevice('one');
    expect(controller.getSnapshot().error).toBe(true);
  });

  it('coalesces concurrent reads and requires an authenticated device selection', async () => {
    const { controller, reader } = fixture();
    const list = vi.fn(reader.listProviders); reader.listProviders = list;
    await controller.refresh(reader); expect(list).not.toHaveBeenCalled();
    await controller.setOwner('alice'); await controller.selectDevice('one');
    await Promise.all([controller.refresh(reader), controller.refresh(reader)]);
    // One read plus its account revalidation, shared by both callers.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('waits for an already started private write before removing its owner cache', async () => {
    const { controller, reader, storage, cache } = fixture();
    await controller.setOwner('alice'); await controller.selectDevice('one');
    const entered = deferred<void>(), release = deferred<void>();
    storage.setItem.mockImplementationOnce(async (key, value) => { entered.resolve(); await release.promise; cache.set(key, value); });
    const refresh = controller.refresh(reader); await entered.promise;
    const logout = controller.setOwner('');
    release.resolve();
    await Promise.all([refresh, logout]);
    expect(cache.has('cindy.quotaWidget.v1.alice')).toBe(false);
  });
});
