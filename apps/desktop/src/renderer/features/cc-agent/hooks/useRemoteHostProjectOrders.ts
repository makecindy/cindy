import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  hostLocalProjectKeysOnly,
  parseSyncedProjectOrderSnapshot,
  remapControllerOrderToHost,
  remapHostOrderToController,
  resolveProjectOrderWriteScope,
  SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
  SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
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
  }): Promise<SyncedProjectOrderSnapshot | null>;
  snapshot: SyncedProjectOrderSnapshot;
} {
  const [snapshot, setSnapshot] = useState<SyncedProjectOrderSnapshot>(PENDING_LOCAL_SNAPSHOT);
  const seedRef = useRef(seed);
  seedRef.current = seed;

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
      ) {
        return;
      }
      const localKeys = hostLocalProjectKeysOnly(seedValue.keys);
      if (localKeys.length === 0) return;
      localHostSeedStarted = true;
      void api.applyProjectOrder({
        manualProjectOrder: localKeys,
        projectOrder: 'custom',
      }).then((applied) => {
        if (!cancelled) setSnapshot(applied);
      }).catch(() => undefined);
    }).catch(() => undefined);
    const unsubscribe = api.onProjectOrderChanged((next) => {
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
  }): Promise<SyncedProjectOrderSnapshot | null> => {
    const api = window.electronAPI?.sidebarSettings;
    if (!api?.applyProjectOrder) return null;
    try {
      const next = await api.applyProjectOrder({
        manualProjectOrder: hostLocalProjectKeysOnly(request.manualProjectOrder),
        projectOrder: request.projectOrder,
      });
      setSnapshot(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  return { apply, snapshot };
}

export function useRemoteHostProjectOrders(selectedMachineId: MachineSelection): {
  apply(
    deviceId: string,
    request: { manualProjectOrder: readonly string[]; projectOrder: SyncedProjectOrderMode },
  ): Promise<SyncedProjectOrderSnapshot | null>;
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
    void Promise.all(
      ids.map(async (deviceId) => {
        try {
          const raw = await window.electronAPI.deviceLink.invoke(
            deviceId,
            SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
            [],
          );
          return [deviceId, parseSyncedProjectOrderSnapshot(raw)] as const;
        } catch {
          return [deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setOrders(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [remoteIds]);

  const apply = useCallback(async (
    deviceId: string,
    request: { manualProjectOrder: readonly string[]; projectOrder: SyncedProjectOrderMode },
  ): Promise<SyncedProjectOrderSnapshot | null> => {
    try {
      const raw = await window.electronAPI.deviceLink.invoke(
        deviceId,
        SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
        [{
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
      return next;
    } catch {
      setOrders((current) => {
        const copy = new Map(current);
        copy.set(deviceId, UNAVAILABLE_PROJECT_ORDER_SNAPSHOT);
        return copy;
      });
      return null;
    }
  }, []);

  return { apply, orders };
}

export function controllerManualOrderForDevice(
  deviceId: string,
  snapshot: SyncedProjectOrderSnapshot | undefined,
): string[] | null {
  if (!snapshot?.authoritative || snapshot.projectOrder !== 'custom') return null;
  return remapHostOrderToController(deviceId, snapshot.manualProjectOrder);
}
