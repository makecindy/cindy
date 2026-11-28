/**
 * usePickerPluginEngines — shared plugin engine source collector for model pickers outside the
 * composer (IM defaults, Feishu groups, Hook workspace prefs, Model Groups, Orca worker creation).
 *
 * Mirrors CCAgentSessionView / NewMakerDraftRoute:
 *  - On this computer (`hostDeviceId` omitted): combines local plugin engines, online same-account
 *    peer computers, received plugin-engine provider shares, and any remembered offline/selected
 *    device IDs so saved plugin engine routes always resolve their name/icon/modes.
 *  - On a remote host (`hostDeviceId` set): reads that host's own plugin engines (via Device Link),
 *    discovers its peer computers and received plugin-engine shares via `useControlledModelLocations`
 *    + `controlledPluginEngineSources`, and routes all non-host catalogue reads through
 *    `modelCatalogKey(id, hostDeviceId)` so the controlled computer resolves them with its own grants.
 *
 * When `enabled` is false, all remote location/share/catalogue reads are gated off so mounted
 * closed popovers emit zero Device Link traffic.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useControlledModelLocations } from '@/hooks/useControlledModelLocations';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import {
  findPluginEngine,
  requestPluginEnginesRefresh,
  useDevicesPluginEngines,
  usePluginEngines,
  useRemotePluginEngines,
} from '@/hooks/usePluginEngines';
import { deviceDisplayName } from '@/lib/deviceName';
import {
  controlledPluginEngineSources,
  isSamePluginEngineChoice,
  remotePluginEngineChoices,
  type PluginEngineChoice,
  type PluginEngineSource,
} from '@/lib/pluginEngineSelection';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { modelCatalogKey } from '../../shared/controlledModelCatalog';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

export interface UsePickerPluginEnginesOptions {
  /** Whether plugin engines can be selected in this picker (e.g. false for SSH or closed modal). */
  enabled?: boolean;
  /**
   * When set, list plugin engines offered by that remote host computer rather than this computer
   * + all peer computers (e.g. editing a remote computer's settings or spawning on a remote Lead).
   */
  hostDeviceId?: string | null;
  /** Currently saved/selected plugin engine device IDs to keep resolved even if offline. */
  rememberedDeviceIds?: readonly (string | null | undefined)[];
}

export interface PickerPluginEnginesResult {
  engines: readonly PluginEngineChoice[];
  /** True when at least one engine or remote/shared source is available to browse. */
  hasSources: boolean;
  /** Ask local/remote plugins to refresh/read catalogues when the picker opens. */
  readCatalogue: () => void;
  /** Find a matching plugin engine choice by providerId and optional execution deviceId. */
  findEngine: (providerId: string | null | undefined, deviceId?: string | null) => PluginEngineChoice | null;
}

export function usePickerPluginEngines(
  options: UsePickerPluginEnginesOptions = {},
): PickerPluginEnginesResult {
  const enabled = options.enabled !== false;
  const hostDeviceId = options.hostDeviceId?.trim() || undefined;
  const activeHostDeviceId = enabled ? hostDeviceId : undefined;
  const allDevices = useDeviceLinkDeviceList();
  const selfDeviceId = useMemo(
    () => allDevices?.find((device) => device.isSelf)?.deviceId ?? null,
    [allDevices],
  );
  const { devices: selectableDevices } = useSelectableDevices();

  const rememberedKey = JSON.stringify(
    Array.from(
      new Set(
        (options.rememberedDeviceIds ?? [])
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim()),
      ),
    ),
  );
  const rememberedIds = useMemo<readonly string[]>(
    () => JSON.parse(rememberedKey) as string[],
    [rememberedKey],
  );

  // Gate both share and controlled-location hooks on `enabled` so closed popovers issue zero
  // Device Link requests (provider-sharing.md §5.1).
  const {
    pluginEngineDevices: sharedPluginEngineDevices = [],
    nameFor: providerShareDeviceName,
    isReceived: isReceivedProviderShare,
  } = useProviderShareAgentDevices(enabled ? rememberedIds : [], activeHostDeviceId);
  const hostLocations = useControlledModelLocations(activeHostDeviceId, selfDeviceId);

  const localNeeded = enabled && !hostDeviceId;
  const localEngines = usePluginEngines(localNeeded);

  const {
    engines: remoteHostEngines,
    refresh: refreshRemoteHostEngines,
  } = useRemotePluginEngines(
    activeHostDeviceId,
    activeHostDeviceId ? 'once' : false,
  );

  const deviceEntriesKey = enabled
    ? JSON.stringify(
        !hostDeviceId
          ? [
              ...selectableDevices
                .filter(
                  (device) =>
                    !isProviderShareAgentDeviceId(device.deviceId) &&
                    !isSharedTaskPeer(device.deviceId) &&
                    (device.online || rememberedIds.includes(device.deviceId)),
                )
                .map(({ deviceId, name }): [string, string | null, string?] => [deviceId, name ?? null]),
              ...sharedPluginEngineDevices.map(
                ({ deviceId, name }): [string, string | null, string?] => [deviceId, name || null],
              ),
              ...rememberedIds
                .filter(
                  (id) =>
                    isProviderShareAgentDeviceId(id) &&
                    !sharedPluginEngineDevices.some((item) => item.deviceId === id),
                )
                .map((id): [string, string | null, string?] => [id, providerShareDeviceName?.(id) ?? null]),
            ]
          : (() => {
              const controlledSources = controlledPluginEngineSources(
                hostDeviceId,
                hostLocations?.map((location) => ({
                  deviceId: location.agentDeviceId,
                  name: location.name,
                  ...(location.favoriteSource ? { favoriteSource: location.favoriteSource } : {}),
                })),
                (id) => (isReceivedProviderShare?.(id) ? providerShareDeviceName?.(id) : null),
              );
              const existingIds = new Set(controlledSources.map((source) => source.deviceId));
              const rememberedSources: PluginEngineSource[] = [];
              for (const id of rememberedIds) {
                if (id === hostDeviceId || isSharedTaskPeer(id) || existingIds.has(id)) continue;
                const catalogueKey = modelCatalogKey(id, hostDeviceId);
                if (!catalogueKey) continue;
                const shareName = isProviderShareAgentDeviceId(id) && isReceivedProviderShare?.(id)
                  ? providerShareDeviceName?.(id)
                  : null;
                const fallbackName =
                  shareName ??
                  selectableDevices.find((item) => item.deviceId === id)?.name ??
                  allDevices?.find((item) => item.deviceId === id)?.name ??
                  null;
                rememberedSources.push({ deviceId: id, name: fallbackName, catalogueKey });
              }
              return [...controlledSources, ...rememberedSources].map(
                ({ deviceId, name, catalogueKey }): [string, string | null, string?] => [
                  deviceId,
                  name ?? null,
                  catalogueKey,
                ],
              );
            })(),
      )
    : '[]';

  const remoteSources = useMemo<readonly PluginEngineSource[]>(
    () =>
      (JSON.parse(deviceEntriesKey) as Array<[string, string | null, string?]>).map(
        ([deviceId, name, catalogueKey]) => ({
          deviceId,
          name,
          ...(catalogueKey ? { catalogueKey } : {}),
        }),
      ),
    [deviceEntriesKey],
  );
  const remoteSourceCatalogueKeys = useMemo(
    () => remoteSources.map((source) => source.catalogueKey ?? source.deviceId),
    [remoteSources],
  );
  const { catalogues: remoteCatalogues, read: readRemoteCatalogues } =
    useDevicesPluginEngines(remoteSourceCatalogueKeys);

  const rememberedRemoteCatalogueKey = useMemo(
    () =>
      remoteSources
        .filter((source) => rememberedIds.includes(source.deviceId))
        .map((source) => source.catalogueKey ?? source.deviceId)
        .join('\n'),
    [rememberedIds, remoteSources],
  );
  useEffect(() => {
    if (!enabled || !rememberedRemoteCatalogueKey) return;
    for (const key of rememberedRemoteCatalogueKey.split('\n')) readRemoteCatalogues(key);
  }, [enabled, rememberedRemoteCatalogueKey, readRemoteCatalogues]);

  const engines = useMemo<readonly PluginEngineChoice[]>(() => {
    if (!enabled) return [];
    const remoteChoices = remotePluginEngineChoices(
      remoteSources,
      remoteCatalogues,
      deviceDisplayName,
      localEngines,
    );
    if (hostDeviceId) {
      const hostList = remoteHostEngines ?? [];
      return remoteChoices.length ? [...hostList, ...remoteChoices] : hostList;
    }
    return remoteChoices.length ? [...localEngines, ...remoteChoices] : localEngines;
  }, [
    enabled,
    hostDeviceId,
    remoteHostEngines,
    localEngines,
    remoteCatalogues,
    remoteSources,
  ]);

  const hasLocalEnginesRef = useRef(false);
  hasLocalEnginesRef.current = localEngines.length > 0;

  const readCatalogue = useCallback(() => {
    if (!enabled) return;
    if (hostDeviceId) {
      refreshRemoteHostEngines();
      readRemoteCatalogues();
      return;
    }
    if (hasLocalEnginesRef.current) requestPluginEnginesRefresh();
    readRemoteCatalogues();
  }, [enabled, hostDeviceId, refreshRemoteHostEngines, readRemoteCatalogues]);

  const findEngine = useCallback(
    (providerId: string | null | undefined, deviceId?: string | null): PluginEngineChoice | null => {
      if (!providerId) return null;
      const normalizedDeviceId = deviceId?.trim() || null;
      const exact = engines.find((engine) =>
        isSamePluginEngineChoice(engine, { providerId, deviceId: normalizedDeviceId }),
      );
      if (exact) return exact;
      if (!normalizedDeviceId) return findPluginEngine(engines.filter((e) => !e.deviceId), providerId);
      return null;
    },
    [engines],
  );

  return {
    engines,
    hasSources: enabled && (engines.length > 0 || remoteSources.length > 0),
    readCatalogue,
    findEngine,
  };
}
