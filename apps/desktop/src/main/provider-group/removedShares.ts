/**
 * 原分享被删除或已退出(docs/product-rules/provider-groups.md §3、provider-sharing.md §4.3)：这个账号收到的分享里
 * 已经没有它了，组里指向它的电脑移出组，本机自己与本机分享的人都不再用到它。
 * 只在已收到的分享名单完整可信时判断(说不准时什么都不做)；分享只是暂停时仍在名单里，不动。
 *
 * 同一轮对账也给旧组里分享来的电脑补上分享者那台电脑({@link recordShareHosts})：只用于把同一台电脑上的几个分享
 * 按一台电脑展示与计数(provider-groups.md §10)，不影响分配与连接。
 */
import type { ProviderGroupConfig } from '../../shared/providerGroup.js';
import { isProviderShareAgentDeviceId, PROVIDER_SHARE_AGENT_DEVICE_PREFIX } from '../../shared/providerShare.js';

export interface PruneRemovedShareMembersDeps {
  /** 完整可信的已收到分享名单(分享 id)；说不准时为 null。 */
  confirmedShareIds(): ReadonlySet<string> | null;
  listGroups(): Record<string, ProviderGroupConfig>;
  writeGroup(providerId: string, config: unknown): Promise<unknown>;
  /** 解除指向已不在组里的电脑的任务绑定；keep 为 null = 整个组已删除。 */
  pruneBindings(providerId: string, keep: ReadonlySet<string> | null): Promise<void>;
  /** 当前账号：读名单与写入之间换了账号时停下。 */
  ownerKey(): string;
  changed(providerId: string): void;
}

function goneMembers(config: ProviderGroupConfig, received: ReadonlySet<string>) {
  return config.members.filter((member) =>
    member.kind === 'share'
    && member.agentDeviceId !== null
    && isProviderShareAgentDeviceId(member.agentDeviceId)
    && !received.has(member.agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length)));
}

/** 移出指向已不在的分享的组内电脑并解除对应的任务绑定，返回移出的组内电脑的键。 */
export async function pruneRemovedShareMembers(deps: PruneRemovedShareMembersDeps): Promise<string[]> {
  const owner = deps.ownerKey();
  const received = deps.confirmedShareIds();
  if (!received) return [];
  const removed: string[] = [];
  for (const providerId of Object.keys(deps.listGroups())) {
    if (deps.ownerKey() !== owner) break;
    // 每个组写之前现读一次：前一个组的写入期间设置页可能改过这个组。
    const config = deps.listGroups()[providerId];
    if (!config) continue;
    const gone = goneMembers(config, received);
    if (gone.length === 0) continue;
    const keep = config.members.filter((member) => !gone.includes(member));
    await deps.writeGroup(providerId, keep.length > 0 ? { ...config, members: keep } : null);
    if (deps.ownerKey() !== owner) break;
    await deps.pruneBindings(providerId, keep.length > 0 ? new Set(keep.map((member) => member.key)) : null);
    if (deps.ownerKey() !== owner) break;
    removed.push(...gone.map((member) => member.key));
    deps.changed(providerId);
  }
  return removed;
}

export interface RecordShareHostsDeps {
  /** 本账号收到的分享：分享 id → 分享者那台电脑的设备 id。还没读到的分享不在里面(不要求名单完整)。 */
  shareHosts(): ReadonlyMap<string, string>;
  listGroups(): Record<string, ProviderGroupConfig>;
  /** 在写锁内基于最新组配置更新，组已被删除时 updater 收到 null。 */
  updateGroup(
    providerId: string,
    updater: (current: ProviderGroupConfig | null) => ProviderGroupConfig | null | undefined,
  ): Promise<ProviderGroupConfig | null>;
  ownerKey(): string;
  changed(providerId: string): void;
}

/**
 * 给组里分享来的电脑记上分享者那台电脑(旧组加入时还没记，或记的与分享不一致)，返回改过的组。
 * 只补名单里有的分享，没读到的保持原样(按分享各算一台)；没有变化的组不写。
 */
export async function recordShareHosts(deps: RecordShareHostsDeps): Promise<string[]> {
  const owner = deps.ownerKey();
  const hosts = deps.shareHosts();
  if (hosts.size === 0) return [];
  const updated: string[] = [];
  for (const providerId of Object.keys(deps.listGroups())) {
    if (deps.ownerKey() !== owner) break;
    const listed = deps.listGroups()[providerId];
    if (!listed || !listed.members.some((member) => {
      if (member.kind !== 'share' || member.agentDeviceId === null || !isProviderShareAgentDeviceId(member.agentDeviceId)) {
        return false;
      }
      const host = hosts.get(member.agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length));
      return host !== undefined && host !== member.hostDeviceId;
    })) continue;
    let changed = false;
    const written = await deps.updateGroup(providerId, (config) => {
      // 组可能在等待写锁时被用户删除；不要用旧快照把它重新创建。
      if (!config) return undefined;
      let dirty = false;
      const members = config.members.map((member) => {
        if (member.kind !== 'share' || member.agentDeviceId === null || !isProviderShareAgentDeviceId(member.agentDeviceId)) {
          return member;
        }
        const host = hosts.get(member.agentDeviceId.slice(PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length));
        if (!host || host === member.hostDeviceId) return member;
        dirty = true;
        return { ...member, hostDeviceId: host };
      });
      if (!dirty) return undefined;
      changed = true;
      return { ...config, members };
    });
    if (deps.ownerKey() !== owner) break;
    if (!changed || !written) continue;
    updated.push(providerId);
    deps.changed(providerId);
  }
  return updated;
}
