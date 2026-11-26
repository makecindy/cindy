import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';

import type { PluginEnginesPickerProps } from '@/components/new-chat/PluginEnginesSection';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
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
  PLUGIN_ENGINE_DEFAULT_MODEL,
  remotePluginEngineChoices,
  type PluginEngineChoice,
  type PluginEngineSelection,
} from '@/lib/pluginEngineSelection';
import { isPluginEngineEffort } from '../../shared/pluginEngines';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

export interface PluginModelPickerActiveRoute {
  agentKind?: string;
  providerId?: string | null;
  model?: string;
  effort?: string;
  agentDeviceId?: string | null;
}

/**
 * Builds `PluginEnginesPickerProps` for plugin-surface model pickers (in-card dropdown,
 * Host model picker popover/dialog, plugin "Model & tasks" preferences) with the exact
 * same local / remote / shared plugin engine discovery used by ordinary tasks.
 */
export function usePluginModelPickerEngines({
  enabled,
  allowRemote,
  hostDeviceId,
  active,
  onSelect,
}: {
  enabled: boolean;
  allowRemote: boolean;
  /** Plugin execution computer when editing remotely; omitted for this computer. */
  hostDeviceId?: string;
  active: PluginModelPickerActiveRoute | null | undefined;
  onSelect(selection: PluginEngineSelection): void | boolean | Promise<boolean>;
}): PluginEnginesPickerProps | undefined {
  const selfDeviceId = useOptionalAuthDeviceId();
  const { devices: selectableDevices } = useSelectableDevices();
  const activeAgentDeviceId = active?.agentKind === 'acp' && active.agentDeviceId ? active.agentDeviceId : null;
  const rememberedDeviceIds = useMemo(
    () => (activeAgentDeviceId ? [activeAgentDeviceId] : []),
    [activeAgentDeviceId],
  );
  const {
    pluginEngineDevices: sharedPluginEngineDevices = [],
    nameFor: providerShareDeviceName,
  } = useProviderShareAgentDevices(rememberedDeviceIds, hostDeviceId);

  const localNeeded = enabled
    && (!hostDeviceId || (!!selfDeviceId && activeAgentDeviceId === selfDeviceId));
  const localEngines = usePluginEngines(localNeeded);
  const {
    engines: remoteHostEngines,
    refresh: refreshRemoteHostEngines,
  } = useRemotePluginEngines(
    enabled && hostDeviceId ? hostDeviceId : undefined,
    enabled && hostDeviceId ? 'once' : false,
  );

  const deviceEntriesKey = enabled && allowRemote
    ? JSON.stringify(
        !hostDeviceId
          ? [
              ...selectableDevices
                .filter((device) =>
                  !isProviderShareAgentDeviceId(device.deviceId)
                  && !isSharedTaskPeer(device.deviceId)
                  && (device.online || device.deviceId === activeAgentDeviceId))
                .map(({ deviceId: id, name }): [string, string | null] => [id, name ?? null]),
              ...sharedPluginEngineDevices
                .map(({ deviceId: id, name }): [string, string | null] => [id, name || null]),
              ...(activeAgentDeviceId
                && isProviderShareAgentDeviceId(activeAgentDeviceId)
                && !sharedPluginEngineDevices.some((item) => item.deviceId === activeAgentDeviceId)
                ? [[activeAgentDeviceId, providerShareDeviceName?.(activeAgentDeviceId) ?? null] as [string, string | null]]
                : []),
            ]
          : (activeAgentDeviceId && activeAgentDeviceId !== hostDeviceId && activeAgentDeviceId !== selfDeviceId && !isSharedTaskPeer(activeAgentDeviceId)
              ? [[
                  activeAgentDeviceId,
                  selectableDevices.find((item) => item.deviceId === activeAgentDeviceId)?.name
                    ?? providerShareDeviceName?.(activeAgentDeviceId)
                    ?? null,
                ] as [string, string | null]]
              : []),
      )
    : '[]';

  const remoteDevices = useMemo(
    () => (JSON.parse(deviceEntriesKey) as Array<[string, string | null]>).map(([deviceId, name]) => ({ deviceId, name })),
    [deviceEntriesKey],
  );
  const remoteDeviceIds = useMemo(() => remoteDevices.map((device) => device.deviceId), [remoteDevices]);
  const { catalogues: devicePluginEngines, read: readDevicePluginEngines } = useDevicesPluginEngines(remoteDeviceIds);

  useEffect(() => {
    if (!enabled || !activeAgentDeviceId || !remoteDeviceIds.includes(activeAgentDeviceId)) return;
    readDevicePluginEngines(activeAgentDeviceId);
  }, [enabled, activeAgentDeviceId, remoteDeviceIds, readDevicePluginEngines]);

  const engines = useMemo<readonly PluginEngineChoice[]>(() => {
    if (!enabled) return [];
    if (hostDeviceId) {
      const base: PluginEngineChoice[] = [...(remoteHostEngines ?? [])];
      if (active?.agentKind === 'acp' && active.providerId && activeAgentDeviceId) {
        if (!base.some((item) => item.providerId === active.providerId && item.deviceId === activeAgentDeviceId)) {
          const source = activeAgentDeviceId === selfDeviceId
            ? localEngines
            : (devicePluginEngines.get(activeAgentDeviceId) ?? []);
          const engine = findPluginEngine(source, active.providerId);
          if (engine) {
            const name = selectableDevices.find((item) => item.deviceId === activeAgentDeviceId)?.name
              ?? providerShareDeviceName?.(activeAgentDeviceId)
              ?? undefined;
            base.push({ ...engine, deviceId: activeAgentDeviceId, deviceName: deviceDisplayName(activeAgentDeviceId, name) });
          }
        }
      }
      return base;
    }
    const remoteChoices = allowRemote
      ? remotePluginEngineChoices(remoteDevices, devicePluginEngines, deviceDisplayName, localEngines)
      : [];
    return remoteChoices.length ? [...localEngines, ...remoteChoices] : localEngines;
  }, [
    enabled,
    hostDeviceId,
    remoteHostEngines,
    active?.agentKind,
    active?.providerId,
    activeAgentDeviceId,
    selfDeviceId,
    localEngines,
    devicePluginEngines,
    selectableDevices,
    providerShareDeviceName,
    allowRemote,
    remoteDevices,
  ]);

  const activeSelection = useMemo<PluginEngineSelection | null>(() => {
    if (!enabled || active?.agentKind !== 'acp' || !active.providerId) return null;
    return {
      providerId: active.providerId,
      modelId: active.model?.trim() || PLUGIN_ENGINE_DEFAULT_MODEL,
      ...(activeAgentDeviceId ? { deviceId: activeAgentDeviceId } : {}),
      ...(isPluginEngineEffort(active.effort) ? { effort: active.effort } : {}),
    };
  }, [enabled, active?.agentKind, active?.providerId, active?.model, active?.effort, activeAgentDeviceId]);

  const hasLocalEnginesRef = useRef(false);
  hasLocalEnginesRef.current = localEngines.length > 0;
  const readCatalogue = useCallback(() => {
    if (hostDeviceId) {
      refreshRemoteHostEngines();
      readDevicePluginEngines();
      return;
    }
    if (hasLocalEnginesRef.current) requestPluginEnginesRefresh();
    readDevicePluginEngines();
  }, [hostDeviceId, refreshRemoteHostEngines, readDevicePluginEngines]);

  return useMemo<PluginEnginesPickerProps | undefined>(() => {
    if (!enabled) return undefined;
    if (!activeSelection && engines.length === 0 && remoteDeviceIds.length === 0 && !hostDeviceId) {
      return undefined;
    }
    return {
      engines,
      active: activeSelection,
      onSelect,
      readCatalogue,
    };
  }, [enabled, activeSelection, engines, remoteDeviceIds.length, hostDeviceId, onSelect, readCatalogue]);
}
