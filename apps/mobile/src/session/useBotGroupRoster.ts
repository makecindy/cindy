import { BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useRemoteResourceList } from './useRemoteResourceList';

const NO_TARGETS: RemoteResourceHostTarget[] = [];

/**
 * Group chats of the computers whose manifest advertises them (`useTeammateRoster().groupTargets`).
 * The list re-reads on the host's `maker:remote-resources:changed` push like every resource list.
 */
export function useBotGroupRoster(targets: readonly RemoteResourceHostTarget[], enabled: boolean) {
  const revoked = useRevokedDevices();
  const hosts = targets.length ? targets : NO_TARGETS;
  const list = useRemoteResourceList(BOT_GROUP_REMOTE_COLLECTION_ID, hosts, enabled && hosts.length > 0);
  const items = list.items.filter((row) => row.item.ref.kind === BOT_GROUP_REMOTE_RESOURCE_KIND
    && !revoked.has(row.host.deviceId) && hosts.some((host) => host.deviceId === row.host.deviceId));
  return {
    items,
    /** The section shows only when some computer supports group chats. */
    supported: hosts.length > 0,
    isOnline: (host: RemoteResourceHostTarget) => !revoked.has(host.deviceId) && list.isOnline(host),
    refresh: list.refresh,
  };
}
