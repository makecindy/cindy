import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';

/** The group screen; a group lives on one computer, so the route always names it. */
export function botGroupRoute(host: RemoteResourceHostTarget, groupId: string) {
  return {
    pathname: '/companions/groups/[groupId]' as const,
    params: { groupId, deviceId: host.deviceId, deviceName: host.deviceName },
  };
}
