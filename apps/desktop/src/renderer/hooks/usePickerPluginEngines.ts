/**
 * usePickerPluginEngines — shared plugin engine source collector for model pickers outside the
 * composer (IM defaults, Feishu groups, Hook workspace prefs, Model Groups, Orca worker creation).
 *
 * Mirrors BotModelChainEditor / NewMakerDraftRoute:
 *  - On this computer (`hostDeviceId` omitted): combines local plugin engines, online same-account
 *    peer computers, received plugin-engine provider shares, and any remembered offline/selected
 *    device IDs so saved plugin engine routes always resolve their name/icon/modes.
 *  - On a remote host (`hostDeviceId` set): reads that host's own plugin engines (via Device Link)
 *    plus any remembered device catalogues for display.
 *
 * Remote catalogues are loaded lazily when the picker opens (`readCatalogue`), except remembered
 * device IDs which load once on mount so trigger buttons display the real engine name immediately.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
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
  isSamePluginEngineChoice,
  remotePluginEngineChoices,
  type PluginEngineChoice,
} from '@/lib/pluginEngineSelection';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

export interface UsePickerPluginEnginesOptions {
  /** Whether plugin engines can be selected in this picker (e.g. false for SSH). */
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

  const {
    pluginEngineDevices: sharedPluginEngineDevices = [],
    nameFor: providerShareDeviceName,
  } = useProviderShareAgentDevices(rememberedIds, hostDeviceId);

  const localNeeded =
    enabled &&
    (!hostDeviceId || (!!selfDeviceId && rememberedIds.includes(selfDeviceId)));
  const localEngines = usePluginEngines(localNeeded);

  const {
    engines: remoteHostEngines,
    refresh: refreshRemoteHostEngines,
  } = useRemotePluginEngines(
    enabled && hostDeviceId ? hostDeviceId : undefined,
    enabled && hostDeviceId ? 'once' : false,
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
                .map(({ deviceId, name }): [string, string | null] => [deviceId, name ?? null]),
              ...sharedPluginEngineDevices.map(
                ({ deviceId, name }): [string, string | null] => [deviceId, name || null],
              ),
              ...rememberedIds
                .filter(
                  (id) =>
                    isProviderShareAgentDeviceId(id) &&
                    !sharedPluginEngineDevices.some((item) => item.deviceId === id),
                )
                .map((id): [string, string | null] => [id, providerShareDeviceName?.(id) ?? null]),
            ]
          : rememberedIds
              .filter((id) => id !== hostDeviceId && id !== selfDeviceId && !isSharedTaskPeer(id))
              .map((id): [string, string | null] => [
                id,
                selectableDevices.find((item) => item.deviceId === id)?.name ??
                  providerShareDeviceName?.(id) ??
                  null,
              ]),
      )
    : '[]';

  const remoteSources = useMemo(
    () =>
      (JSON.parse(deviceEntriesKey) as Array<[string, string | null]>).map(([deviceId, name]) => ({
        deviceId,
        name,
      })),
    [deviceEntriesKey],
  );
  const remoteSourceIds = useMemo(
    () => remoteSources.map((source) => source.deviceId),
    [remoteSources],
  );
  const { catalogues: remoteCatalogues, read: readRemoteCatalogues } =
    useDevicesPluginEngines(remoteSourceIds);

  const rememberedRemoteKey = useMemo(
    () => rememberedIds.filter((id) => remoteSourceIds.includes(id)).join('\n'),
    [rememberedIds, remoteSourceIds],
  );
  useEffect(() => {
    if (!rememberedRemoteKey) return;
    for (const id of rememberedRemoteKey.split('\n')) readRemoteCatalogues(id);
  }, [rememberedRemoteKey, readRemoteCatalogues]);

  const engines = useMemo<readonly PluginEngineChoice[]>(() => {
    if (!enabled) return [];
    if (hostDeviceId) {
      const base: PluginEngineChoice[] = [...(remoteHostEngines ?? [])];
      for (const id of rememberedIds) {
        if (id === hostDeviceId) continue;
        const source =
          id === selfDeviceId ? localEngines : (remoteCatalogues.get(id) ?? []);
        const displayName = deviceDisplayName(
          id,
          selectableDevices.find((item) => item.deviceId === id)?.name ??
            providerShareDeviceName?.(id) ??
            undefined,
        );
        for (const engine of source) {
          if (base.some((item) => item.providerId === engine.providerId && item.deviceId === id)) {
            continue;
          }
          base.push({ ...engine, deviceId: id, deviceName: displayName });
        }
      }
      return base;
    }
    const remoteChoices = remotePluginEngineChoices(
      remoteSources,
      remoteCatalogues,
      deviceDisplayName,
      localEngines,
    );
    return remoteChoices.length ? [...localEngines, ...remoteChoices] : localEngines;
  }, [
    enabled,
    hostDeviceId,
    remoteHostEngines,
    rememberedIds,
    selfDeviceId,
    localEngines,
    remoteCatalogues,
    selectableDevices,
    providerShareDeviceName,
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
