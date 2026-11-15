import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';

/** The group screen; server groups have no computer parameter; existing device routes remain compatible. */
export function botGroupRoute(host: RemoteResourceHostTarget, groupId: string) {
  return {
    pathname: '/companions/groups/[groupId]' as const,
    params: { groupId, ...(host.deviceId ? { deviceId: host.deviceId, deviceName: host.deviceName } : {}) },
  };
}

/** The native route, including the data authority and topic. Reopening a group
 * should reuse its screen/scroll/composer, never create another full timeline. */
export function botGroupRouteKey(params: { deviceId?: unknown; groupId?: unknown; threadRootId?: unknown }) {
  const first = (value: unknown) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
  return JSON.stringify([first(params.deviceId), first(params.groupId), first(params.threadRootId)]);
}
