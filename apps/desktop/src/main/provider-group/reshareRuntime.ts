/**
 * 供应商组与供应商分享之间的接线(组所在电脑这一边)：
 *  - 转分享(provider-sharing.md §4.3)：组里分享来的电脑的主人逐人同意本机分享出去的人，结果按账号放在内存里
 *    (reshare.ts)；组或分享的人变化时重新报给那台；
 *  - 原分享被删除或已退出(provider-groups.md §3)：已收到的分享名单完整可信时，把组里指向它的电脑移出组。
 * 两者都只看本机自己的组；按调用时的账号转发，换账号后另起一份。
 */
import { REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps } from '@cindy/device-link';

import { activeOwnerScopeKey } from '../appSessionState.js';
import { PROVIDER_GROUP_IPC } from '../../shared/providerGroup.js';
import { PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../shared/providerShare.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { broadcast, remoteBackgroundInvoke } from '../device-link/index.js';
import {
  getConfirmedReceivedShareIds,
  getReceivedShares,
  onProviderShareReceivedChanged,
} from '../device-link/providerShareGuest.js';
import { getProviderShareHostLoadedSnapshot, onProviderShareHostChanged } from '../device-link/providerShareHost.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { pruneProviderGroupBindings } from './bindings.js';
import { pruneRemovedShareMembers, recordShareHosts } from './removedShares.js';
import { createProviderGroupReshare, type ProviderGroupReshare } from './reshare.js';
import { completeProviderGroupReshareCleanup, listProviderGroupReshareCleanups, listProviderGroups, updateProviderGroup, writeProviderGroup } from './store.js';

const log = createLogger('provider-group:reshare');

let current: { owner: string; reshare: ProviderGroupReshare } | null = null;

function broadcastChanged(providerId: string): void {
  try {
    broadcast(PROVIDER_GROUP_IPC.CHANGED, { providerId });
  } catch (error) {
    log.warn('provider group broadcast failed', { error: String(error) });
  }
}

function reshareForActiveOwner(): ProviderGroupReshare {
  const owner = activeOwnerScopeKey();
  if (current?.owner === owner) return current.reshare;
  current?.reshare.stop();
  const isCurrent = () => activeOwnerScopeKey() === owner;
  const invoke = async (agentDeviceId: string, request: unknown): Promise<unknown> => {
    if (!isCurrent()) throw new Error('The account changed');
    const reply = await remoteBackgroundInvoke(agentDeviceId, REMOTE_AGENT_CHANNEL, [request]);
    if (!isCurrent()) throw new Error('The account changed');
    if (!reply.ok) throw Object.assign(new Error(reply.error.message || reply.error.code), { code: reply.error.code });
    return reply.result;
  };
  const reshare = createProviderGroupReshare({
    listGroups: () => (isCurrent() ? listProviderGroups() : {}),
    ownedShares: () => (isCurrent() ? getProviderShareHostLoadedSnapshot() : null),
    pendingCleanups: () => (isCurrent() ? listProviderGroupReshareCleanups() : {}),
    shareAvailability: (agentDeviceId) => {
      if (!isCurrent() || !agentDeviceId.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX)) return 'unknown';
      const shareId = agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length);
      const share = getReceivedShares().find((item) => item.shareId === shareId);
      if (share) return share.status === 'paused' ? 'paused' : share.hostOnline ? 'online' : 'offline';
      const confirmed = getConfirmedReceivedShareIds();
      return confirmed && !confirmed.has(shareId) ? 'removed' : 'unknown';
    },
    completeCleanup: async (agentDeviceId, token) => {
      if (!isCurrent()) throw new Error('The account changed');
      await completeProviderGroupReshareCleanup(agentDeviceId, token);
      if (!isCurrent()) throw new Error('The account changed');
    },
    readCaps: async (agentDeviceId) => parseRemoteAgentCaps(await invoke(agentDeviceId, { op: 'caps' })),
    invoke,
    changed: () => {
      if (!isCurrent()) return;
      for (const [providerId, config] of Object.entries(listProviderGroups())) {
        if (config.members.some((member) => member.kind === 'share')) broadcastChanged(providerId);
      }
    },
    now: () => Date.now(),
    log,
  });
  current = { owner, reshare };
  return reshare;
}

/** 转分享：给 guestRelay、设置页与组的变化用的门面(每次按当前账号转发)。 */
export const providerGroupReshare = {
  allows: (agentDeviceId: string, reshareKey: string | undefined) => reshareForActiveOwner().allows(agentDeviceId, reshareKey),
  needsUpdate: (agentDeviceId: string) => reshareForActiveOwner().needsUpdate(agentDeviceId),
  summary: (providerId: string, agentDeviceId: string) => reshareForActiveOwner().summary(providerId, agentDeviceId),
  kick: (reason: string) => reshareForActiveOwner().kick(reason),
  refreshIfStale: () => reshareForActiveOwner().refreshIfStale(),
  noteDenied: (agentDeviceId: string, reshareKey: string) => reshareForActiveOwner().noteDenied(agentDeviceId, reshareKey),
};

let registered = false;
let pruning: Promise<void> | null = null;

function groupChanged(providerId: string): void {
  broadcastChanged(providerId);
  // 同账号其他电脑的模型列表按本机目录里的组摘要收起组内电脑：组变化后让它们重读目录。
  tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
}

function pruneSoon(): void {
  if (pruning) return;
  pruning = pruneRemovedShareMembers({
    confirmedShareIds: getConfirmedReceivedShareIds,
    listGroups: listProviderGroups,
    writeGroup: writeProviderGroup,
    pruneBindings: pruneProviderGroupBindings,
    ownerKey: activeOwnerScopeKey,
    changed: groupChanged,
  }).then((removed) => {
    if (removed.length > 0) {
      log.info('provider group: removed computers whose share is gone', { count: removed.length });
      providerGroupReshare.kick('share-removed');
    }
  }).catch((error: unknown) => {
    log.warn('provider group: removing gone shares failed', { error: error instanceof Error ? error.message : String(error) });
  }).then(() => recordShareHosts({
    shareHosts: () => new Map(getReceivedShares().map((share) => [share.shareId, share.hostDeviceId])),
    listGroups: listProviderGroups,
    updateGroup: updateProviderGroup,
    ownerKey: activeOwnerScopeKey,
    changed: groupChanged,
  })).then((updated) => {
    if (updated.length > 0) log.info('provider group: recorded the computers of shared-in members', { count: updated.length });
  }).catch((error: unknown) => {
    log.warn('provider group: recording shared-in computers failed', { error: error instanceof Error ? error.message : String(error) });
  }).finally(() => {
    pruning = null;
  });
}

/** 启动时接上：分享快照与已收到的分享变化时，重新报转分享、移出已不在的分享。 */
export function registerProviderGroupReshare(): void {
  if (registered) return;
  registered = true;
  onProviderShareHostChanged(() => providerGroupReshare.kick('owned'));
  onProviderShareReceivedChanged(() => {
    pruneSoon();
    providerGroupReshare.kick('received');
  });
  providerGroupReshare.kick('startup');
}
