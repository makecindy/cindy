// @vitest-environment jsdom
/** Regression: a permanent catalog failure must retire the mounted rows instead of
 * leaving a retained display snapshot on screen. */
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';
import { PROVIDER_METADATA_TRUST_MS } from '../../../../../packages/device-link/src/metadataContinuity';
import type { ProviderView } from '@cindy/model-providers';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { refreshProviderShareFavoriteMembership, refreshProviderShareReceived, resetProviderShareStoreForTests, useProviderShareReceived } from '@/features/provider-share/providerShareStore';
import { invalidateRemoteCatalogSnapshots, refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';
import * as providers from '@/hooks/useDeviceProviders';
import {
  evictAllRemoteCapabilities,
  evictDeviceCapabilities,
  getCachedCapabilities,
  prefetchDeviceCapabilities,
  useAgentCapabilities,
} from '@/hooks/useAgentCapabilities';
import { CONTROLLED_MODEL_CATALOG_CHANNEL, modelCatalogKey } from '../../shared/controlledModelCatalog';
import { useControlledModelLocations } from '@/hooks/useControlledModelLocations';
import type { ProviderShareReceivedSnapshot, ProviderShareRegionBudget } from '../../shared/providerShare';

// This mounted fixture uses empty model lists and does not exercise the full
// catalog package. Keep the real store/hook; only avoid loading the unrelated
// catalog graph for every share-lifecycle case. Catalog behavior has its own tests.
vi.mock('@cindy/model-providers', () => ({ defaultEffortForCapabilities: () => null }));

// Load the real SDK submodules used by this mounted graph instead of the root
// index's unused client/transport assembly. The root export wiring is covered by
// SDK build/typechecks; this file still uses the actual helpers below.
vi.mock('@cindy/device-link', async () => {
  const [metadata, protocol, favorites] = await Promise.all([
    import('../../../../../packages/device-link/src/metadataContinuity'),
    import('../../../../../packages/device-link/src/protocol'),
    import('../../../../../packages/device-link/src/modelFavorites'),
  ]);
  return { ...metadata, ...protocol, ...favorites, isSharedTaskPeer: () => false };
});

const provider = (id: string): ProviderView => ({
  id, name: id, source: 'builtin', agents: ['claude-code'], auth: { method: 'none' },
  routing: { 'claude-code': { upstream: 'https://example.invalid', authStrategy: 'none' } },
  models: { 'claude-code': [] }, connected: true,
});
const capabilities = {
  availableModels: [{ id: 'model', displayName: 'Model', contextWindow: 1, efforts: [], defaultEffort: null }],
  hasFastMode: false, effortLevels: [], permissionModes: [],
};
const receivedShare = (partial: Partial<ProviderShareReceived> = {}): ProviderShareReceived => ({
  shareId: 'a', memberId: 'm1', providerId: 'shared-provider', providerLabel: 'Shared',
  hostDeviceId: 'owner-mac', deviceName: 'Owner Mac',
  owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true, ...partial,
});
let nextBudgetOrder = 0;
const regionBudget = (
  id: string,
  remainingMs = PROVIDER_METADATA_TRUST_MS,
  generatedAt = Date.now(),
  order = ++nextBudgetOrder,
): ProviderShareRegionBudget => ({ id, order, remainingMs, generatedAt });

const receivedSnapshot = (
  received: readonly ProviderShareReceived[],
  confirmedRegions: ReadonlyArray<ProviderShareReceived['owner']['region']> = ['global'],
  active?: boolean,
  regionBudgetValue?: ProviderShareReceivedSnapshot['regionBudget'],
): ProviderShareReceivedSnapshot => ({
  ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 }, confirmedRegions, received,
  ...(active === undefined ? {} : { active }),
  ...(regionBudgetValue === undefined ? {} : { regionBudget: regionBudgetValue }),
});

type ActEnvironment = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = true;

interface MountedRoot {
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
}
const mountedRoots = new Set<MountedRoot>();

async function renderElement(element: ReactElement): Promise<MountedRoot> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = { root, container };
  mountedRoots.add(entry);
  await act(async () => { root.render(element); });
  return entry;
}

async function unmountElement(entry: MountedRoot): Promise<void> {
  if (!mountedRoots.delete(entry)) return;
  await act(async () => { entry.root.unmount(); });
  entry.container.remove();
}

async function renderHookFixture<T>(hook: () => T): Promise<{
  result: { readonly current: T };
  unmount: () => Promise<void>;
}> {
  let current!: T;
  function HookProbe() {
    current = hook();
    return null;
  }
  const entry = await renderElement(createElement(HookProbe));
  return {
    result: { get current() { return current; } },
    unmount: () => unmountElement(entry),
  };
}

async function cleanupMounted(): Promise<void> {
  for (const entry of [...mountedRoots]) await unmountElement(entry);
}

beforeEach(() => {
  providers.evictAllDeviceProviders();
  resetProviderShareStoreForTests();
  setDataOwnerGeneration('owner', 1);
});
afterEach(async () => {
  await cleanupMounted();
  providers.evictAllDeviceProviders();
  resetProviderShareStoreForTests();
});

describe('mounted provider catalog permanent failures', () => {
  it('clears rows when a retained refresh discovers the share is gone', async () => {
    let phase: 'fresh' | 'removed' = 'fresh';
    const invoke = vi.fn(async (_device: string, channel: string) => {
      if (channel !== 'maker:provider:list') return capabilities;
      if (phase === 'fresh') return { providers: [provider('stale')] };
      throw Object.assign(new Error('[PRECONDITION_FAILED] Model source is no longer available'),
        { code: 'PRECONDITION_FAILED' });
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
    await providers.prefetchDeviceProviders('share:gone');

    let latest: ReturnType<typeof providers.useDeviceProviders> | undefined;
    function Probe() {
      latest = providers.useDeviceProviders('share:gone');
      return null;
    }
    await renderElement(createElement(Probe));
    await flushMounted(); expect(latest?.providers).toHaveLength(1);
    phase = 'removed';
    await act(async () => { await refreshRemoteCatalogSnapshot('share:gone'); });

    await flushMounted(); expect(latest?.providers).toEqual([]);
    expect(latest?.error).toContain('PRECONDITION_FAILED');
  });

  it('keeps controlled model locations when relay signaling drops but the target data path is retained', async () => {
    let statusChanged: ((payload: { status: string; directDataDeviceIds?: string[] }) => void) | undefined;
    const invoke = vi.fn(async (_device: string, channel: string) => {
      if (channel !== CONTROLLED_MODEL_CATALOG_CHANNEL) throw new Error('unexpected channel');
      return { status: 'complete', locations: [{ agentDeviceId: 'share:a', name: 'A' }] };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { deviceLink: {
        invoke,
        onStatusChanged: (callback: typeof statusChanged) => {
          statusChanged = callback;
          return () => undefined;
        },
        onPresenceChanged: () => () => undefined,
        onRemotePush: () => () => undefined,
        onPeerLinkReset: () => () => undefined,
        onControlTargetChanged: () => () => undefined,
      } },
    });
    const hook = await renderHookFixture(() => useControlledModelLocations('host', 'self'));
    await flushMounted();
    expect(hook.result.current).toHaveLength(1);

    await act(async () => {
      statusChanged?.({ status: 'connecting', directDataDeviceIds: ['host'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.result.current).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
async function flushMounted(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

async function mountSharePicker(options: { deferInitial?: boolean } = {}) {
  let push: ((list: ProviderShareReceived[]) => void) | undefined;
  let remotePush: ((push: { deviceId: string; channel: string; payload?: unknown }) => void) | undefined;
  let currentSnapshot = receivedSnapshot([receivedShare()]);
  let phase: 'fresh' | 'pending' = 'fresh';
  let providerContinuity: { stale: boolean; remainingMs: number } | undefined;
  let capabilityContinuity: { stale: boolean; remainingMs: number } | undefined;
  let snapshotGate: Promise<ProviderShareReceivedSnapshot> | null = null;
  let resolveSnapshotGate: ((value: ProviderShareReceivedSnapshot) => void) | undefined;
  let snapshotFailure = false;
  let resolveInitial: ((list: ProviderShareReceived[]) => void) | undefined;
  const initial = options.deferInitial
    ? new Promise<ProviderShareReceived[]>((resolve) => { resolveInitial = resolve; })
    : null;
  const invoke = vi.fn(async (_device: string, channel: string) => {
    if (channel !== 'maker:provider:list') {
      return { ...capabilities, ...(capabilityContinuity ? { providerContinuity: capabilityContinuity } : {}) };
    }
    if (phase === 'pending') return new Promise<never>(() => undefined);
    return { providers: [provider('shared-model-provider')],
      ...(providerContinuity ? { providerContinuity } : {}) };
  });
  const command = vi.fn(async (request: { action: string }) => {
    if (request.action === 'received') return initial ?? [receivedShare()];
    if (snapshotFailure) throw new Error('provider share snapshot unavailable');
    if (snapshotGate) return snapshotGate;
    return currentSnapshot;
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        invoke,
        onRemotePush: (callback: typeof remotePush) => {
          remotePush = callback;
          return () => undefined;
        },
      },
      providerShare: {
        command,
        onReceivedChanged: (callback: (list: ProviderShareReceived[]) => void) => {
          push = callback;
          return () => undefined;
        },
      },
    },
  });
  const store = await renderHookFixture(() => useProviderShareReceived());
  if (!options.deferInitial) {
    await flushMounted();
    expect(store.result.current.loaded).toBe(true);
  }
  let latest: ReturnType<typeof providers.useDeviceProviders> | undefined;
  function Probe() {
    latest = providers.useDeviceProviders('share:a');
    return null;
  }
  await renderElement(createElement(Probe));
  await flushMounted();
  expect(latest?.providers).toHaveLength(1);
  return {
    command, store,
    latest: () => latest!,
    providerReads: () => invoke.mock.calls.filter(([, channel]) => channel === 'maker:provider:list').length,
    capabilityReads: () => invoke.mock.calls.filter(([, channel]) => channel === 'maker:get-capabilities').length,
    setContinuity: (next: { provider?: { stale: boolean; remainingMs: number };
      capabilities?: { stale: boolean; remainingMs: number } }) => {
      providerContinuity = next.provider;
      capabilityContinuity = next.capabilities;
    },
    remotePush: (next: { deviceId: string; channel: string; payload?: unknown }) => {
      if (!remotePush) throw new Error('remote push listener not registered');
      remotePush(next);
    },
    push: (list: ProviderShareReceived[]) => {
      if (!push) throw new Error('provider share push listener not registered');
      push(list);
    },
    setSnapshot: (next: ProviderShareReceivedSnapshot) => { currentSnapshot = next; },
    setPending: () => { phase = 'pending'; },
    setSnapshotPending: () => { snapshotGate = new Promise<ProviderShareReceivedSnapshot>((resolve) => { resolveSnapshotGate = resolve; }); },
    resolveSnapshot: () => { resolveSnapshotGate?.(currentSnapshot); resolveSnapshotGate = undefined; snapshotGate = null; },
    setSnapshotFailure: () => { snapshotFailure = true; },
    resolveInitial: (list: ProviderShareReceived[]) => { resolveInitial?.(list); },
  };
}

async function retainUnconfirmedGlobal(f: Awaited<ReturnType<typeof mountSharePicker>>, budget: ProviderShareRegionBudget): Promise<void> {
  f.setSnapshot(receivedSnapshot([receivedShare()], ['global'], true, { global: budget }));
  await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
  // The next projection only confirms the neighboring region. The global row
  // must inherit the first request's remaining budget, not this read's time.
  f.setSnapshot(receivedSnapshot([], ['cn'], true));
  await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
}

describe('provider share catalog identity changes', () => {
  it('clears a mounted picker on an active member identity change before the refresh settles', async () => {
    const f = await mountSharePicker();
    const next = receivedShare({ memberId: 'm2' });
    f.setPending();
    f.setSnapshot(receivedSnapshot([next]));
    await act(() => f.push([next]));
    await flushMounted(); expect(f.latest().providers).toEqual([]);
    expect(f.latest().loading).toBe(true);
  });

  it('keeps the bounded display for an online-only change while its refresh is pending', async () => {
    const f = await mountSharePicker();
    const next = receivedShare({ hostOnline: false });
    f.setPending();
    f.setSnapshot(receivedSnapshot([next]));
    await act(() => f.push([next]));
    await flushMounted(); expect(f.providerReads()).toBe(2);
    expect(f.latest().providers).toHaveLength(1);
    expect(f.latest().loading).toBe(true);
  });

  it('clears the last explicitly removed share immediately', async () => {
    const f = await mountSharePicker();
    f.setPending();
    f.setSnapshot(receivedSnapshot([]));
    await act(() => f.push([]));
    await flushMounted(); expect(f.latest().providers).toEqual([]);
    expect(f.store.result.current.received).toEqual([]);
  });

  it('clears mounted rows when the share runtime reports an inactive boundary', async () => {
    const f = await mountSharePicker();
    f.setPending();
    f.setSnapshot(receivedSnapshot([], [], false));
    await act(() => f.push([]));
    await flushMounted(); expect(f.latest().providers).toEqual([]);
    expect(f.store.result.current.received).toEqual([]);
  });

  it('keeps the remaining catalog and deadline for an incomplete transient empty projection', async () => {
    const f = await mountSharePicker();
    f.setSnapshot(receivedSnapshot([], []));
    await act(async () => {
      f.push([]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(f.store.result.current.received).toHaveLength(1);
    expect(f.latest().providers).toHaveLength(1);
    expect(f.providerReads()).toBe(1);
  });

  // Test value
  // - Production entry/observable result: useProviderShareReceived + useDeviceProviders after an owner change.
  // - Rule: account switch retires old rows/catalogs immediately; same-owner incomplete projections keep their rows.
  // - Coverage gap: the seed covered inactive boundaries and same-owner partial snapshots, not a new owner with no confirmed regions or a pending/failed snapshot.
  // - Minimal input: old owner has one share; switch owners; new snapshot is empty/unconfirmed, pending or failed; a late old list resolves.
  // - Tier: unit against the real store/hook; only the preload IPC is mocked.
  it('does not retain the previous account shares when the new owner has no confirmed regions', async () => {
    const f = await mountSharePicker();
    setDataOwnerGeneration('new-owner', 1);
    f.setPending();
    f.setSnapshot({
      ownerStamp: { dataOwnerId: 'new-owner', ownerGeneration: 1 },
      confirmedRegions: [], received: [], active: true,
    });
    // Mirror AuthContext.publishDataOwnerGeneration's global catalog fence, then the
    // ProviderShareGlobalHost owner-change effect. No share push or snapshot is sent.
    await act(() => {
      invalidateRemoteCatalogSnapshots();
      refreshProviderShareFavoriteMembership();
    });
    await flushMounted(); expect(f.store.result.current.received).toEqual([]);
    await flushMounted(); expect(f.latest().providers).toEqual([]);
  });

  it.each(['pending', 'failure'] as const)('hides the previous account rows while the new owner snapshot is %s', async (mode) => {
    const f = await mountSharePicker();
    setDataOwnerGeneration('new-owner', 1);
    await act(() => { invalidateRemoteCatalogSnapshots(); });
    f.setPending();
    if (mode === 'pending') f.setSnapshotPending();
    else f.setSnapshotFailure();
    await act(() => f.push([]));
    await flushMounted(); expect(f.store.result.current.received).toEqual([]);
    await flushMounted(); expect(f.latest().providers).toEqual([]);
  });

  it('does not resurrect previous-owner rows after A to B to A without a share push', async () => {
    const f = await mountSharePicker();
    setDataOwnerGeneration('new-owner', 1);
    f.setPending();
    await act(() => {
      invalidateRemoteCatalogSnapshots();
      refreshProviderShareFavoriteMembership();
    });
    await flushMounted(); expect(f.store.result.current.received).toEqual([]);
    setDataOwnerGeneration('owner', 1);
    await act(() => {
      invalidateRemoteCatalogSnapshots();
      refreshProviderShareFavoriteMembership();
    });
    await flushMounted(); expect(f.store.result.current.received).toEqual([]);
  });

  it('restores a fresh A3 owner entry after B2 without a share push', async () => {
    const f = await mountSharePicker();
    setDataOwnerGeneration('new-owner', 2);
    f.setSnapshot({
      ownerStamp: { dataOwnerId: 'new-owner', ownerGeneration: 2 },
      confirmedRegions: ['global'], received: [], active: true,
    });
    await act(() => refreshProviderShareFavoriteMembership());
    await flushMounted();

    const freshA = receivedShare({ shareId: 'fresh-a3' });
    setDataOwnerGeneration('owner', 3);
    f.setSnapshot({
      ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 3 },
      confirmedRegions: ['global'], received: [freshA], active: true,
    });
    await act(() => refreshProviderShareFavoriteMembership());
    await flushMounted();
    expect(f.store.result.current.received).toEqual([freshA]);
  });

  // Value: the real owner-change entry has a valid new-owner snapshot but no push;
  // clearing old rows must still allow that confirmed account's catalog to load.
  it('loads a confirmed new-owner snapshot through the owner entry without a share push', async () => {
    const f = await mountSharePicker();
    const next = receivedShare({ shareId: 'new-owner-share', memberId: 'new-owner-member' });
    f.setSnapshot({
      ownerStamp: { dataOwnerId: 'new-owner', ownerGeneration: 1 },
      confirmedRegions: ['global'], received: [next], active: true,
    });
    setDataOwnerGeneration('new-owner', 1);
    await act(() => {
      invalidateRemoteCatalogSnapshots();
      refreshProviderShareFavoriteMembership();
    });
    await flushMounted(); expect(f.store.result.current.received).toEqual([next]);
    expect(f.store.result.current.loaded).toBe(true);
  });

  it('expires same-owner unconfirmed-region rows and retires their mounted catalog', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const confirmedAt = Date.now();
      await retainUnconfirmedGlobal(f, regionBudget('global-list-1', PROVIDER_METADATA_TRUST_MS, confirmedAt));
      expect(f.store.result.current.received).toHaveLength(1);
      expect(f.latest().providers).toHaveLength(1);
      const reads = f.providerReads();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROVIDER_METADATA_TRUST_MS + 1);
        await Promise.resolve();
      });
      expect(f.store.result.current.received).toEqual([]);
      expect(f.latest().providers).toEqual([]);
      // Expiry retires the mounted target; it must not reopen the old share.
      expect(f.providerReads()).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['wall', 'mono'] as const)('expires when only the %s clock passes', async (clock) => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      await retainUnconfirmedGlobal(f, regionBudget('global-list-2', PROVIDER_METADATA_TRUST_MS, wall.now));
      if (clock === 'wall') wall.now += PROVIDER_METADATA_TRUST_MS + 1;
      else mono.now += PROVIDER_METADATA_TRUST_MS + 1;
      await act(async () => { await vi.advanceTimersByTimeAsync(PROVIDER_METADATA_TRUST_MS + 1); });
      expect(f.store.result.current.received).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not renew on repeated partial snapshots, a failed refresh, or a remount', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const confirmedAt = Date.now();
      await retainUnconfirmedGlobal(f, regionBudget('global-list-3', PROVIDER_METADATA_TRUST_MS, confirmedAt));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      f.setSnapshot(receivedSnapshot([], ['cn'], true));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      f.setSnapshotFailure();
      await act(async () => { f.push([receivedShare()]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(1);
      await f.store.unmount();
      const remounted = await renderHookFixture(() => useProviderShareReceived());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(remounted.result.current.received).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 + 1); });
      expect(remounted.result.current.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revive a current-list row whose explicit budget is already zero on a manual refresh', async () => {
    const f = await mountSharePicker();
    f.setSnapshot(receivedSnapshot([receivedShare()], ['global'], true,
      { global: regionBudget('expired-list', 0, Date.now()) }));
    await act(async () => { refreshProviderShareReceived(); await Promise.resolve(); await Promise.resolve(); });
    expect(f.store.result.current.received).toEqual([]);
    expect(f.latest().providers).toEqual([]);
  });

  it('applies a budget received by the favorites entry without waiting for a share push', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      f.setSnapshot(receivedSnapshot([receivedShare()], ['global'], true,
        { global: regionBudget('favorite-list', 1_000, Date.now()) }));
      await act(async () => {
        refreshProviderShareFavoriteMembership();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(f.store.result.current.received).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
      expect(f.store.result.current.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not revive a cached push when the expiry timer has not run', async () => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      await retainUnconfirmedGlobal(f, regionBudget('global-list-timer', 1_000, wall.now));
      // Move the wall clock past the deadline without running the timer. A
      // cached push must still be checked synchronously against the deadline.
      wall.now += 2_000;
      f.setSnapshotFailure();
      await act(async () => {
        f.push([receivedShare()]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(f.store.result.current.received).toEqual([]);
      expect(f.latest().providers).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects an older source and accepts a newer source after a wall-clock rollback', async () => {
    const f = await mountSharePicker();
    const now = Date.now();
    const first = receivedShare({ shareId: 'first' });
    const stale = receivedShare({ shareId: 'stale' });
    const fresh = receivedShare({ shareId: 'fresh' });

    f.setSnapshot(receivedSnapshot([first], ['global'], true,
      { global: regionBudget('source-first', PROVIDER_METADATA_TRUST_MS, now, 10) }));
    await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
    expect(f.store.result.current.received.map(share => share.shareId)).toEqual(['first']);

    f.setSnapshot(receivedSnapshot([stale], ['global'], true,
      { global: regionBudget('source-stale', PROVIDER_METADATA_TRUST_MS, now + 60_000, 9) }));
    await act(() => refreshProviderShareFavoriteMembership());
    await flushMounted(); expect(f.store.result.current.received.map(share => share.shareId)).toEqual(['first']);

    f.setSnapshot(receivedSnapshot([fresh], ['global'], true,
      { global: regionBudget('source-fresh', PROVIDER_METADATA_TRUST_MS, now - 300_000, 11) }));
    await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
    expect(f.store.result.current.received.map(share => share.shareId)).toEqual(['fresh']);
  });

  it('inherits a shorter positive remaining for the same source', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const now = Date.now();
      const share = receivedShare({ shareId: 'same-source' });
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('same-source', 30 * 60_000, now, 20) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('same-source', 10 * 60_000, Date.now(), 20) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(1);
      // Keep any later membership projection from changing the same-source
      // remainder while the timer test advances.
      f.setSnapshotFailure();
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 + 1); });
      expect(f.store.result.current.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an expired source fenced against a late cached snapshot and a fallback list', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const share = receivedShare({ shareId: 'expired-source-row' });
      const source = regionBudget('expired-source', 1_000, Date.now(), 30);
      f.setSnapshot(receivedSnapshot([share], ['global'], true, { global: source }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
      expect(f.store.result.current.received).toEqual([]);

      // Same source id, but a cached projection after the original window;
      // it must not turn the known expiry back into 'no budget ever'.
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: { ...source, remainingMs: PROVIDER_METADATA_TRUST_MS, generatedAt: Date.now() } }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toEqual([]);

      f.setSnapshotFailure();
      await act(async () => { f.push([share]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires provider and capability caches after a synchronous expiry is latched', async () => {
    const f = await mountSharePicker();
    await act(async () => { await prefetchDeviceCapabilities('share:a'); });
    expect(getCachedCapabilities('claude-code', 'share:a')).not.toBeNull();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      const share = receivedShare();
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('retire-after-getter', 1_000, wall.now, 90) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      wall.now += 2_000;
      await f.store.unmount();
      const remounted = await renderHookFixture(() => useProviderShareReceived());
      await flushMounted();
      expect(remounted.result.current.received).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(f.latest().providers).toEqual([]);
      expect(getCachedCapabilities('claude-code', 'share:a')).toBeNull();
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not read expired rows through a remounted store when the timer has not run', async () => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      const share = receivedShare({ shareId: 'sync-read' });
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('sync-read', 1_000, wall.now, 40) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(1);

      // Do not advance fake timers: only the synchronous getter can hide the
      // already-expired row on the next mount/render.
      wall.now += 2_000;
      mono.now += 2_000;
      await f.store.unmount();
      const remounted = await renderHookFixture(() => useProviderShareReceived());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(remounted.result.current.received).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('recomputes the synchronous view when a second region expires without a timer', async () => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      const globalShare = receivedShare({ shareId: 'cache-global' });
      const cnShare: ProviderShareReceived = { ...receivedShare({ shareId: 'cache-cn' }),
        owner: { ...receivedShare().owner, region: 'cn' } };
      f.setSnapshot(receivedSnapshot([globalShare, cnShare], ['global', 'cn'], true, {
        global: regionBudget('cache-global', 20 * 60_000, wall.now, 70),
        cn: regionBudget('cache-cn', 10 * 60_000, wall.now, 71),
      }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(2);

      wall.now += 10 * 60_000 + 1;
      mono.now += 10 * 60_000 + 1;
      await f.store.unmount();
      const first = await renderHookFixture(() => useProviderShareReceived());
      await flushMounted();
      expect(first.result.current.received.map(share => share.shareId)).toEqual(['cache-global']);
      await first.unmount();

      wall.now += 10 * 60_000 + 1;
      mono.now += 10 * 60_000 + 1;
      const second = await renderHookFixture(() => useProviderShareReceived());
      await flushMounted();
      expect(second.result.current.received).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('latches an observed wall expiry when the timer is suspended and the wall clock rolls back', async () => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      const share = receivedShare({ shareId: 'wall-latched' });
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('wall-latched', 1_000, wall.now, 72) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      wall.now += 2_000;
      await f.store.unmount();
      const first = await renderHookFixture(() => useProviderShareReceived());
      await flushMounted();
      expect(first.result.current.received).toEqual([]);
      await first.unmount();

      wall.now -= 2_000;
      const second = await renderHookFixture(() => useProviderShareReceived());
      await flushMounted();
      expect(second.result.current.received).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'inactive'] as const)(
    'applies an authoritative favorites %s snapshot without waiting for a push',
    async (mode) => {
      const f = await mountSharePicker();
      f.setSnapshot(mode === 'empty'
        ? receivedSnapshot([], ['global'], true,
          { global: regionBudget('favorites-empty', PROVIDER_METADATA_TRUST_MS, Date.now(), 73) })
        : receivedSnapshot([], [], false));
      await act(() => refreshProviderShareFavoriteMembership());
      await flushMounted();
      expect(f.store.result.current.received).toEqual([]);
      expect(f.latest().providers).toEqual([]);
    },
  );

  it('does not grant a fresh window when the first IPC budget arrives after Main mono expiry', async () => {
    const f = await mountSharePicker();
    const wall = { now: Date.now() };
    const mono = { now: performance.now() };
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wall.now);
    const monoNow = vi.spyOn(performance, 'now').mockImplementation(() => mono.now);
    try {
      const share = receivedShare({ shareId: 'ipc-delayed' });
      f.setSnapshot(receivedSnapshot([share], ['global'], true,
        { global: regionBudget('ipc-delayed', 10 * 60_000, wall.now, 80) }));
      f.setSnapshotPending();
      await act(() => f.push([]));

      // The response is delayed past Main's 10-minute mono budget while the
      // wall clock is held. The request-start interval must still consume it.
      mono.now += 10 * 60_000 + 1;
      f.resolveSnapshot();
      await flushMounted();
      expect(f.store.result.current.received).toEqual([]);
      expect(f.latest().providers).toEqual([]);
    } finally {
      dateNow.mockRestore();
      monoNow.mockRestore();
      vi.useRealTimers();
    }
  });

  it('expires only the expired region and keeps a fresher neighbor', async () => {
    const f = await mountSharePicker();
    const cnShare: ProviderShareReceived = { ...receivedShare({ shareId: 'cn-share' }),
      owner: { ...receivedShare().owner, region: 'cn' } };
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const confirmedAt = Date.now();
      f.setSnapshot(receivedSnapshot([receivedShare(), cnShare], ['global', 'cn'], true, {
        global: regionBudget('global-list-4', 60_000, confirmedAt),
        cn: regionBudget('cn-list-4', 15 * 60_000, confirmedAt),
      }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      f.setSnapshot(receivedSnapshot([cnShare], ['cn'], true));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received.map(share => share.shareId).sort()).toEqual(['a', 'cn-share']);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000 + 1); });
      expect(f.store.result.current.received.map(share => share.shareId)).toEqual(['cn-share']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a changed healthy neighbor catalog when another region expires', async () => {
    const f = await mountSharePicker();
    const cnShare: ProviderShareReceived = { ...receivedShare({ shareId: 'cn-share' }),
      owner: { ...receivedShare().owner, region: 'cn' } };
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const confirmedAt = Date.now();
      f.setSnapshot(receivedSnapshot([receivedShare(), cnShare], ['global', 'cn'], true, {
        global: regionBudget('global-neighbor-1', 60_000, confirmedAt),
        cn: regionBudget('cn-neighbor-1', 60_000, confirmedAt),
      }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.latest().providers).toHaveLength(1);

      // The global share is still active and only its presence changed. The cn
      // budget is already zero in this projection, so expiring cn must retire
      // only cn's catalog, not the healthy global neighbor.
      f.setSnapshot(receivedSnapshot([{ ...receivedShare(), hostOnline: false }, cnShare], ['global', 'cn'], true, {
        global: regionBudget('global-neighbor-2', 60_000, Date.now()),
        cn: regionBudget('cn-neighbor-2', 0, Date.now()),
      }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      await flushMounted();
      expect(f.store.result.current.received.map(share => share.shareId)).toEqual(['a']);
      expect(f.latest().providers).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a region after its old window expires when a new confirmation arrives', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const confirmedAt = Date.now();
      f.setSnapshot(receivedSnapshot([receivedShare()], ['global'], true,
        { global: regionBudget('global-list-5', 1_000, confirmedAt) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
      expect(f.store.result.current.received).toEqual([]);
      f.setSnapshot(receivedSnapshot([receivedShare()], ['global'], true,
        { global: regionBudget('global-list-6', PROVIDER_METADATA_TRUST_MS, Date.now()) }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reattribute the previous account healthy region when an old expiry timer fires', async () => {
    const f = await mountSharePicker();
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      const otherRegion = receivedShare({ shareId: 'other-region', memberId: 'm2',
        providerId: 'other-provider', providerLabel: 'Other', hostDeviceId: 'other-mac' });
      const cn = receivedShare({ owner: { displayName: 'Owner', avatarUrl: null, region: 'cn' } });
      const global: ProviderShareReceived = { ...otherRegion,
        owner: { displayName: 'Owner', avatarUrl: null, region: 'global' } };
      f.setSnapshot(receivedSnapshot([cn, global], ['cn', 'global'], true, {
        cn: regionBudget('cn-old', 1_000, Date.now(), 100),
        global: regionBudget('global-old', PROVIDER_METADATA_TRUST_MS, Date.now(), 101),
      }));
      await act(async () => { f.push([]); await Promise.resolve(); await Promise.resolve(); });
      expect(f.store.result.current.received).toHaveLength(2);

      await act(async () => { setDataOwnerGeneration('other-owner', 2); });
      // The old timer is the first async work to run; no host effect cleared the
      // previous owner yet.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_100); await Promise.resolve(); });
      expect(f.store.result.current.received).toEqual([]);
      expect(f.store.result.current.loaded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps same-owner rows across a generation repair entry', async () => {
    const f = await mountSharePicker();
    setDataOwnerGeneration('owner', 2);
    await act(() => { refreshProviderShareFavoriteMembership(); });
    await flushMounted(); expect(f.store.result.current.received).toHaveLength(1);
  });

  it('retires an explicitly denied share catalog without re-reading the denied target', async () => {
    const f = await mountSharePicker();
    expect(f.latest().providers).toHaveLength(1);
    await act(async () => {
      f.remotePush({ deviceId: 'share:a', channel: 'maker:provider:changed',
        payload: { providerContinuity: { stale: true, remainingMs: 0 } } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMounted();
    expect(f.latest().providers).toEqual([]);
    expect(f.providerReads()).toBe(1);
  });

  it('expires provider and capability snapshots without prefetching the expired target', async () => {
    const f = await mountSharePicker();
    f.setContinuity({ provider: { stale: false, remainingMs: 1_000 },
      capabilities: { stale: false, remainingMs: 1_000 } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        providers.evictDeviceProviders('share:a');
        await Promise.all([providers.prefetchDeviceProviders('share:a'), prefetchDeviceCapabilities('share:a')]);
      });
      const providerReads = f.providerReads();
      const capabilityReads = f.capabilityReads();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_100); await Promise.resolve(); });
      expect(f.providerReads()).toBe(providerReads);
      expect(f.capabilityReads()).toBe(capabilityReads);
      expect(f.latest().providers).toEqual([]);
      expect(getCachedCapabilities('claude-code', 'share:a')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a fresh same-key capability result when an expired request fails late', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      evictAllRemoteCapabilities();
      let phase: 'warm' | 'pending' | 'fresh' = 'warm';
      let rejectPending!: (error: Error) => void;
      let reads = 0;
      const snapshot = (label: string, remainingMs: number) => ({
        ...capabilities,
        availableModels: [{ ...capabilities.availableModels[0], displayName: label }],
        providerContinuity: { stale: false, remainingMs },
      });
      const invoke = vi.fn((_device: string, _channel: string, args: unknown[]) => {
        reads += 1;
        const kind = String(args[0]);
        if (phase === 'warm') return Promise.resolve(snapshot('warm', kind === 'codex' ? 1_000 : 2_000));
        if (phase === 'pending') return new Promise((_resolve, reject) => { rejectPending = reject; });
        return Promise.resolve(snapshot('fresh', 30_000));
      });
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: { deviceLink: { invoke } },
      });

      await prefetchDeviceCapabilities('host');
      phase = 'pending';
      evictDeviceCapabilities('host', { retainDisplaySnapshot: true, directOnly: true });
      const oldHook = await renderHookFixture(() => useAgentCapabilities('codex', 'host'));
      expect(oldHook.result.current.loading).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_001);
        getCachedCapabilities('codex', 'host');
      });
      expect(oldHook.result.current.error).toBe(
        '[MODEL_VISIBILITY_NOT_READY] Agent capabilities snapshot expired',
      );

      phase = 'fresh';
      const newHook = await renderHookFixture(() => useAgentCapabilities('codex', 'host'));
      await flushMounted();
      expect(oldHook.result.current).toMatchObject({
        error: null,
        capabilities: {
          availableModels: [expect.objectContaining({ displayName: 'fresh' })],
        },
      });
      expect(newHook.result.current.error).toBeNull();

      await act(async () => {
        rejectPending(new Error('late failure from retired capability request'));
        await Promise.resolve();
      });
      await flushMounted();

      expect(oldHook.result.current.error).toBeNull();
      expect(oldHook.result.current.capabilities?.availableModels[0]?.displayName).toBe('fresh');
      expect(newHook.result.current.error).toBeNull();
      expect(reads).toBe(5);
    } finally {
      await act(async () => { evictAllRemoteCapabilities(); });
      vi.useRealTimers();
    }
  });

  it('retires only the denied route on a zero-budget provider push and keeps a healthy neighbor', async () => {
    const locations = [
      { agentDeviceId: 'share:a', name: 'A' },
      { agentDeviceId: 'share:b', name: 'B' },
    ];
    const reads = new Map<string, number>();
    let denyA = false;
    let remotePush: ((push: { deviceId: string; channel: string; payload?: unknown }) => void) | undefined;
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
      if (channel !== CONTROLLED_MODEL_CATALOG_CHANNEL) throw new Error('unexpected channel');
      const request = args[0] as { op?: string; agentDeviceId?: string } | undefined;
      if (request?.op === 'locations') return { status: 'complete', locations };
      if (request?.op === 'read') {
        const source = request.agentDeviceId!;
        reads.set(source, (reads.get(source) ?? 0) + 1);
        if (source === 'share:a' && denyA) throw new Error('[REMOTE_AGENT_SHARE_UNAVAILABLE] denied');
        return { providers: [provider(source === 'share:a' ? 'a-provider' : 'b-provider')] };
      }
      throw new Error('unexpected request');
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { deviceLink: {
        invoke,
        onRemotePush: (callback: typeof remotePush) => {
          remotePush = callback;
          return () => undefined;
        },
      } },
    });
    let current: {
      locations: ReturnType<typeof useControlledModelLocations>;
      a: ReturnType<typeof providers.useDeviceProviders>;
      b: ReturnType<typeof providers.useDeviceProviders>;
    } | undefined;
    function Probe() {
      current = {
        locations: useControlledModelLocations('host', 'self'),
        a: providers.useDeviceProviders(modelCatalogKey('share:a', 'host')),
        b: providers.useDeviceProviders(modelCatalogKey('share:b', 'host')),
      };
      return null;
    }
    await renderElement(createElement(Probe));
    await flushMounted();
    expect(current?.locations).toHaveLength(2);
    expect(current?.a.providers).toHaveLength(1);
    expect(current?.b.providers).toHaveLength(1);
    expect(reads.get('share:a')).toBe(1);
    expect(reads.get('share:b')).toBe(1);

    denyA = true;
    await act(async () => {
      remotePush?.({ deviceId: 'share:a', channel: 'maker:provider:changed',
        payload: { providerContinuity: { stale: true, remainingMs: 0 } } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushMounted();

    // The zero-budget push is the real onProviderMetadataDenied shape for a
    // share peer. It must retire only that route: no denied reopen and no
    // healthy neighbor eviction/re-read.
    expect(reads.get('share:a')).toBe(1);
    expect(reads.get('share:b')).toBe(1);
    expect(current?.a.providers).toEqual([]);
    expect(current?.b.providers).toHaveLength(1);

    // A direct-host denial retires only the host key; routed healthy aliases stay.
    await act(async () => {
      remotePush?.({ deviceId: 'host', channel: 'maker:provider:changed',
        payload: { providerContinuity: { stale: true, remainingMs: 0 } } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current?.locations).toHaveLength(2);
    expect(reads.get('share:b')).toBe(1);
    expect(current?.b.providers).toHaveLength(1);
  });

  it('ignores a late initial share list from the previous owner', async () => {
    const f = await mountSharePicker({ deferInitial: true });
    setDataOwnerGeneration('new-owner', 1);
    f.setSnapshot({
      ownerStamp: { dataOwnerId: 'new-owner', ownerGeneration: 1 },
      confirmedRegions: ['global'], received: [], active: true,
    });
    await act(() => f.push([]));
    await flushMounted(); expect(f.store.result.current.loaded).toBe(true);
    await act(() => f.resolveInitial([receivedShare()]));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(f.store.result.current.received).toEqual([]);
  });
});

describe('agent capability cache hits', () => {
  it('clears inherited loading state when the capability cache hits', async () => {
    const invoke = vi.fn(async (deviceId: string, channel: string) => {
      if (channel !== 'maker:get-capabilities') throw new Error('unexpected ' + channel);
      if (deviceId === 'pending') return new Promise<never>(() => undefined);
      return { ...capabilities, availableModels: [
        { ...capabilities.availableModels[0], displayName: 'cached' },
      ] };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { deviceLink: { invoke } },
    });
    let entry: MountedRoot | undefined;
    try {
      // Fill the real cache without going through a mounted hook.
      await prefetchDeviceCapabilities('cached');

      let latest: ReturnType<typeof useAgentCapabilities> | undefined;
      function Probe({ deviceId }: { deviceId: string }) {
        latest = useAgentCapabilities('codex', deviceId);
        return null;
      }

      // A pending target leaves the hook with inherited loading=true.
      const mounted = await renderElement(createElement(Probe, { deviceId: 'pending' }));
      entry = mounted;
      await flushMounted();
      expect(latest?.loading).toBe(true);
      expect(latest?.capabilities).toBeNull();

      // Switching to a cached target must take the cache-hit branch, clear
      // inherited loading/error, and expose the cached capabilities.
      await act(async () => {
        mounted.root.render(createElement(Probe, { deviceId: 'cached' }));
      });
      await flushMounted();
      expect(latest?.loading).toBe(false);
      expect(latest?.error).toBeNull();
      expect(latest?.capabilities?.availableModels[0]?.displayName).toBe('cached');
    } finally {
      if (entry) await unmountElement(entry);
      await act(async () => { evictAllRemoteCapabilities(); });
    }
  });
});
