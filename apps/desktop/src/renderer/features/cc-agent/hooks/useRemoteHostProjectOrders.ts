import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createProjectOrderFetchFence,
  hostLocalProjectKeysOnly,
  isHostProjectOrderChannelMissing,
  localHostSeedOwnerKey,
  parseSyncedProjectOrderSnapshot,
  remapControllerOrderToHost,
  remapHostOrderToController,
  resolveProjectOrderWriteScope,
  shouldSeedLocalHostProjectOrder,
  SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
  SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
  SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL,
  UNAVAILABLE_PROJECT_ORDER_SNAPSHOT,
  type ProjectOrderWriteScope,
  type SyncedProjectOrderMode,
  type SyncedProjectOrderSnapshot,
} from '@cindy/maker-shared/project-order-sync';
import {
  MACHINE_ALL,
  MACHINE_LOCAL,
  type MachineSelection,
} from '@/features/device-link/selectedMachineStore';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

const seededLocalHostOwners = new Set<string>();

const PENDING_LOCAL_SNAPSHOT: SyncedProjectOrderSnapshot = {
  authoritative: false,
  available: true,
  manualProjectOrder: [],
  projectOrder: 'activity',
};

function selectedRemoteIds(selection: MachineSelection): string[] {
  if (selection === MACHINE_ALL) return [];
  return selection.filter((id) => id !== MACHINE_LOCAL);
}

export function projectOrderWriteScopeForSelection(
  selection: MachineSelection,
): ProjectOrderWriteScope {
  return resolveProjectOrderWriteScope(selection, MACHINE_LOCAL);
}

export function useLocalHostProjectOrder(seed?: {
  custom: boolean;
  keys: readonly string[];
}): {
  apply(request: {
    manualProjectOrder: readonly string[];
    projectOrder: SyncedProjectOrderMode;
  }): Promise<{ kind: 'ok'; snapshot: SyncedProjectOrderSnapshot } | { kind: 'unavailable' } | { kind: 'transient' }>;
  snapshot: SyncedProjectOrderSnapshot;
} {
  const [snapshot, setSnapshot] = useState<SyncedProjectOrderSnapshot>(PENDING_LOCAL_SNAPSHOT);
  const seedRef = useRef(seed);
  const snapshotRef = useRef(snapshot);
  const fetchFenceRef = useRef(createProjectOrderFetchFence());
  seedRef.current = seed;
  snapshotRef.current = snapshot;

  useEffect(() => {
    const api = window.electronAPI?.sidebarSettings;
    if (!api?.getProjectOrder || !api.onProjectOrderChanged) return undefined;
    let cancelled = false;
    let seedAttempts = 0;
    let fetchAttempts = 0;
    let seedRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let fetchRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const fence = createProjectOrderFetchFence();
    fetchFenceRef.current = fence;
    const seedIfNeeded = (next: SyncedProjectOrderSnapshot) => {
      const seedValue = seedRef.current;
      if (!shouldSeedLocalHostProjectOrder(next, seedValue, seededLocalHostOwners)) return;
      if (!next.ownerStamp || seedAttempts >= 3) return;
      seedAttempts += 1;
      const localKeys = hostLocalProjectKeysOnly(seedValue!.keys);
      void api.applyProjectOrder({
        manualProjectOrder: localKeys,
        ownerStamp: next.ownerStamp,
        projectOrder: 'custom',
      }).then((applied) => {
        seededLocalHostOwners.add(localHostSeedOwnerKey(applied.ownerStamp ?? next.ownerStamp!));
        fence.noteLiveUpdate('local');
        if (!cancelled) setSnapshot(applied);
      }).catch(() => {
        if (cancelled || seedAttempts >= 3) return;
        seedRetryTimer = setTimeout(() => seedIfNeeded(snapshotRef.current), 1500);
      });
    };
    const fetchOnce = () => {
      if (cancelled || fetchAttempts >= 3) return;
      fetchAttempts += 1;
      const fetchToken = fence.begin('local');
      void api.getProjectOrder().then((next) => {
        if (cancelled || !fence.shouldApplyFetch('local', fetchToken)) return;
        setSnapshot(next);
        seedIfNeeded(next);
      }).catch(() => {
        if (cancelled || fetchAttempts >= 3) return;
        fetchRetryTimer = setTimeout(fetchOnce, 1500);
      });
    };
    fetchOnce();
    const unsubscribe = api.onProjectOrderChanged((next, ownerStamp) => {
      const current = snapshotRef.current.ownerStamp;
      if (
        current
        && (current.dataOwnerId !== ownerStamp.dataOwnerId
          || current.ownerGeneration !== ownerStamp.ownerGeneration)
      ) {
        return;
      }
      fence.noteLiveUpdate('local');
      setSnapshot(next);
      seedIfNeeded(next);
    });
    return () => {
      cancelled = true;
      if (seedRetryTimer) clearTimeout(seedRetryTimer);
      if (fetchRetryTimer) clearTimeout(fetchRetryTimer);
      unsubscribe();
    };
  }, []);

  const apply = useCallback(async (request: {
    manualProjectOrder: readonly string[];
    projectOrder: SyncedProjectOrderMode;
  }): Promise<{ kind: 'ok'; snapshot: SyncedProjectOrderSnapshot } | { kind: 'unavailable' } | { kind: 'transient' }> => {
    const api = window.electronAPI?.sidebarSettings;
    const ownerStamp = snapshotRef.current.ownerStamp;
    if (!api?.applyProjectOrder || !ownerStamp) return { kind: 'transient' };
    try {
      const next = await api.applyProjectOrder({
        manualProjectOrder: hostLocalProjectKeysOnly(request.manualProjectOrder),
        ownerStamp,
        projectOrder: request.projectOrder,
      });
      fetchFenceRef.current.noteLiveUpdate('local');
      setSnapshot(next);
      return { kind: 'ok', snapshot: next };
    } catch {
      return { kind: 'transient' };
    }
  }, []);

  return { apply, snapshot };
}

export function useRemoteHostProjectOrders(selectedMachineId: MachineSelection): {
  apply(
    deviceId: string,
    request: { manualProjectOrder: readonly string[]; projectOrder: SyncedProjectOrderMode },
  ): Promise<{ kind: 'ok'; snapshot: SyncedProjectOrderSnapshot } | { kind: 'unavailable' } | { kind: 'transient' }>;
  orders: ReadonlyMap<string, SyncedProjectOrderSnapshot>;
} {
  const remoteIds = useMemo(
    () => selectedRemoteIds(selectedMachineId).join('\0'),
    [selectedMachineId],
  );
  const [orders, setOrders] = useState<ReadonlyMap<string, SyncedProjectOrderSnapshot>>(() => new Map());
  const fetchFenceRef = useRef(createProjectOrderFetchFence());

  useEffect(() => {
    const ids = remoteIds ? remoteIds.split('\0') : [];
    if (ids.length === 0) {
      setOrders(new Map());
      return undefined;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const fence = createProjectOrderFetchFence();
    fetchFenceRef.current = fence;
    const load = async (attempt: number) => {
      const tokens = new Map(ids.map((deviceId) => [deviceId, fence.begin(deviceId)]));
      const entries = await Promise.all(
        ids.map(async (deviceId) => {
          try {
            const raw = await window.electronAPI.deviceLink.invoke(
              deviceId,
              SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
              [],
            );
            return [deviceId, { kind: 'ok' as const, snapshot: parseSyncedProjectOrderSnapshot(raw) }] as const;
          } catch (error) {
            if (isHostProjectOrderChannelMissing(error)) {
              return [deviceId, { kind: 'unavailable' as const }] as const;
            }
            return [deviceId, { kind: 'transient' as const }] as const;
          }
        }),
      );
      if (cancelled) return;
      setOrders((current) => {
        const copy = new Map(current);
        for (const [deviceId, result] of entries) {
          if (!fence.shouldApplyFetch(deviceId, tokens.get(deviceId) ?? 0)) continue;
          if (result.kind === 'ok') copy.set(deviceId, result.snapshot);
          else if (result.kind === 'unavailable') copy.set(deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
        }
        return copy;
      });
      if (attempt < 3 && entries.some(([, result]) => result.kind === 'transient')) {
        retryTimer = setTimeout(() => {
          void load(attempt + 1);
        }, 2000);
      }
    };
    void load(1);
    const offPush = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (cancelled || push.channel !== SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL) return;
      if (!ids.includes(push.deviceId)) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      const next = parseSyncedProjectOrderSnapshot(push.payload);
      fence.noteLiveUpdate(push.deviceId);
      setOrders((current) => {
        const copy = new Map(current);
        copy.set(push.deviceId, next);
        return copy;
      });
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      offPush();
    };
  }, [remoteIds]);

  const apply = useCallback(async (
    deviceId: string,
    request: { manualProjectOrder: readonly string[]; projectOrder: SyncedProjectOrderMode },
  ): Promise<{ kind: 'ok'; snapshot: SyncedProjectOrderSnapshot } | { kind: 'unavailable' } | { kind: 'transient' }> => {
    try {
      const ownerStamp = orders.get(deviceId)?.ownerStamp;
      if (!ownerStamp) return { kind: 'transient' };
      const raw = await window.electronAPI.deviceLink.invoke(
        deviceId,
        SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
        [{
          ...ownerStamp,
          manualProjectOrder: remapControllerOrderToHost(
            deviceId,
            request.manualProjectOrder,
            orders.get(deviceId)?.manualProjectOrder ?? [],
          ),
          projectOrder: request.projectOrder,
        }],
      );
      const next = parseSyncedProjectOrderSnapshot(raw);
      fetchFenceRef.current.noteLiveUpdate(deviceId);
      setOrders((current) => {
        const copy = new Map(current);
        copy.set(deviceId, next);
        return copy;
      });
      return { kind: 'ok', snapshot: next };
    } catch (error) {
      if (isHostProjectOrderChannelMissing(error)) {
        setOrders((current) => {
          const copy = new Map(current);
          copy.set(deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
          return copy;
        });
        return { kind: 'unavailable' };
      }
      return { kind: 'transient' };
    }
  }, [orders]);

  return { apply, orders };
}

export function controllerManualOrderForDevice(
  deviceId: string,
  snapshot: SyncedProjectOrderSnapshot | undefined,
): string[] | null {
  if (!snapshot?.authoritative || snapshot.projectOrder !== 'custom') return null;
  return remapHostOrderToController(deviceId, snapshot.manualProjectOrder);
}
