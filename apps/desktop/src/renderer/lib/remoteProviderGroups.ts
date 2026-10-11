/**
 * 远程供应商列表里的供应商组(docs/product-rules/provider-groups.md §10)：同账号另一台电脑把某个供应商
 * 建成了组，组里的其他电脑与分享就不再单独列出，只列组所在电脑那一项，并标成供应商组。
 *
 * 只看列表里此刻在线(调用方传进来)的电脑的目录：组所在电脑离线时它的那一项不在，组员自然重新单独出现。
 * 规则：
 *  - 本身带组的项不收起(两个组互相包含时两个组都还在)；
 *  - 当前任务正在用的组员也收起(2026-10-11 用户要求：组里的都聚合成一项，不要好几个分不清)，
 *    模型列表把它显示在组那一项下(见 memberOf)；
 *  - 本机自己的供应商不在远程列表里，组里的「本机这台」不影响本机那一栏。
 */
import type { ProviderView } from '@cindy/model-providers';

import { readProviderGroupSummary, type ProviderGroupConfig } from '../../shared/providerGroup';

/** 远程列表里一项的键：Agent 所在电脑(含 `share:<id>`) + 那台上的供应商 id。 */
export function remoteProviderEntryKey(agentDeviceId: string, providerId: string): string {
  return `${agentDeviceId}\n${providerId}`;
}

/** 组所在电脑目录里某个供应商带的组摘要；没有组或格式不对返回 null。 */
export function remoteProviderGroupOf(provider: ProviderView): ProviderGroupConfig | null {
  return readProviderGroupSummary((provider as { group?: unknown }).group, provider.id);
}

/** 组那一项在列表里的位置：`deviceId` 为组所在电脑；null = 任务所在电脑自己建的组(组那一项是那台自己的供应商)。 */
export interface RemoteProviderGroupEntry {
  deviceId: string | null;
  providerId: string;
}

export interface RemoteProviderGroups {
  /** 被收起的组员(按 remoteProviderEntryKey)。 */
  hidden: ReadonlySet<string>;
  /** 带组的项(按 remoteProviderEntryKey) → 组设置。 */
  groups: ReadonlyMap<string, ProviderGroupConfig>;
  /** 被收起的组员(按 remoteProviderEntryKey) → 收着它的组那一项(同时在几个组里时取先列出的那个)。 */
  memberOf: ReadonlyMap<string, RemoteProviderGroupEntry>;
}

/**
 * @param catalogs 列表里此刻在线的其他电脑的目录(带组摘要)。
 * @param localGroups 任务所在电脑自己建的组(按供应商 id；本机任务时是本机的组)：它们的组员同样收起，组那一项
 *   是本机自己的供应商，在本机那一栏，不在远程列表里。
 */
export function collectRemoteProviderGroups(
  catalogs: Iterable<{ deviceId: string; providers: readonly ProviderView[] }>,
  localGroups: Readonly<Record<string, ProviderGroupConfig>> = {},
): RemoteProviderGroups {
  const groups = new Map<string, ProviderGroupConfig>();
  const memberOf = new Map<string, RemoteProviderGroupEntry>();
  const addMembers = (entry: RemoteProviderGroupEntry, config: ProviderGroupConfig) => {
    for (const member of config.members) {
      // 组里的「组所在电脑自己」就是组那一项本身。
      if (member.kind === 'local' || !member.agentDeviceId) continue;
      const key = remoteProviderEntryKey(member.agentDeviceId, member.providerId);
      if (!memberOf.has(key)) memberOf.set(key, entry);
    }
  };
  for (const { deviceId, providers } of catalogs) {
    for (const provider of providers) {
      if (provider.remoteInvocationEnabled !== true) continue;
      const config = remoteProviderGroupOf(provider);
      if (!config) continue;
      groups.set(remoteProviderEntryKey(deviceId, provider.id), config);
      addMembers({ deviceId, providerId: provider.id }, config);
    }
  }
  for (const [providerId, config] of Object.entries(localGroups)) addMembers({ deviceId: null, providerId }, config);
  for (const key of groups.keys()) memberOf.delete(key);
  return { hidden: new Set(memberOf.keys()), groups, memberOf };
}
