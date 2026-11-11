import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from '@/auth/authOwnerGeneration';
import {
  useDeviceLink,
  subscribeRemoteProjectAliasesChanged,
} from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { useUnresponsiveDevices } from '@/device-link/unresponsiveDevicesStore';
import { isHostProjectOrderChannelMissing } from '@cindy/maker-shared/project-order-sync';
import {
  parseHostProjectAliases,
  PROJECT_ALIASES_LIST_CHANNEL,
  type RemoteProjectAliasIndex,
} from '@cindy/maker-shared/mobile-home';

const EMPTY: RemoteProjectAliasIndex = new Map();

/** Display-only snapshots; no writes, shared-connection resets or persistent storage. */
export function useRemoteProjectAliases(
  deviceIds: readonly string[],
): RemoteProjectAliasIndex {
  const { accountGeneration } = useAuth();
  const {
    invoke,
    status,
    connectionEpoch,
    subscribe,
    unsubscribe,
    recoveringDeviceIds,
    getPresenceAvailability,
  } = useDeviceLink();
  const unresponsive = useUnresponsiveDevices();
  const idsKey = JSON.stringify([...new Set(deviceIds.filter(Boolean))].sort());
  const reachableKey = JSON.stringify(
    (JSON.parse(idsKey) as string[]).filter(
      (id) =>
        !unresponsive.has(id) &&
        !recoveringDeviceIds.has(id) &&
        getPresenceAvailability?.(id) !== false,
    ),
  );
  const binding = JSON.stringify([
    accountGeneration,
    reachableKey,
    status,
    connectionEpoch,
  ]);
  const current = useRef(binding);
  current.current = binding;
  const [state, setState] = useState<{
    owner: number;
    devices: ReadonlyMap<string, RemoteProjectAliasIndex>;
  }>({ owner: accountGeneration, devices: new Map() });

  useEffect(() => {
    if (status !== 'online') return;
    const ids = JSON.parse(reachableKey) as string[];
    const owner = getMobileAuthOwner();
    let disposed = false;
    const valid = () =>
      !disposed &&
      current.current === binding &&
      isMobileAuthOwnerCurrent(owner);
    const pending = new Set<string>();
    const dirty = new Set<string>();
    const attempts = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const refresh = async (id: string): Promise<void> => {
      if (!valid() || !ids.includes(id)) return;
      if (pending.has(id)) {
        dirty.add(id);
        return;
      }
      pending.add(id);
      clearTimeout(timers.get(id));
      try {
        do {
          dirty.delete(id);
          let aliases: RemoteProjectAliasIndex;
          try {
            aliases = parseHostProjectAliases(
              id,
              await invoke(id, PROJECT_ALIASES_LIST_CHANNEL, [], {
                background: true,
              }),
            );
          } catch (error) {
            if (!valid()) return;
            if (isHostProjectOrderChannelMissing(error)) aliases = EMPTY;
            else {
              const attempt = (attempts.get(id) ?? 0) + 1;
              attempts.set(id, attempt);
              // Retry only this read; keep the last good display during transient failures.
              if (attempt < 3)
                timers.set(
                  id,
                  setTimeout(() => {
                    void refresh(id);
                  }, 2000),
                );
              return;
            }
          }
          if (!valid()) return;
          if (dirty.has(id)) continue;
          attempts.delete(id);
          setState((previous) => ({
            owner: accountGeneration,
            devices: new Map(
              previous.owner === accountGeneration ? previous.devices : [],
            ).set(id, aliases),
          }));
        } while (dirty.has(id));
      } finally {
        pending.delete(id);
      }
    };
    const off = subscribeRemoteProjectAliasesChanged((id) => {
      attempts.delete(id);
      void refresh(id);
    });
    // Also read after subscription ACK: a rename between the initial read and ACK must not be missed.
    const stops = ids.map((deviceId) =>
      startFocusedTopicSubscription({
        deviceId,
        owner: 'project-aliases',
        topic: 'sessions',
        unsubscribe,
        subscribe: async (...args) => {
          await subscribe(...args);
          if (valid()) void refresh(deviceId);
        },
      }),
    );
    const refreshAll = () => {
      attempts.clear();
      // Uses the existing shared background invoke scheduler.
      for (const id of ids) void refresh(id);
    };
    refreshAll();
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshAll();
    });
    return () => {
      disposed = true;
      off();
      app.remove();
      stops.forEach((stop) => stop());
      timers.forEach(clearTimeout);
    };
  }, [binding, invoke, subscribe, unsubscribe]);

  return useMemo(() => {
    if (state.owner !== accountGeneration) return EMPTY;
    const aliases = new Map<string, string>();
    for (const id of JSON.parse(idsKey) as string[]) {
      for (const [key, alias] of state.devices.get(id) ?? [])
        aliases.set(key, alias);
    }
    return aliases;
  }, [state, accountGeneration, idsKey]);
}
