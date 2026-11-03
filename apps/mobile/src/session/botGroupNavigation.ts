import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';

/** The group screen; server groups have no computer parameter; existing device routes remain compatible. */
export function botGroupRoute(host: RemoteResourceHostTarget, groupId: string) {
  return {
    pathname: '/companions/groups/[groupId]' as const,
    params: { groupId, ...(host.deviceId ? { deviceId: host.deviceId, deviceName: host.deviceName } : {}) },
  };
}
