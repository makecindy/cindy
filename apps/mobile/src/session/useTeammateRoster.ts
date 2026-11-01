import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { REMOTE_RESOURCE_MANIFEST_CHANNEL, type RemoteResourceManifestResponse } from '@cindy/device-link';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useRelayDataGeneration } from '@/device-link/useRelayDataGeneration';
import { getSelfHostedRelayDataKey } from '@/device-link/selfHostedRelayRouting';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { cacheRemoteResourceHome, readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import { REMOTE_RESOURCE_STARTUP_TIMEOUT_MS, readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { discoverRemoteHomeCollections, remoteResourceDiscoveryTargets,
  type RemoteHomeCollection, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError, isAutoRecoveringRemoteError } from '@/device-link/remoteStatus';
import { hasBotGroupCollection } from './botGroupRemote';
import { useRemoteResourceList } from './useRemoteResourceList';
import { createRemoteReadRecovery } from '@/device-link/remoteReadRecovery';
import { retryRemoteSyncRead, type RemoteSyncRun, useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import { startBoundedStartupRead } from './mobileHomeStartup';

const NO_TARGETS: RemoteResourceHostTarget[] = [];
export const TEAMMATE_COLLECTION_ID = 'teammates';

/** Discover real host capabilities; no provisioning, bot creation, or name-based identity guessing. */
export function useTeammateRoster(enabled = true) {
  const { user, accountGeneration: authGeneration } = useAuth();
  const accountGeneration = useRelayDataGeneration(authGeneration);
  const cacheUserId = user?.id ? JSON.stringify([user.id, getSelfHostedRelayDataKey()]) : '';
  const { t, i18n } = useTranslation();
  const { readDeviceList, invoke, openLink, connectionEpoch, status, presenceVersion } = useDeviceLink();
  const revoked = useRevokedDevices();
  const binding = JSON.stringify([user?.id ?? '', accountGeneration, getSelfHostedRelayDataKey()]);
  const ownerRef = useRef(binding); ownerRef.current = binding;
  const generation = useRef(0);
  const active = useRef(false);
  const focusController = useRef(new AbortController());
  const recovery = useRef<ReturnType<typeof createRemoteReadRecovery> | null>(null);
  const lastCollections = useRef<{ binding: string; home: RemoteHomeCollection[] }>({ binding: '', home: [] });
  const failedHosts = useRef(new Set<string>());
  const lastCreateTargets = useRef<{ binding: string; targets: RemoteResourceHostTarget[] }>({ binding: '', targets: NO_TARGETS });
  // Hosts whose manifest advertises group chats (bot-group-chat.md §8); an older desktop never does.
  const lastGroupTargets = useRef<{ binding: string; targets: RemoteResourceHostTarget[] }>({ binding: '', targets: NO_TARGETS });
  const [discovery, setDiscovery] = useState<{
    binding: string; ready: boolean; loading: boolean; settled: boolean; targets: RemoteResourceHostTarget[]; createTargets: RemoteResourceHostTarget[];
    groupTargets: RemoteResourceHostTarget[]; error: string | null;
  }>({ binding: '', ready: false, loading: true, settled: false, targets: NO_TARGETS, createTargets: NO_TARGETS, groupTargets: NO_TARGETS, error: null });
  const discover = useCallback(async (run: RemoteSyncRun) => {
    const expected = ++generation.current;
    const signal = focusController.current.signal;
    const current = () => !run.isStale() && !signal.aborted && active.current && AppState.currentState === 'active'
      && ownerRef.current === binding && generation.current === expected;
    setDiscovery((old) => ({ ...old, loading: true }));
    const { value: snapshot } = await startBoundedStartupRead(readRemoteResourceSnapshot(cacheUserId), { home: [], items: {}, read: {} }).initial;
    if (!current()) return;
    let collections: RemoteHomeCollection[] = lastCollections.current.binding === binding ? lastCollections.current.home : snapshot.home;
    if (lastCollections.current.binding !== binding) {
      const cachedItems = snapshot.items[TEAMMATE_COLLECTION_ID]?.length ? snapshot.items[TEAMMATE_COLLECTION_ID]
        : readRemoteCollectionCache(binding, TEAMMATE_COLLECTION_ID);
      const previous = collections.find(collection => collection.id === TEAMMATE_COLLECTION_ID && collection.resourceKind === 'bot');
      // Home capabilities and roster rows are saved independently. Until the
      // directory/manifest answers, both caches are navigation hints.
      const hosts = new Map([...(previous?.targets ?? []), ...cachedItems.map(row => row.host)]
        .map(host => [host.deviceId, host]));
      if (hosts.size) collections = previous
        ? collections.map(collection => collection === previous ? { ...collection, targets: [...hosts.values()] } : collection)
        : [...collections, { id: TEAMMATE_COLLECTION_ID, resourceKind: 'bot', placement: 'home-scope', title: '', targets: [...hosts.values()] }];
    }
    const publish = (home: RemoteHomeCollection[], loading: boolean) => {
      if (!current()) return;
      const targets = home.find(collection => collection.id === TEAMMATE_COLLECTION_ID && collection.resourceKind === 'bot')?.targets ?? NO_TARGETS;
      lastCollections.current = { binding, home };
      const filtered = targets.filter(host => !revoked.has(host.deviceId));
      setDiscovery(old => ({ ...old, binding, ready: true, loading, settled: old.binding === binding && old.settled,
        createTargets: old.binding === binding ? old.createTargets : NO_TARGETS,
        groupTargets: old.binding === binding ? old.groupTargets : NO_TARGETS,
        targets: old.binding === binding && JSON.stringify(old.targets) === JSON.stringify(filtered) ? old.targets : filtered }));
    };
    // Cached capabilities are navigation hints; authorization stays at the host.
    publish(collections, true);
    // During relay startup the cached directory remains a navigation hint, but
    // the roster must stay in its loading state until a live directory read.
    // The status dependency reruns this coordinator after the relay is online.
    if (status === 'stopped' || status === 'connecting') return;
    const failures: unknown[] = [];
    let error: string | null = null;
    const createTargets: RemoteResourceHostTarget[] = [];
    const retryHosts = new Set(failedHosts.current);
    const retryOnly = run.reasons.every(reason => reason === 'retry') && retryHosts.size > 0;
    if (!retryOnly) failedHosts.current.clear();
    const previousGroupTargets = lastGroupTargets.current.binding === binding ? lastGroupTargets.current.targets : NO_TARGETS;
    let groupTargets = previousGroupTargets;
    try {
      if (status !== 'online') throw new Error(t('devices.resources.hostOffline'));
      const response = await retryRemoteSyncRead({ signal, isStale: () => !current() }, readDeviceList);
      if (!current()) return;
      failedHosts.current.clear();
      const devices = toDeviceListItems(response.devices, Date.now(), revoked).map((row) => ({
        deviceId: row.device.deviceId, name: row.device.name, canOpen: row.canOpen, state: row.state,
      }));
      const targets = remoteResourceDiscoveryTargets(devices, collections);
      // Drop removed/disabled/revoked hosts even if the optional manifest call fails.
      collections = collections.map((collection) => ({ ...collection,
        targets: collection.targets.filter((host) => targets.some((target) => target.deviceId === host.deviceId)),
      }));
      publish(collections, true);
      // Healthy shards keep their last capabilities. A failed peer must not
      // repeatedly reopen other computers or make their roster read start over.
      if (retryOnly && lastCreateTargets.current.binding === binding) {
        createTargets.push(...lastCreateTargets.current.targets.filter(host => !retryHosts.has(host.deviceId)
          && targets.some(target => target.deviceId === host.deviceId)));
      }
      const selected = targets.map(target => retryOnly && !retryHosts.has(target.deviceId)
        ? { ...target, offline: true } : target);
      const answered = new Set<string>();
      const advertisingGroups = new Set<string>();
      collections = await discoverRemoteHomeCollections(async <T,>(deviceId: string, channel: string, args?: unknown[]) => {
        let response: T;
        try {
          response = await retryRemoteSyncRead({ signal, isStale: () => !current() }, async () => {
            await openLink(deviceId);
            return invoke<T>(deviceId, channel, args);
          });
        } catch (cause) {
          if (current()) {
            mobileDebugLog('warn', 'recovery', 'companion-roster-refresh', { source: 'computer-manifest' });
            failures.push(cause);
            if (isAutoRecoveringRemoteError(cause)) failedHosts.current.add(deviceId);
          }
          throw cause;
        }
        if (!current()) throw new Error('Remote discovery superseded');
        if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) {
          const manifest = response as RemoteResourceManifestResponse | null;
          answered.add(deviceId);
          if (hasBotGroupCollection(manifest)) advertisingGroups.add(deviceId);
          if (manifest?.collections?.some((collection) => collection.id === TEAMMATE_COLLECTION_ID
            && collection.resourceKind === 'bot' && collection.actions?.some((action) => action.id === 'open-create'))) {
            const host = targets.find((target) => target.deviceId === deviceId);
            if (host) createTargets.push(host);
          }
        }
        return response;
      }, selected, i18n.language, collections, home => publish(home, true));
      if (!current()) return;
      // A host that did not answer this time keeps its groups until it answers again.
      groupTargets = targets.filter((target) => advertisingGroups.has(target.deviceId)
        || (!answered.has(target.deviceId) && previousGroupTargets.some((host) => host.deviceId === target.deviceId)));
      void cacheRemoteResourceHome(cacheUserId, collections);
    } catch (cause) {
      mobileDebugLog('warn', 'recovery', 'companion-roster-refresh', { source: 'computer-directory' });
      error = formatRemoteError(cause); failures.push(cause);
    }
    if (!current()) return;
    lastCollections.current = { binding, home: collections };
    if (!failures.length) recovery.current?.succeeded();
    else failures.forEach(cause => recovery.current?.failed(cause));
    const targets = collections.find((collection) => collection.id === TEAMMATE_COLLECTION_ID && collection.resourceKind === 'bot')?.targets ?? NO_TARGETS;
    groupTargets = groupTargets.filter((host) => !revoked.has(host.deviceId));
    lastGroupTargets.current = { binding, targets: groupTargets };
    lastCreateTargets.current = { binding, targets: createTargets };
    const filtered = targets.filter(host => !revoked.has(host.deviceId));
    setDiscovery(old => ({ binding, ready: true, loading: false, settled: true, createTargets,
      targets: old.binding === binding && JSON.stringify(old.targets) === JSON.stringify(filtered) ? old.targets : filtered,
      groupTargets, error: error ?? (failures.length ? formatRemoteError(failures[0]) : null) }));
  }, [binding, cacheUserId, i18n.language, invoke, openLink, readDeviceList, revoked, status, t, user?.id]);
  useEffect(() => {
    if (!enabled || discovery.binding !== binding || !discovery.ready || discovery.settled
      || (status !== 'stopped' && status !== 'connecting')) return;
    const timer = setTimeout(() => {
      setDiscovery((old) => old.binding === binding && !old.settled ? {
        ...old, settled: true, loading: false, error: t('devices.resources.hostOffline'),
      } : old);
    }, REMOTE_RESOURCE_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [binding, discovery.binding, discovery.ready, discovery.settled, enabled, status, t]);
  const requestDiscover = useRemoteSyncCoordinator(discover, JSON.stringify([binding, connectionEpoch, presenceVersion, status, enabled]));
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    const start = () => {
      active.current = AppState.currentState === 'active';
      focusController.current = new AbortController();
      recovery.current = createRemoteReadRecovery(() => { void requestDiscover({ reason: 'retry' }); },
        () => active.current && status === 'online' && AppState.currentState === 'active');
      if (active.current) void requestDiscover({ reason: 'focus' });
    };
    const stop = () => { active.current = false; generation.current += 1;
      focusController.current.abort(); recovery.current?.dispose(); };
    start();
    const foreground = AppState.addEventListener('change', (value) => { stop(); if (value === 'active') start(); });
    return () => { stop(); foreground.remove(); };
  }, [connectionEpoch, discover, enabled, presenceVersion, requestDiscover, status]));
  const ready = discovery.binding === binding && discovery.ready;
  const list = useRemoteResourceList(TEAMMATE_COLLECTION_ID, ready ? discovery.targets : NO_TARGETS, enabled && ready);
  // Discover refreshes targets too: newly online hosts and newly created rosters are not stranded.
  const refresh = useCallback(async () => { await requestDiscover({ reason: 'visible' }); await list.refresh(); }, [requestDiscover, list.refresh]);
  const items = list.items.filter(row => row.item.ref.kind === 'bot' && !revoked.has(row.host.deviceId)
    && (!ready || discovery.targets.some(host => host.deviceId === row.host.deviceId)));
  return { ...list, items,
    isOnline: (host: RemoteResourceHostTarget) => ready && !revoked.has(host.deviceId) && list.isOnline(host),
    targets: ready ? discovery.targets : NO_TARGETS,
    /** Computers with group chats; empty until discovery ran, and for older desktops. */
    // Stable reference (revocation is applied at discovery and again to the listed rows).
    groupTargets: ready ? discovery.groupTargets : NO_TARGETS,
    createTargets: ready && status === 'online' ? discovery.createTargets.filter((host) => !revoked.has(host.deviceId) && list.isOnline(host)) : NO_TARGETS,
    authoritative: ready && !discovery.loading && !list.loading && !list.syncing && status === 'online' && !discovery.error
      && (!discovery.targets.length || (!list.error && discovery.targets.every(list.isOnline))),
    loading: !ready || !discovery.settled || list.loading,
    refreshing: list.refreshing,
    error: ready ? discovery.error ?? (discovery.targets.length ? list.error : null) : null, refresh };
}
