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
