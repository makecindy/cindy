import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { subscribeRemoteBotChanges, useDeviceLink } from '@/device-link/DeviceLinkContext';

const pending = new Map<string, { promise: Promise<unknown>; invalidated: boolean }>();

/** Share concurrent list reads between cards; responses never outlive their account/link. */
export function useRemoteCompanionQuery<T>(deviceId: string, channel: string, args: string[]) {
  const link = useDeviceLink();
  const { accountGeneration } = useAuth();
  const argsKey = JSON.stringify(args);
  const binding = JSON.stringify([accountGeneration, link.connectionEpoch, deviceId, channel, argsKey]);
  const online = link.status === 'online' && link.getPresenceAvailability(deviceId) !== false;
  const [state, setState] = useState<{ binding: string; value: T | null; error: boolean }>({ binding, value: null, error: false });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  useFocusEffect(useCallback(() => {
    if (!deviceId || !online) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const load = () => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      let entry = pending.get(binding);
      if (entry?.invalidated) {
        void entry.promise.finally(() => { if (!disposed && generation === expected && currentBinding.current === binding) load(); }).catch(() => undefined);
        return;
      }
      if (!entry) {
        entry = { promise: link.invoke(deviceId, channel, JSON.parse(argsKey)), invalidated: false };
        pending.set(binding, entry);
        const captured = entry;
        void entry.promise.finally(() => { if (pending.get(binding) === captured) pending.delete(binding); }).catch(() => undefined);
      }
      void entry.promise.then((value) => {
        if (!disposed && generation === expected && currentBinding.current === binding) setState({ binding, value: value as T, error: false });
      }).catch(() => {
        if (!disposed && generation === expected && currentBinding.current === binding) setState({ binding, value: null, error: true });
      });
    };
    load();
    const unsubscribe = subscribeRemoteBotChanges((source, changedChannel, payload) => {
      if (source !== deviceId || !payload || typeof payload !== 'object') return;
      const row = payload as { parentSessionId?: string; threadId?: string };
      const relevant = channel === 'maker:bot-delegations:list'
        ? changedChannel === 'maker:bot-delegation:changed' && row.parentSessionId === JSON.parse(argsKey)[0]
        : changedChannel === 'maker:bot-direct-message:changed' && row.threadId === JSON.parse(argsKey)[0];
      if (!relevant) return;
      const entry = pending.get(binding);
      if (entry) entry.invalidated = true;
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; load(); }, 300);
    });
    const appState = AppState.addEventListener('change', (state) => { generation += 1; if (state === 'active') load(); });
    return () => { disposed = true; unsubscribe(); appState.remove(); if (timer) clearTimeout(timer); };
  }, [argsKey, binding, channel, deviceId, link.invoke, online, revision]));
  return { value: state.binding === binding ? state.value : null, error: state.binding === binding && state.error, online, refresh };
}
