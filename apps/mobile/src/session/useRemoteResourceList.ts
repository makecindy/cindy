import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import {
  cacheRemoteResourceItems, readRemoteResourceSnapshot,
  remoteResourceCacheRevision, subscribeRemoteResourceCache,
} from '@/device-link/remoteResourceCache';
import { isRemoteResourceHostOnline, readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { listRemoteCollection, mergeRemoteCollectionHostShards, normalizeRemoteCollectionItems,
  type HostedRemoteCollectionItem, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { startBoundedStartupRead } from './mobileHomeStartup';

/** One roster reader for resource routes, home and the picker. Host shards reconcile independently. */
export function useRemoteResourceList(collectionId: string, targets: readonly RemoteResourceHostTarget[], enabled = true) {
  const { user, accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const { connectionEpoch, status, presenceVersion, getPresenceAvailability, invoke, openLink,
    onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const owner = `${user?.id ?? ''}:${accountGeneration}`;
  const binding = JSON.stringify([owner, collectionId]);
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const [hydrated, setHydrated] = useState('');
  const [state, setState] = useState<{
    binding: string; items: HostedRemoteCollectionItem[]; replies: Record<string, number>;
    loading: boolean; refreshing: boolean; error: string | null;
  }>(() => ({ binding, items: readRemoteCollectionCache(owner, collectionId), replies: {}, loading: true, refreshing: false, error: null }));
  const generation = useRef(0);
  const active = useRef(false);
  const presenceKey = targets.map((target) => `${target.deviceId}:${getPresenceAvailability(target.deviceId)}`).join('|');
  void presenceVersion;
  useEffect(() => {
    generation.current += 1;
    let cancelled = false;
    const cached = readRemoteCollectionCache(owner, collectionId);
    setState({ binding, items: cached, replies: {}, loading: true, refreshing: false, error: null });
    const cacheRead = startBoundedStartupRead(readRemoteResourceSnapshot(user?.id ?? ''), { home: [], items: {}, read: {} });
    // A slow local cache must not hold up live reads. A late cache never replaces a fresh roster.
    void cacheRead.initial.then(({ value: snapshot }) => {
      if (cancelled || bindingRef.current !== binding) return;
      setState((current) => ({ ...current, items: current.items.length ? current.items : snapshot.items[collectionId] ?? [] }));
      setHydrated(binding);
    });
    return () => { cancelled = true; generation.current += 1; };
  }, [binding, collectionId, owner, user?.id]);

  const refresh = useCallback(async (visible = true) => {
    if (!enabled || !active.current || hydrated !== binding || !collectionId) return;
    const expected = ++generation.current;
    const current = () => generation.current === expected && bindingRef.current === binding && active.current;
    setState((old) => ({ ...old, loading: true, refreshing: visible, error: null }));
    const next: HostedRemoteCollectionItem[] = [];
    const succeeded = new Set<string>();
    const failures: string[] = [];
    // Resource refresh must not fan out an unbounded burst on the shared relay.
    for (let offset = 0; offset < targets.length; offset += 2) {
      if (!current()) return;
      const results = await Promise.allSettled(targets.slice(offset, offset + 2).map(async (host) => {
        if (status !== 'online' || getPresenceAvailability(host.deviceId) === false) throw new Error(t('devices.resources.hostOffline'));
        await openLink(host.deviceId);
        const response = await listRemoteCollection(invoke, host, collectionId, i18n.language);
        if (!response || !Array.isArray(response.items)) throw new Error(t('devices.resources.loadFailed'));
        return { host, items: normalizeRemoteCollectionItems(response, collectionId) };
      }));
      if (!current()) return;
      for (const result of results) {
        if (result.status === 'rejected') { failures.push(formatRemoteError(result.reason)); continue; }
        const { host, items } = result.value;
        succeeded.add(host.deviceId);
        for (const item of items) next.push({ host, item, key: JSON.stringify([host.deviceId, item.ref.collectionId, item.ref.kind, item.ref.id]) });
      }
    }
    if (!current()) return;
    setState((old) => {
      const items = mergeRemoteCollectionHostShards(old.items, next, succeeded, targets);
      return { binding, items, replies: Object.fromEntries([...succeeded].map((id) => [id, connectionEpoch])),
        loading: false, refreshing: false,
        error: failures.length ? failures.slice(0, 2).join('\n') : targets.length ? null : t('devices.resources.noHosts') };
    });
  }, [binding, collectionId, connectionEpoch, enabled, getPresenceAvailability, hydrated, i18n.language, invoke, openLink, presenceKey, status, t, targets]);

  // Persist after commit, never from a React state updater (which may be replayed).
  useEffect(() => {
    if (state.binding !== binding || state.loading || hydrated !== binding) return;
    writeRemoteCollectionCache(owner, collectionId, state.items);
    void cacheRemoteResourceItems(user?.id ?? '', collectionId, state.items);
  }, [binding, collectionId, hydrated, owner, state.items, state.loading, state.binding, user?.id]);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    active.current = true;
    void refresh(false);
    const foreground = AppState.addEventListener('change', (value) => { if (value === 'active') void refresh(false); });
    const off = onRemoteResourceChanged((deviceId, payload) => {
      if (AppState.currentState === 'active' && payload.collectionId === collectionId && targets.some((host) => host.deviceId === deviceId)) void refresh(false);
    });
    const cleanups = targets.map((target) => startFocusedTopicSubscription({
      deviceId: target.deviceId, owner: `remote-collection:${collectionId}:${target.deviceId}`,
      subscribe, topic: 'sessions', unsubscribe,
    }));
    return () => { active.current = false; generation.current += 1; foreground.remove(); off(); cleanups.forEach((cleanup) => cleanup()); };
  }, [collectionId, enabled, onRemoteResourceChanged, refresh, subscribe, targets, unsubscribe]));
  const ownState = state.binding === binding;
  const isOnline = useCallback((host: RemoteResourceHostTarget) => ownState && isRemoteResourceHostOnline(
    status, getPresenceAvailability(host.deviceId), state.replies[host.deviceId], connectionEpoch,
  ), [connectionEpoch, getPresenceAvailability, ownState, presenceKey, state.replies, status]);
  return {
    items: ownState ? state.items : [],
    loading: !ownState || state.loading || hydrated !== binding,
    refreshing: ownState && state.refreshing,
    error: ownState ? state.error : null,
    isOnline, refresh,
  };
}
