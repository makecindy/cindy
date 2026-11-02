import type { ComponentProps } from 'react';
import { ModelSelector, ModelSelectorContent, type ModelMemoryAccessors } from './ModelSelector';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';
import { agentDeviceModelMemoryAccessors } from '@/state/agentDeviceModelMemory';
import { modelCatalogKey } from '../../../shared/controlledModelCatalog';

interface ModelRouteContext {
  /** The task host; omitted for this computer. */
  deviceId?: string;
  /** The selected Agent location; null/omitted means the task host. */
  agentDeviceId?: string | null;
  sshRemote?: boolean;
}

function useModelRouteOptions(
  { deviceId, agentDeviceId, sshRemote }: ModelRouteContext,
  modelMemory?: ModelMemoryAccessors,
) {
  const locations = useModelRouteDevices({
    controlledDeviceId: deviceId ?? null,
    leadAgentDeviceId: agentDeviceId,
    sshRemote,
  });
  const remoteAgent = locations.devices ? {
    devices: locations.devices,
    selectedDeviceId: locations.leadAgentDeviceId,
    homeDeviceId: deviceId,
    catalogHostDeviceId: locations.catalogHostDeviceId,
    deviceModelMemory: agentDeviceModelMemoryAccessors,
  } : undefined;
  return {
    // Read the selected, readable execution location while retaining the home catalog.
    deviceId: modelCatalogKey(locations.devices ? locations.leadAgentDeviceId ?? deviceId : deviceId, locations.catalogHostDeviceId),
    remoteAgent,
    // Keep remote preferences separate from the task host's model memory.
    modelMemory: modelMemory ?? (remoteAgent?.selectedDeviceId
      ? agentDeviceModelMemoryAccessors(remoteAgent.selectedDeviceId)
      : undefined),
  };
}

/** Full control using the common task/worker location catalog. */
export function ModelRouteSelector({ agentDeviceId, sshRemote, deviceId, ...props }:
  Omit<ComponentProps<typeof ModelSelector>, 'remoteAgent'> & ModelRouteContext) {
  const options = useModelRouteOptions({ deviceId, agentDeviceId, sshRemote }, props.modelMemory);
  return <ModelSelector {...props} {...options} />;
}

/** The same selector inside an existing popover; callbacks retain the full selection. */
export function ModelRouteSelectorContent({ agentDeviceId, sshRemote, deviceId, ...props }:
  Omit<ComponentProps<typeof ModelSelectorContent>, 'remoteAgent'> & ModelRouteContext) {
  const options = useModelRouteOptions({ deviceId, agentDeviceId, sshRemote }, props.modelMemory);
  return <ModelSelectorContent {...props} {...options} />;
}
