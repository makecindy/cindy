import { afterEach, describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkPeer, type DeviceLinkRehydrateDeps } from '@/device-link/rehydrate';
import {
  createHomeInstalledRows,
  createHomeListFreshness,
  createHomeRefreshRequests,
  HOME_LIST_FOCUS_REUSE_MAX_MS,
  planHomeListFocusReturn,
} from '@/session/homeListFreshness';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

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
    for (const deviceId of ['big', 'small']) {
      // These are known rows from a completed pull. An unseen child removal must
      // instead request a reseed so host-owned side-chat lists can refresh.
      remoteSessionStore.upsertDeviceSession(deviceId, deviceId, {
        id: 'old', status: 'active', title: 'old', source: 'desktop',
        createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
      } as RemoteSession);
    }
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

  it('refills missed background pushes without a directory reload, but fully reloads after reconnect or a long absence', async () => {
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

// Unit / review: source-string checks could not detect consumption of a newer
// full refresh or automation event by a late older round. Exercise the production intent owner.
it('keeps newer full refresh intent through an old commit and an unsuccessful read', () => {
  const requests = createHomeRefreshRequests();
  requests.requestFull();
  const old = requests.captureFull();
  requests.requestFull();
  const latest = requests.captureFull();
  requests.completeFull(old);
  expect(requests.captureFull()).toBe(latest);
  // A failed/superseded read does not complete the token: returning Home still needs full work.
  const plan = planHomeListFocusReturn({ forceFull: requests.captureFull() !== null,
    blurredAt: 900, now: 1000, lastSyncedAt: 800, deviceIds: [],
    freshness: createHomeListFreshness(), listMutationEpoch: () => 0 });
  expect(plan).toEqual({ kind: 'full' });
  requests.completeFull(latest);
  expect(requests.captureFull()).toBeNull();
});

it('selects only dirty automation indexes and cannot consume a later event with an old reply', () => {
  const requests = createHomeRefreshRequests();
  const old = requests.markScheduleDirty('pc');
  expect([...requests.scheduleDeviceIds()]).toEqual(['pc']); // healthy mac is not reread
  const latest = requests.markScheduleDirty('pc');
  requests.completeSchedule('pc', old);
  expect([...requests.scheduleDeviceIds()]).toEqual(['pc']);
  requests.completeSchedule('pc', latest);
  expect([...requests.scheduleDeviceIds()]).toEqual([]);
});

it('clears account-owned intent and prevents old freshness tokens from reviving it', () => {
  const requests = createHomeRefreshRequests();
  const freshness = createHomeListFreshness();
  requests.requestFull();
  requests.markScheduleDirty('old-account-pc');
  const token = freshness.capture('old-account-pc');
  requests.clear();
  freshness.clear();
  freshness.markFresh('old-account-pc', token);
  expect(requests.captureFull()).toBeNull();
  expect([...requests.scheduleDeviceIds()]).toEqual([]);
  expect(freshness.isFresh('old-account-pc')).toBe(false);
});

// Review #9752: enrichment now lands after Home marks the list fresh and arms the automation
// index. A raw list under the limit plus a capped history-only page must still behave as
// truncated, and history-only lanes must enter the index scope without a redundant reread.
describe('history enrichment installed after the list is ready', () => {
  const rows = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));

  it('re-pulls after a list push once enrichment fills the page limit', () => {
    remoteSessionStore.upsertDeviceSession('old-desktop', 'old-desktop', {
      id: 'raw0', status: 'active', title: 'raw0', source: 'desktop',
      createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    } as RemoteSession);
    const freshness = createHomeListFreshness();
    const epoch = () => remoteSessionStore.captureDeviceSessionListMutationEpoch('old-desktop');
    const token = freshness.capture('old-desktop');
    const installed = createHomeInstalledRows({
      limit: 200,
      onBounded: () => freshness.markBounded('old-desktop', token, epoch()),
      onScheduleScopeGrew: () => undefined,
    });
    installed.install(rows('raw', 120));
    freshness.markFresh('old-desktop', token, installed.markFresh(120) ? epoch() : null);
    installed.install([...rows('raw', 120), ...rows('lane', 200)]);
    expect(freshness.isFresh('old-desktop', epoch())).toBe(true);

    remoteSessionStore.applyRemotePush('old-desktop', 'local-db:sessions:patched', { sessionId: 'raw0', patch: { status: 'archived' } });
    expect(freshness.isFresh('old-desktop', epoch())).toBe(false);
  });

  it('rereads the automation index only when enrichment adds rows outside its scope', () => {
    const refreshes: string[][] = [];
    const installed = createHomeInstalledRows({
      limit: 200,
      onBounded: () => undefined,
      onScheduleScopeGrew: () => refreshes.push([...installed.sessionIds()]),
    });
    installed.install(rows('raw', 2));
    installed.armSchedule();
    installed.install(rows('raw', 2)); // a current Desktop already lists every lane
    expect(refreshes).toEqual([]);
    installed.install([...rows('raw', 2), { id: 'routine-lane' }]);
    expect(refreshes).toEqual([['raw0', 'raw1', 'routine-lane']]);
  });
});
