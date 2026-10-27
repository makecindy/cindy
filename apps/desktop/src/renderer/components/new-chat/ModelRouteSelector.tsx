import type { ComponentProps } from 'react';
import { ModelSelector } from './ModelSelector';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';

/** Settings consume the same location catalog as ordinary tasks and workers. */
export function ModelRouteSelector({ agentDeviceId, sshRemote, deviceId, ...props }:
  ComponentProps<typeof ModelSelector> & { agentDeviceId?: string | null; sshRemote?: boolean }) {
  const locations = useModelRouteDevices({ controlledDeviceId: deviceId ?? null,
    leadAgentDeviceId: agentDeviceId, sshRemote });
  // The trigger and the menu must read the selected, readable execution location.
  // Keep the home location separate for browsing local/controlled-host models.
  const catalogDeviceId = locations.devices ? locations.leadAgentDeviceId ?? deviceId : deviceId;
  return <ModelSelector {...props} deviceId={catalogDeviceId}
    remoteAgent={locations.devices ? { devices: locations.devices,
      selectedDeviceId: locations.leadAgentDeviceId, homeDeviceId: deviceId } : undefined} />;
}
