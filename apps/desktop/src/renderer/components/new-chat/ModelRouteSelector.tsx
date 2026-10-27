import type { ComponentProps } from 'react';
import { ModelSelector } from './ModelSelector';
import { useModelRouteDevices } from '@/hooks/useModelRouteDevices';

/** Settings consume the same location catalog as ordinary tasks and workers. */
export function ModelRouteSelector({ agentDeviceId, sshRemote, deviceId, ...props }:
  ComponentProps<typeof ModelSelector> & { agentDeviceId?: string | null; sshRemote?: boolean }) {
  const locations = useModelRouteDevices({ controlledDeviceId: deviceId ?? null,
    leadAgentDeviceId: agentDeviceId, sshRemote });
  return <ModelSelector {...props} deviceId={deviceId}
    remoteAgent={locations.devices ? { devices: locations.devices,
      selectedDeviceId: agentDeviceId ?? null, homeDeviceId: deviceId } : undefined} />;
}
