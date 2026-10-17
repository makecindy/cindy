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
import { remoteResourceConnectionState, hasRemoteCollectionCache, isRemoteResourceHostOnline, readRemoteCollectionCache, writeRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { listRemoteCollection, mergeRemoteCollectionHostShards, normalizeRemoteCollectionItems,
  type HostedRemoteCollectionItem, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError, isAutoRecoveringRemoteError } from '@/device-link/remoteStatus';
import { createRemoteReadRecovery } from '@/device-link/remoteReadRecovery';
import { retryRemoteSyncRead, type RemoteSyncRun, useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
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
    settled: boolean; loading: boolean; refreshing: boolean; error: string | null;
  }>(() => ({ binding, items: readRemoteCollectionCache(owner, collectionId), replies: {}, settled: hasRemoteCollectionCache(owner, collectionId), loading: true, refreshing: false, error: null }));
  const generation = useRef(0);
  const active = useRef(false);
  const focusController = useRef(new AbortController());
  const recovery = useRef<ReturnType<typeof createRemoteReadRecovery> | null>(null);
  const failedHosts = useRef(new Set<string>());
  const presenceKey = targets.map((target) => `${target.deviceId}:${getPresenceAvailability(target.deviceId)}`).join('|');
  void presenceVersion;
  useEffect(() => {
    generation.current += 1;
    let cancelled = false;
    const cached = readRemoteCollectionCache(owner, collectionId);
    setState({ binding, items: cached, replies: {}, settled: hasRemoteCollectionCache(owner, collectionId), loading: true, refreshing: false, error: null });
    const cacheRead = startBoundedStartupRead(readRemoteResourceSnapshot(user?.id ?? ''), { home: [], items: {}, read: {} });
    // A slow local cache must not hold up live reads. A late cache never replaces a fresh roster.
    void cacheRead.initial.then(({ value: snapshot }) => {
      if (cancelled || bindingRef.current !== binding) return;
      setState((current) => ({ ...current, items: current.items.length ? current.items : snapshot.items[collectionId] ?? [] }));
      setHydrated(binding);
    });
    return () => { cancelled = true; generation.current += 1; };
  }, [binding, collectionId, owner, user?.id]);

  const read = useCallback(async (run: RemoteSyncRun) => {
    if (!enabled || !active.current || hydrated !== binding || !collectionId) return;
    const expected = ++generation.current;
    const signal = focusController.current.signal;
    const current = () => !run.isStale() && !signal.aborted && generation.current === expected
      && bindingRef.current === binding && active.current && AppState.currentState === 'active';
    const selected = run.reasons.every(reason => reason === 'retry')
      ? targets.filter(host => failedHosts.current.has(host.deviceId)) : targets;
    failedHosts.current.clear();
    setState((old) => ({ ...old, loading: true, refreshing: run.reasons.includes('visible'), error: null }));
    const failures: unknown[] = [];
    let offset = 0;
    // Two workers, committing each host as it answers. A slow peer does not
    // hold successful shards or the next free worker behind a batch barrier.
    const worker = async () => {
      while (offset < selected.length && current()) {
        const host = selected[offset++];
        try {
          if (status !== 'online' || getPresenceAvailability(host.deviceId) === false) throw new Error(t('devices.resources.hostOffline'));
          const response = await retryRemoteSyncRead({ signal, isStale: () => !current() }, async () => {
            await openLink(host.deviceId);
            return listRemoteCollection(invoke, host, collectionId, i18n.language);
          });
          if (!current()) return;
          if (!response || !Array.isArray(response.items)) throw new Error(t('devices.resources.loadFailed'));
          const next = normalizeRemoteCollectionItems(response, collectionId).map(item => ({ host, item,
            key: JSON.stringify([host.deviceId, item.ref.collectionId, item.ref.kind, item.ref.id]) }));
          setState(old => ({ ...old,
            items: mergeRemoteCollectionHostShards(old.items, next, new Set([host.deviceId]), targets),
            replies: { ...old.replies, [host.deviceId]: connectionEpoch }, settled: true,
          }));
        } catch (error) {
          if (!current()) return;
          failures.push(error);
          if (isAutoRecoveringRemoteError(error)) failedHosts.current.add(host.deviceId);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (!current()) return;
    setState((old) => ({ ...old, binding,
      items: mergeRemoteCollectionHostShards(old.items, [], new Set(), targets),
      replies: Object.fromEntries(Object.entries(old.replies).filter(([id]) => targets.some(host => host.deviceId === id))),
      settled: true, loading: false, refreshing: false,
      error: failures.length ? failures.slice(0, 2).map(formatRemoteError).join('\n') : targets.length ? null : t('devices.resources.noHosts'),
    }));
    if (!failures.length) recovery.current?.succeeded();
    else failures.forEach(error => recovery.current?.failed(error));
  }, [binding, collectionId, connectionEpoch, enabled, getPresenceAvailability, hydrated, i18n.language, invoke, openLink, presenceKey, status, t, targets]);

  // Phase pushes can arrive faster than a roster RPC. Keep one active read and
  // one latest follow-up, using the same coordinator as other remote snapshots.
  const requestRefresh = useRemoteSyncCoordinator(
    read, JSON.stringify([binding, connectionEpoch, status, presenceKey, targets, enabled, hydrated]),
  );
  const refresh = useCallback((visible = true) => requestRefresh({ reason: visible ? 'visible' : 'changed' }), [read, requestRefresh]);

  // Persist after commit, never from a React state updater (which may be replayed).
  useEffect(() => {
    if (state.binding !== binding || !state.settled || hydrated !== binding) return;
    writeRemoteCollectionCache(owner, collectionId, state.items);
    void cacheRemoteResourceItems(user?.id ?? '', collectionId, state.items);
  }, [binding, collectionId, hydrated, owner, state.items, state.settled, state.binding, user?.id]);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    const start = () => {
      active.current = AppState.currentState === 'active';
      focusController.current = new AbortController();
      recovery.current = createRemoteReadRecovery(() => { void requestRefresh({ reason: 'retry' }); },
        () => active.current && status === 'online' && AppState.currentState === 'active');
      if (active.current) void refresh(false);
    };
    const stop = () => { active.current = false; generation.current += 1;
      focusController.current.abort(); recovery.current?.dispose(); };
    start();
    const foreground = AppState.addEventListener('change', (value) => { stop(); if (value === 'active') start(); });
    const off = onRemoteResourceChanged((deviceId, payload) => {
      if (AppState.currentState === 'active' && payload.collectionId === collectionId && targets.some((host) => host.deviceId === deviceId)) void refresh(false);
    });
    const cleanups = targets.map((target) => startFocusedTopicSubscription({
      deviceId: target.deviceId, owner: `remote-collection:${collectionId}:${target.deviceId}`,
      subscribe, topic: 'sessions', unsubscribe,
    }));
    return () => { stop(); foreground.remove(); off(); cleanups.forEach((cleanup) => cleanup()); };
  }, [collectionId, enabled, onRemoteResourceChanged, refresh, requestRefresh, status, subscribe, targets, unsubscribe]));
  const ownState = state.binding === binding;
  const isOnline = useCallback((host: RemoteResourceHostTarget) => ownState && isRemoteResourceHostOnline(
    status, getPresenceAvailability(host.deviceId), state.replies[host.deviceId], connectionEpoch,
  ), [connectionEpoch, getPresenceAvailability, ownState, presenceKey, state.replies, status]);
  return {
    items: ownState ? state.items : [],
    loading: !ownState || (!state.settled && state.items.length === 0 && (state.loading || hydrated !== binding)),
    syncing: !ownState || state.loading || hydrated !== binding,
    refreshing: ownState && state.refreshing,
    error: ownState ? state.error : null,
    isOnline, refresh,
    connectionState: (host: RemoteResourceHostTarget) => ownState ? remoteResourceConnectionState(status, getPresenceAvailability(host.deviceId)) : null,
  };
}
