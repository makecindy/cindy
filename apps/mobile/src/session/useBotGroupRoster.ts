import { useChatServerRoster } from '@/chat/useChatServer';
import { BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useRemoteResourceList } from './useRemoteResourceList';

const NO_TARGETS: RemoteResourceHostTarget[] = [];

/**
 * Server memberships are primary; advertised computer collections preserve legacy access.
 */
export function useBotGroupRoster(targets: readonly RemoteResourceHostTarget[], enabled: boolean) {
  const server = useChatServerRoster(enabled);
  const revoked = useRevokedDevices();
  const hosts = targets.length ? targets : NO_TARGETS;
  const list = useRemoteResourceList(BOT_GROUP_REMOTE_COLLECTION_ID, hosts, enabled && hosts.length > 0);
  // A removed server membership must not reappear through a stale computer cache.
  const serverIds = server.serverIds;
  // Old cached rows carry no server/local discriminator. Only a current-epoch
  // authenticated collection reply can authorize the compatibility projection.
  const legacy = list.items.filter((row) => row.item.ref.kind === BOT_GROUP_REMOTE_RESOURCE_KIND
    && list.isOnline(row.host) && !serverIds.has(row.item.ref.id) && !revoked.has(row.host.deviceId) && hosts.some((host) => host.deviceId === row.host.deviceId));
  return {
    items: [...server.items, ...legacy],
    loading: server.loading || (hosts.length > 0 && list.loading),
    refreshing: server.refreshing || list.refreshing,
    error: server.error ?? (hosts.length ? list.error : null),
    /** Server membership discovery needs no supporting computer. */
    supported: true,
    isOnline: (host: RemoteResourceHostTarget) => !host.deviceId || (!revoked.has(host.deviceId) && list.isOnline(host)),
    refresh: async () => { await Promise.all([server.refresh(), ...(hosts.length ? [list.refresh()] : [])]); },
  };
}
