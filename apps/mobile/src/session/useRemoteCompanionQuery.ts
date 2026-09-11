import { useCallback, useRef, useState } from 'react';
import { prStatusKey, type PrStatusResult } from '@cindy/maker-shared';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { subscribeRemoteBotChanges, useDeviceLink } from '@/device-link/DeviceLinkContext';

const pending = new Map<string, { promise: Promise<unknown>; invalidated: boolean }>();

/** Share concurrent list reads between cards; responses never outlive their account/link. */
export function useRemoteCompanionQuery<T>(
  deviceId: string,
  channel: string,
  args: unknown[],
  options: {
    enabled?: boolean;
    refreshIntervalMs?: number;
    refreshKey?: number;
  } = {},
) {
  const link = useDeviceLink();
  const { accountGeneration } = useAuth();
  const argsKey = JSON.stringify(args);
  const identity = JSON.stringify([accountGeneration, deviceId, channel, argsKey]);
  const binding = JSON.stringify([
    accountGeneration,
    link.connectionEpoch,
    deviceId,
    channel,
    argsKey,
  ]);
  const online = link.status === 'online' && link.getPresenceAvailability(deviceId) !== false;
  const [state, setState] = useState<{
    identity: string;
    binding: string;
    value: T | null;
    error: boolean;
  }>({ identity, binding, value: null, error: false });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const lastRefresh = useRef({ binding, key: options.refreshKey });
  useFocusEffect(
    useCallback(() => {
      const previous = lastRefresh.current;
      lastRefresh.current = { binding, key: options.refreshKey };
      if (previous.binding === binding && !Object.is(previous.key, options.refreshKey)) {
        const entry = pending.get(binding);
        if (entry) entry.invalidated = true;
      }
      if (!deviceId || !online || options.enabled === false) return;
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let generation = 0;
      const load = () => {
        if (AppState.currentState !== 'active') return;
        const expected = ++generation;
        let entry = pending.get(binding);
        if (entry?.invalidated) {
          void entry.promise
            .finally(() => {
              if (!disposed && generation === expected && currentBinding.current === binding)
                load();
            })
            .catch(() => undefined);
          return;
        }
        if (!entry) {
          entry = {
            promise: link.invoke(deviceId, channel, JSON.parse(argsKey)),
            invalidated: false,
          };
          pending.set(binding, entry);
          const captured = entry;
          void entry.promise
            .finally(() => {
              if (pending.get(binding) === captured) pending.delete(binding);
            })
            .catch(() => undefined);
        }
        void entry.promise
          .then((value) => {
            if (!disposed && generation === expected && currentBinding.current === binding) {
              // A transport or logical failure is not an empty successful snapshot.
              const failed =
                value && typeof value === 'object' && 'ok' in value && value.ok === false;
              setState((previous) => {
                const prior = previous.identity === identity ? previous.value : null;
                if (channel === 'git-context:pr-status' && Array.isArray(value)) {
                  const oldStatuses = new Map(
                    (Array.isArray(prior) ? (prior as PrStatusResult[]) : [])
                      .filter((status) => status.ok)
                      .map((status) => [prStatusKey(status), status]),
                  );
                  const statuses = value as PrStatusResult[];
                  return {
                    identity,
                    binding,
                    value: statuses.map((status) =>
                      status.ok ? status : (oldStatuses.get(prStatusKey(status)) ?? status),
                    ) as T,
                    error: statuses.some((status) => !status.ok),
                  };
                }
                return {
                  identity,
                  binding,
                  value: failed ? prior : (value as T),
                  error: Boolean(failed),
                };
              });
            }
          })
          .catch(() => {
            if (!disposed && generation === expected && currentBinding.current === binding)
              setState((previous) => ({
                identity,
                binding,
                value: previous.identity === identity ? previous.value : null,
                error: true,
              }));
          });
      };
      load();
      const interval = options.refreshIntervalMs
        ? setInterval(load, options.refreshIntervalMs)
        : undefined;
      const unsubscribe = subscribeRemoteBotChanges((source, changedChannel, payload) => {
        if (source !== deviceId || !payload || typeof payload !== 'object') return;
        const row = payload as {
          parentSessionId?: string;
          threadId?: string;
        };
        const relevant =
          channel === 'maker:bot-delegations:list'
            ? changedChannel === 'maker:bot-delegation:changed' &&
              row.parentSessionId === JSON.parse(argsKey)[0]
            : channel === 'maker:bot-direct-message-thread:get' &&
              changedChannel === 'maker:bot-direct-message:changed' &&
              row.threadId === JSON.parse(argsKey)[0];
        if (!relevant) return;
        const entry = pending.get(binding);
        if (entry) entry.invalidated = true;
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          load();
        }, 300);
      });
      const appState = AppState.addEventListener('change', (state) => {
        generation += 1;
        if (state === 'active') load();
      });
      return () => {
        disposed = true;
        unsubscribe();
        appState.remove();
        if (timer) clearTimeout(timer);
        if (interval) clearInterval(interval);
      };
    }, [
      argsKey,
      binding,
      channel,
      deviceId,
      identity,
      link.invoke,
      online,
      revision,
      options.enabled,
      options.refreshIntervalMs,
      options.refreshKey,
    ]),
  );
  return {
    value: options.enabled !== false && state.identity === identity ? state.value : null,
    error: state.identity === identity && (state.error || state.binding !== binding),
    online,
    refresh,
  };
}
