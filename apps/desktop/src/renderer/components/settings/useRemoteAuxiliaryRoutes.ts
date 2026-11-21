import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseRemoteUtilityResponse, REMOTE_UTILITY_TEXT_CHANNEL, type RemoteUtilityRoute } from '@cindy/device-link';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { isDeviceModelVisible } from '@/lib/providerModels';
import { remoteAgentProviders } from '@/components/new-chat/unifiedModelSelection';
import type { ModelSelectorRouteFilter } from '@/components/new-chat/modelSelectorRouteFilter';
import { encodeRemoteAuxiliaryModelRef } from '../../../shared/remoteAuxiliaryModelRef';
import { extractIpcError } from '@/utils/ipcError';

type CapabilityStatus = 'loading' | 'ready' | 'outdated' | 'offline' | 'revoked' | 'unavailable';
type Snapshot = { catalog: unknown; status: CapabilityStatus; routes: RemoteUtilityRoute[] };

function failureStatus(error: unknown): CapabilityStatus {
  const code = extractIpcError(error)?.code;
  if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return 'outdated';
  if (code === 'DEVICE_LINK_DEVICE_OFFLINE') return 'offline';
  if (code === 'DEVICE_LINK_ACCESS_REVOKED') return 'revoked';
  return 'unavailable';
}

/** One caps snapshot per visible device, shared by all three slots. Catalogs remain in the existing cache. */
export function useRemoteAuxiliaryRoutes(open: boolean) {
  const { devices } = useSelectableDevices();
  const idsKey = open ? devices.filter((device) => device.online).map((device) => device.deviceId).join('\n') : '';
  const ids = useMemo(() => idsKey ? idsKey.split('\n') : [], [idsKey]);
  const catalogs = useDevicesProviders(ids);
  const snapshots = useRef(new Map<string, Snapshot>());
  const [, setRevision] = useState(0);

  // The map is scoped to this visible picker session; clearing it also invalidates in-flight replies.
  useEffect(() => () => { snapshots.current.clear(); }, []);
  useEffect(() => {
    const current = snapshots.current;
    let changed = false;
    for (const id of current.keys()) {
      const catalog = catalogs.get(id);
      if (!open || !ids.includes(id) || !catalog || catalog.loading || catalog.error || current.get(id)?.catalog !== catalog.providers) {
        current.delete(id);
        changed = true;
      }
    }
    if (open) for (const deviceId of ids) {
      const catalog = catalogs.get(deviceId);
      if (!catalog || catalog.loading || catalog.error || current.has(deviceId)) continue;
      const snapshot: Snapshot = { catalog: catalog.providers, status: 'loading', routes: [] };
      current.set(deviceId, snapshot);
      changed = true;
      void window.electronAPI.deviceLink.invoke(deviceId, REMOTE_UTILITY_TEXT_CHANNEL, [{ version: 1, op: 'caps' }])
        .then((raw) => {
          const response = parseRemoteUtilityResponse(raw);
          if (current.get(deviceId) !== snapshot) return;
          if (response.op === 'caps' && response.ok) {
            snapshot.status = 'ready';
            snapshot.routes = response.allowedRoutes;
          } else {
            snapshot.status = response.op === 'error' && response.code === 'UNAUTHORIZED' ? 'revoked' : 'unavailable';
          }
          setRevision((value) => value + 1);
        }).catch((error) => {
          if (current.get(deviceId) !== snapshot) return;
          snapshot.status = failureStatus(error);
          setRevision((value) => value + 1);
        });
    }
    if (changed) setRevision((value) => value + 1);
  }, [open, ids, catalogs]);

  const allows = useCallback<ModelSelectorRouteFilter>(({ deviceId, providerId, agentKind, model }) => {
    if (!deviceId) return false;
    const catalog = catalogs.get(deviceId);
    const snapshot = snapshots.current.get(deviceId);
    if (!open || !catalog || catalog.loading || catalog.error || snapshot?.catalog !== catalog.providers || snapshot.status !== 'ready') return false;
    if (!snapshot.routes.some((route) => route.providerId === providerId && route.agentKind === agentKind && route.model === model)) return false;
    const provider = remoteAgentProviders(catalog.providers).find((item) => item.id === providerId);
    if (!provider || !provider.connected || provider.suspended || (provider as { group?: unknown }).group) return false;
    const entry = provider.models[agentKind]?.find((item) => item.id === model);
    return !!entry && !entry.disabled && isDeviceModelVisible(catalog.modelVisibilityOverrides, agentKind, providerId, entry);
  }, [catalogs, open, snapshots]);

  const encode = useCallback((deviceId: string, providerId: string, agentKind: RemoteUtilityRoute['agentKind'], model: string) => {
    if (!allows({ deviceId, providerId, agentKind, model })) return null;
    try {
      const ref = encodeRemoteAuxiliaryModelRef({ deviceId, providerId, agentKind, model });
      return ref.length <= 768 ? ref : null;
    } catch {
      return null;
    }
  }, [allows]);
  const statuses = open ? devices.flatMap((device) => {
    const { deviceId, name } = device;
    if (!device.online) return [{ deviceId, name, status: 'offline' as const }];
    const catalog = catalogs.get(deviceId);
    const snapshot = snapshots.current.get(deviceId);
    const status = catalog?.error ? failureStatus(new Error(catalog.error))
      : snapshot && snapshot.catalog === catalog?.providers ? snapshot.status : undefined;
    return status && status !== 'ready' && status !== 'loading'
      ? [{ deviceId, name, status }] : [];
  }) : [];
  return { devices, allows, encode, statuses };
}
