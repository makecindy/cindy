import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { REMOTE_RESOURCE_MANIFEST_CHANNEL, type RemoteResourceManifestResponse } from '@cindy/device-link';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { cacheRemoteResourceHome, readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import { discoverRemoteHomeCollections, remoteResourceDiscoveryTargets,
  type RemoteHomeCollection, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useRemoteResourceList } from './useRemoteResourceList';
import { startBoundedStartupRead } from './mobileHomeStartup';

const NO_TARGETS: RemoteResourceHostTarget[] = [];
export const TEAMMATE_COLLECTION_ID = 'teammates';

/** Discover real host capabilities; no provisioning, bot creation, or name-based identity guessing. */
export function useTeammateRoster(enabled = true) {
  const { user, accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const { readDeviceList, invoke, openLink, connectionEpoch, status, presenceVersion } = useDeviceLink();
  const revoked = useRevokedDevices();
  const binding = `${user?.id ?? ''}:${accountGeneration}`;
  const ownerRef = useRef(binding); ownerRef.current = binding;
  const generation = useRef(0);
  const [discovery, setDiscovery] = useState<{
    binding: string; ready: boolean; loading: boolean; targets: RemoteResourceHostTarget[]; createTargets: RemoteResourceHostTarget[]; error: string | null;
  }>({ binding: '', ready: false, loading: true, targets: NO_TARGETS, createTargets: NO_TARGETS, error: null });
  const discover = useCallback(async () => {
    const expected = ++generation.current;
    const current = () => ownerRef.current === binding && generation.current === expected;
    setDiscovery((old) => ({ ...old, loading: true }));
    const { value: snapshot } = await startBoundedStartupRead(readRemoteResourceSnapshot(user?.id ?? ''), { home: [], items: {}, read: {} }).initial;
    if (!current()) return;
    let collections: RemoteHomeCollection[] = snapshot.home;
    let error: string | null = null;
    const createTargets: RemoteResourceHostTarget[] = [];
    try {
      if (status !== 'online') throw new Error(t('devices.resources.hostOffline'));
      const response = await readDeviceList();
      if (!current()) return;
      const devices = toDeviceListItems(response.devices, Date.now(), revoked).map((row) => ({
        deviceId: row.device.deviceId, name: row.device.name, canOpen: row.canOpen, state: row.state,
      }));
      const targets = remoteResourceDiscoveryTargets(devices, collections);
      // Drop removed/disabled/revoked hosts even if the optional manifest call fails.
      collections = collections.map((collection) => ({ ...collection,
        targets: collection.targets.filter((host) => targets.some((target) => target.deviceId === host.deviceId)),
      }));
      collections = await discoverRemoteHomeCollections(async <T,>(deviceId: string, channel: string, args?: unknown[]) => {
        await openLink(deviceId);
        const response = await invoke<T>(deviceId, channel, args);
        if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) {
          const manifest = response as RemoteResourceManifestResponse | null;
          if (manifest?.collections?.some((collection) => collection.id === TEAMMATE_COLLECTION_ID
            && collection.resourceKind === 'bot' && collection.actions?.some((action) => action.id === 'open-create'))) {
            const host = targets.find((target) => target.deviceId === deviceId);
            if (host) createTargets.push(host);
          }
        }
        return response;
      }, targets, i18n.language, collections);
      if (!current()) return;
      void cacheRemoteResourceHome(user?.id ?? '', collections);
    } catch (cause) { error = formatRemoteError(cause); }
    if (!current()) return;
    const targets = collections.find((collection) => collection.id === TEAMMATE_COLLECTION_ID && collection.resourceKind === 'bot')?.targets ?? NO_TARGETS;
    setDiscovery({ binding, ready: true, loading: false, createTargets, targets: targets.filter((host) => !revoked.has(host.deviceId)), error });
  }, [binding, i18n.language, invoke, openLink, readDeviceList, revoked, status, t, user?.id]);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    void discover();
    const foreground = AppState.addEventListener('change', (value) => { if (value === 'active') void discover(); });
    return () => { generation.current += 1; foreground.remove(); };
  }, [connectionEpoch, discover, enabled, presenceVersion]));
  const ready = discovery.binding === binding && discovery.ready;
  const list = useRemoteResourceList(TEAMMATE_COLLECTION_ID, ready ? discovery.targets : NO_TARGETS, enabled && ready);
  // Discover refreshes targets too: newly online hosts and newly created rosters are not stranded.
  const refresh = useCallback(async () => { await discover(); }, [discover]);
  return { ...list, items: ready ? list.items.filter((row) => row.item.ref.kind === 'bot') : [],
    targets: ready ? discovery.targets : NO_TARGETS,
    createTargets: ready && status === 'online' ? discovery.createTargets.filter((host) => !revoked.has(host.deviceId) && list.isOnline(host)) : NO_TARGETS,
    authoritative: ready && !discovery.loading && !list.loading && status === 'online' && !discovery.error && (!discovery.targets.length || !list.error),
    loading: !ready || discovery.loading || list.loading,
    refreshing: discovery.binding === binding && (discovery.loading || list.refreshing),
    error: ready ? discovery.error ?? list.error : null, refresh };
}
