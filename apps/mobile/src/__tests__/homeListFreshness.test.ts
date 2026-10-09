import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkPeer, type DeviceLinkRehydrateDeps } from '@/device-link/rehydrate';
import {
  createHomeListFreshness,
  HOME_LIST_FOCUS_REUSE_MAX_MS,
  planHomeListFocusReturn,
} from '@/session/homeListFreshness';
import { remoteSessionStore } from '@/session/remoteSessionStore';

/**
 * Drives the freshness planner the way Home does: a successful full pull marks a device fresh,
 * reseed requests (registered per device, as Home's handler does) invalidate it, and returning
 * to Home refills only the devices the planner reports as stale.
 */
function createHarness(deviceIds: readonly string[]) {
  const freshness = createHomeListFreshness();
  const invoke = vi.fn(async (_deviceId: string, _channel: string) => []);
  const unregister = deviceIds.map((deviceId) => remoteSessionStore.registerReseedHandler(deviceId, () => {
    freshness.invalidate(deviceId);
  }));
  /** Mirrors hydrateDeviceSessionsOnce: capture → list → markFresh (bounded when truncated). */
  const hydrate = async (deviceId: string, beforeResponse?: () => void, truncated = false) => {
    const token = freshness.capture(deviceId);
    await invoke(deviceId, 'local-db:sessions:list');
    beforeResponse?.();
    freshness.markFresh(
      deviceId,
      token,
      truncated ? remoteSessionStore.captureDeviceSessionListMutationEpoch(deviceId) : null,
    );
  };
  const returnHome = async (options: { awayMs?: number; forceFull?: boolean } = {}) => {
    const now = 1_000_000;
    const plan = planHomeListFocusReturn({
      forceFull: options.forceFull ?? false,
      blurredAt: now - (options.awayMs ?? 5_000),
      lastSyncedAt: now - 60_000,
      now,
      deviceIds,
      freshness,
      listMutationEpoch: (deviceId) => remoteSessionStore.captureDeviceSessionListMutationEpoch(deviceId),
    });
    for (const deviceId of plan.kind === 'full' ? deviceIds : plan.deviceIds) await hydrate(deviceId);
    return plan;
  };
  const listCalls = () => invoke.mock.calls.filter(([, channel]) => channel === 'local-db:sessions:list')
    .map(([deviceId]) => deviceId);
  const dispose = () => { for (const off of unregister) off(); };
  cleanups.push(dispose);
  return { freshness, hydrate, invoke, listCalls, returnHome };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** Minimal device-link recovery dependencies: the peer is reachable and every step succeeds. */
function recoveryDeps(): DeviceLinkRehydrateDeps {
  return {
    createDeviceSendCohort: () => 1,
    capturePresenceEpoch: () => 0,
    captureResponseEvidenceEpoch: () => 0,
    isPresenceEpochCurrent: () => true,
    isResponseEvidenceEpochCurrent: () => true,
    openLink: () => ({ capturedPresenceEpoch: 0, capturedResponseEvidenceEpoch: 0, request: Promise.resolve() }),
    subscribe: async () => undefined,
    requestSessionsReseed: (deviceId) => remoteSessionStore.requestReseed(deviceId),
    rebuildSessionSnapshot: async () => undefined,
  };
}

describe('Home list freshness on return', () => {
  it('home → task → back does not re-pull any device list', async () => {
    const home = createHarness(['mac', 'pc']);
    await home.hydrate('mac');
    await home.hydrate('pc');
    home.invoke.mockClear();

    for (let round = 0; round < 3; round += 1) {
      expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: [] });
    }
    expect(home.listCalls()).toEqual([]);
  });

  it('re-pulls only the device whose list asked for a reseed while Home was covered', async () => {
    const home = createHarness(['mac', 'pc']);
    await home.hydrate('mac');
    await home.hydrate('pc');
    home.invoke.mockClear();

    remoteSessionStore.applyRemotePush('pc', 'local-db:sessions:created', {});
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: ['pc'] });
    expect(home.listCalls()).toEqual(['pc']);
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: [] });
  });

  it('re-pulls a device after device-link recovery replays its sessions subscription', async () => {
    // Peer reset, reconnect and foreground return all recover through this replay; it ends with
    // a sessions reseed for that one device only.
    const home = createHarness(['mac', 'pc', 'mini']);
    for (const deviceId of ['mac', 'pc', 'mini']) await home.hydrate(deviceId);
    home.invoke.mockClear();

    await rehydrateDeviceLinkPeer({ deviceId: 'pc', openLink: false, topics: ['sessions'] }, recoveryDeps());
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: ['pc'] });
    expect(home.listCalls()).toEqual(['pc']);
  });

  it('re-pulls a device whose list was cut at the page limit once any list push arrived', async () => {
    // Over LIST_LIMIT tasks: an archive or an outside task's activity changes which tasks belong
    // in the window, which local patches cannot fill in. A complete list keeps reusing patches.
    const home = createHarness(['big', 'small']);
    await home.hydrate('big', undefined, true);
    await home.hydrate('small');
    home.invoke.mockClear();
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: [] });

    for (const deviceId of ['big', 'small']) {
      remoteSessionStore.applyRemotePush(deviceId, 'local-db:sessions:patched', { sessionId: 'old', patch: { status: 'archived' } });
    }
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: ['big'] });
    expect(home.listCalls()).toEqual(['big']);
  });

  it('keeps a device stale when a reseed lands while its list request is in flight', async () => {
    const home = createHarness(['mac']);
    await home.hydrate('mac', () => remoteSessionStore.requestReseed('mac'));
    expect(home.freshness.isFresh('mac')).toBe(false);
  });

  it('falls back to a full reload after background, reconnect or a long stay away', async () => {
    const home = createHarness(['mac', 'pc']);
    await home.hydrate('mac');
    await home.hydrate('pc');
    home.invoke.mockClear();

    expect(await home.returnHome({ forceFull: true })).toEqual({ kind: 'full' });
    expect(await home.returnHome({ awayMs: HOME_LIST_FOCUS_REUSE_MAX_MS })).toEqual({ kind: 'full' });
    expect(home.listCalls()).toEqual(['mac', 'pc', 'mac', 'pc']);

    home.freshness.invalidateAll(); // app went to the background
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: ['mac', 'pc'] });
  });

  it('needs a completed first sync before reusing the mirror', () => {
    const freshness = createHomeListFreshness();
    const input = { forceFull: false, now: 10_000, deviceIds: ['mac'], freshness, listMutationEpoch: () => 0 };
    expect(planHomeListFocusReturn({ ...input, blurredAt: 9_000, lastSyncedAt: null })).toEqual({ kind: 'full' });
    expect(planHomeListFocusReturn({ ...input, blurredAt: null, lastSyncedAt: 1 })).toEqual({ kind: 'full' });
    expect(planHomeListFocusReturn({ ...input, blurredAt: 11_000, lastSyncedAt: 1 })).toEqual({ kind: 'full' });
  });

  it('forgets a device that leaves the sync scope and re-pulls it when it becomes visible again', async () => {
    const home = createHarness(['mac']);
    await home.hydrate('mac');
    home.freshness.invalidate('mac'); // scope release (hidden / offline) invalidates
    home.invoke.mockClear();
    expect(await home.returnHome()).toEqual({ kind: 'refill', deviceIds: ['mac'] });
    expect(home.listCalls()).toEqual(['mac']);
  });

  it('starts over for a new account', async () => {
    const home = createHarness(['mac']);
    await home.hydrate('mac');
    home.freshness.clear();
    expect(home.freshness.isFresh('mac')).toBe(false);
  });
});

describe('Home list sync wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('keeps the visible-device sync scope while Home is covered', () => {
    const scope = source.slice(source.indexOf('const homeSyncDeviceIds = useMemo('), source.indexOf('const homeSyncDeviceIdSet'));
    expect(scope).toContain('resolveHomeDeviceSyncIds(');
    expect(scope).not.toContain('screenFocused');
    // Devices that stop being visible/usable are still released and unsubscribed.
    const reconcile = source.slice(source.indexOf('const reconcileHomeDeviceSyncScope'), source.indexOf('useEffect(() => () => {'));
    expect(reconcile).toMatch(/for \(const deviceId of diff\.release\) \{[\s\S]*homeListFreshnessRef\.current\.invalidate\(deviceId\);[\s\S]*releaseHomeListOwner\(deviceId\);/);
    expect(source).toContain("void unsubscribe(HOME_LIST_SUBSCRIPTION_OWNER, deviceId, ['sessions']).catch(() => undefined);");
  });

  it('records freshness only after a successful list pull and invalidates on failure', () => {
    const hydrate = source.slice(source.indexOf('const hydrateDeviceSessionsOnce = useCallback('), source.indexOf('const hydrateDeviceSessions = useCallback('));
    const capture = hydrate.indexOf('homeListFreshnessRef.current.capture(device.deviceId)');
    const subscribe = hydrate.indexOf("await subscribe(HOME_LIST_SUBSCRIPTION_OWNER, device.deviceId, ['sessions']);");
    const list = hydrate.indexOf("'local-db:sessions:list'");
    const applied = hydrate.indexOf('remoteSessionStore.setDeviceSessions(');
    const fresh = hydrate.indexOf('homeListFreshnessRef.current.markFresh(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(subscribe);
    expect(subscribe).toBeLessThan(list);
    expect(applied).toBeLessThan(fresh);
    expect(hydrate.slice(hydrate.indexOf('} catch (err) {'))).toContain('homeListFreshnessRef.current.invalidate(device.deviceId);');
  });

  it('refills only stale devices on focus return and keeps the full sync for other triggers', () => {
    const focus = source.slice(source.indexOf('const refillStaleHomeDevices = useCallback('), source.indexOf('// 把当前权威设备列表注入 remoteSessionStore'));
    expect(focus).toContain('screenFocusedRef.current = true;');
    expect(focus).toContain('const plan = planHomeListFocusReturn({');
    expect(focus).toMatch(/if \(plan\.kind === 'refill'\) \{\s*refillStaleHomeDevices\(plan\.deviceIds\);\s*if \(scheduleDirty\.size > 0\) refreshHomeScheduleIndexes\(scheduleDirty\);\s*return;\s*\}\s*refreshHomeScheduleIndexes\(\);\s*startSilentHomeSync\(\);/);
    expect(focus).toContain("if (nextState === 'background') homeListFreshnessRef.current.invalidateAll();");
    expect(focus).toContain("if (nextState === 'active') startSilentHomeSync();");
  });

  it('keeps a full-reload request from every full-sync trigger until a loadHome started after it commits', () => {
    // Invariant: any trigger needing a full sync (mount, foreground, reconnect, a full focus return,
    // dependency changes) leaves a request that only a later-started, committed loadHome clears.
    // A sync that fails, is skipped while covered or exits because Home blurred mid-flight keeps it,
    // so a quick return cannot downgrade to a device-row refill and miss bound/unbound computers.
    const silent = source.slice(source.indexOf('const startSilentHomeSync = useCallback(() => {'), source.indexOf('}, [deviceIdentityCacheReady, homeListCacheHydrated'));
    expect(silent.indexOf('requestHomeFullReload();')).toBeGreaterThan(-1);
    expect(silent.indexOf('requestHomeFullReload();')).toBeLessThan(silent.indexOf('if (!screenFocusedRef.current) return;'));
    // Single funnel: no other call site sets the request, nothing but a commit or account reset clears it.
    expect(source.match(/requestHomeFullReload\(\);/g)).toHaveLength(1);
    expect(source.match(/homeFullReloadOnFocusRef\.current = null/g)).toHaveLength(2);
    const focus = source.slice(source.indexOf('useFocusEffect(\n    useCallback(() => {\n      // The focus event'));
    const focusBody = focus.slice(0, focus.indexOf('}, [refillStaleHomeDevices'));
    expect(focusBody).toContain('const forceFull = homeFullReloadOnFocusRef.current !== null;');
    const load = source.slice(source.indexOf('const loadHome = useCallback('), source.indexOf('loadHomeRef.current = loadHome;'));
    expect(load.indexOf('const fullReloadRequestAtStart = homeFullReloadOnFocusRef.current;'))
      .toBeLessThan(load.indexOf('const rawTask = (async () => {'));
    // Blurring after the device-list read exits before the commit, leaving the request in place.
    expect(load.indexOf('if (!screenFocusedRef.current) return;')).toBeLessThan(load.indexOf('lastSyncedAtRef.current = now;'));
    const commit = load.slice(load.indexOf('lastSyncedAtRef.current = now;'));
    expect(commit).toContain('if (homeFullReloadOnFocusRef.current === fullReloadRequestAtStart) homeFullReloadOnFocusRef.current = null;');
  });

  it('refreshes automation badges on return only for devices that sent schedule events while away', () => {
    const events = source.slice(source.indexOf('useEffect(() => remoteScheduleEventStore.subscribe('), source.indexOf('const refreshHomeScheduleIndexes = useCallback('));
    expect(events).toMatch(/if \(!screenFocusedRef\.current\) \{\s*markHomeScheduleIndexDirty\(deviceId\);\s*continue;\s*\}\s*refreshDeviceScheduleIndex\(deviceId, sessionIds\);/);
    // The old unconditional "refresh every device on focus" effect is gone.
    expect(source).not.toContain('兜底刷新一次 scheduleIndex');
    const focus = source.slice(source.indexOf('useFocusEffect(\n    useCallback(() => {\n      // The focus event'));
    expect(focus.indexOf('screenFocusedRef.current = true;')).toBeLessThan(focus.indexOf('refreshHomeScheduleIndexes('));
    expect(focus).toContain('const scheduleDirty = new Set(homeScheduleIndexDirtyRef.current.keys());');
  });

  it('keeps automation badge refreshes pending until one is applied', () => {
    const refresh = source.slice(source.indexOf('const refreshDeviceScheduleIndex = useCallback('), source.indexOf('const hydrateDeviceSessionsOnce = useCallback('));
    // Recorded before the focus gate, so a skipped refresh or a dropped in-flight result is refilled on return.
    expect(refresh.indexOf('const pendingSeq = markHomeScheduleIndexDirty(deviceId);'))
      .toBeLessThan(refresh.indexOf("if (!screenFocusedRef.current || AppState.currentState !== 'active') return;"));
    const apply = refresh.slice(refresh.indexOf('setScheduleIndex((current) => replaceSessionScheduleIndexEntries('));
    expect(apply).toMatch(/if \(homeScheduleIndexDirtyRef\.current\.get\(deviceId\) === pendingSeq\) \{\s*homeScheduleIndexDirtyRef\.current\.delete\(deviceId\);/);
    const hydrate = source.slice(source.indexOf('const hydrateDeviceSessionsOnce = useCallback('), source.indexOf('const hydrateDeviceSessions = useCallback('));
    expect(hydrate.indexOf('markHomeScheduleIndexDirty(device.deviceId);'))
      .toBeLessThan(hydrate.indexOf('scheduleIndexDeferRegistryRef.current.schedule(device.deviceId'));
    expect(hydrate).toContain('nextSessions.length >= LIST_LIMIT');
    expect(hydrate).toContain('remoteSessionStore.captureDeviceSessionListMutationEpoch(device.deviceId)');
  });

  it('marks a device stale whenever its list asks for a reseed, even while Home is covered', () => {
    const reseed = source.slice(source.indexOf('remoteSessionStore.registerReseedHandler(item.device.deviceId'));
    expect(reseed.indexOf('homeListFreshnessRef.current.invalidate(item.device.deviceId);'))
      .toBeLessThan(reseed.indexOf('void hydrateDeviceSessions(item.device, accountGeneration'));
  });

  it('clears freshness with the rest of the account-owned Home state', () => {
    const reset = source.slice(source.indexOf('useLayoutEffect(() => {\n    syncInFlightRef.current = null;'), source.indexOf('}, [accountGeneration]);'));
    expect(reset).toContain('homeListFreshnessRef.current.clear();');
    expect(reset).toContain('homeFullReloadOnFocusRef.current = null;');
    expect(reset).toContain('homeScheduleIndexDirtyRef.current.clear();');
  });
});
