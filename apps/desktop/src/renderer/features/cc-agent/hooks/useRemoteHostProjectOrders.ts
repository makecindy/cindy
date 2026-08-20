import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  hostLocalProjectKeysOnly,
  isHostProjectOrderChannelMissing,
  parseSyncedProjectOrderSnapshot,
  remapControllerOrderToHost,
  remapHostOrderToController,
  resolveProjectOrderWriteScope,
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

let localHostSeedStarted = false;

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
  seedRef.current = seed;
  snapshotRef.current = snapshot;

  useEffect(() => {
    const api = window.electronAPI?.sidebarSettings;
    if (!api?.getProjectOrder || !api.onProjectOrderChanged) return undefined;
    let cancelled = false;
    void api.getProjectOrder().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const seedValue = seedRef.current;
      if (
        next.authoritative
        || localHostSeedStarted
        || !seedValue?.custom
        || seedValue.keys.some((key) => key.startsWith('device:'))
        || !next.ownerStamp
      ) {
        return;
      }
      const localKeys = hostLocalProjectKeysOnly(seedValue.keys);
      if (localKeys.length === 0) return;
      localHostSeedStarted = true;
      void api.applyProjectOrder({
        manualProjectOrder: localKeys,
        ownerStamp: next.ownerStamp,
        projectOrder: 'custom',
      }).then((applied) => {
        if (!cancelled) setSnapshot(applied);
      }).catch(() => undefined);
    }).catch(() => undefined);
    const unsubscribe = api.onProjectOrderChanged((next, ownerStamp) => {
      const current = snapshotRef.current.ownerStamp;
      if (
        current
        && (current.dataOwnerId !== ownerStamp.dataOwnerId
          || current.ownerGeneration !== ownerStamp.ownerGeneration)
      ) {
        return;
      }
      setSnapshot(next);
    });
    return () => {
      cancelled = true;
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

  useEffect(() => {
    const ids = remoteIds ? remoteIds.split('\0') : [];
    if (ids.length === 0) {
      setOrders(new Map());
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
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
          if (result.kind === 'ok') copy.set(deviceId, result.snapshot);
          else if (result.kind === 'unavailable') copy.set(deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
        }
        return copy;
      });
    };
    void load();
    const offPush = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (cancelled || push.channel !== SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL) return;
      if (!ids.includes(push.deviceId)) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      const next = parseSyncedProjectOrderSnapshot(push.payload);
      setOrders((current) => {
        const copy = new Map(current);
        copy.set(push.deviceId, next);
        return copy;
      });
    });
    return () => {
      cancelled = true;
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
          manualProjectOrder: remapControllerOrderToHost(deviceId, request.manualProjectOrder),
          projectOrder: request.projectOrder,
        }],
      );
      const next = parseSyncedProjectOrderSnapshot(raw);
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
