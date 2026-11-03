/**
 * 模型列表里的供应商组(docs/product-rules/provider-groups.md §10，与桌面 remoteProviderGroups 同口径)：
 * 某台电脑把一个供应商建成了组，组里其他电脑上的这个供应商不再单独列出，只列组那一项，标题带「供应商组 · N 台电脑」。
 *
 * - 组摘要只在组所在电脑的目录里(`maker:provider:list` 的 `group` 字段，只给同账号)，所以只看此刻列表里有的电脑：
 *   组所在电脑离线时组那一项不在，组员自然重新单独出现；
 * - 被控电脑自己的供应商照常显示，不被收起；本身带组的项也不收起(两个组互相包含时两个组都还在)；
 * - 任务此刻正跑在组员上也收起，模型列表停在组那一项(见 memberOf)。
 *
 * 位置坐标与选择器一致：deviceId 为 null = 被控电脑自己的目录，其余是其他电脑或分享(`share:<id>`)。
 */
import { readProviderShareGroupSize } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import { isProviderShareAgentDeviceId } from './providerShareAgentDevice';
import type { RemoteAgentCatalog } from './remoteAgentCatalogs';

/** 组那一项在列表里的位置。 */
export interface MobileProviderGroupEntry {
  deviceId: string | null;
  providerId: string;
}

export interface MobileProviderGroups {
  /** 被收起的其他电脑上的供应商(按 providerGroupEntryKey)。 */
  hidden: ReadonlySet<string>;
  /** 标成供应商组的项(按 providerGroupEntryKey) → 组里几台电脑；分享来的只有台数。 */
  sizes: ReadonlyMap<string, number>;
  /** 被收起的项 → 收着它的组那一项(同时在几个组里时取先列出的那个)。 */
  memberOf: ReadonlyMap<string, MobileProviderGroupEntry>;
}

/** 远高于实际组员数，只用来挡异常大的摘要。 */
const MAX_SUMMARY_MEMBERS = 512;

export function providerGroupEntryKey(deviceId: string | null, providerId: string): string {
  return JSON.stringify([deviceId, providerId]);
}

interface SummaryMember {
  /** 组员所在电脑(组所在电脑视角)；null = 组所在电脑自己，就是组那一项本身。 */
  agentDeviceId: string | null;
  providerId: string;
  /** 台数按哪台电脑算：分享来的按分享者那台电脑(组摘要带了时)，其余就是 agentDeviceId(与桌面端一致)。 */
  computer: string;
}

function isHostDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** 目录里某个供应商带的组摘要里的组员；没有组或格式不对返回 null(当作没有组)。 */
function readSummaryMembers(provider: ProviderView): SummaryMember[] | null {
  const group = (provider as { group?: unknown }).group;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
  const raw = (group as { members?: unknown }).members;
  if (!Array.isArray(raw)) return null;
  const members: SummaryMember[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_SUMMARY_MEMBERS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { kind, agentDeviceId, providerId, hostDeviceId } = entry as Record<string, unknown>;
    let member: SummaryMember | null = null;
    if (kind === 'local') member = { agentDeviceId: null, providerId: provider.id, computer: 'local' };
    else if (
      (kind === 'device' || kind === 'share')
      && typeof agentDeviceId === 'string' && agentDeviceId.length > 0 && agentDeviceId.length <= 160
      && (kind === 'share') === isProviderShareAgentDeviceId(agentDeviceId)
      && typeof providerId === 'string' && providerId.length > 0 && providerId.length <= 128
    ) {
      const host = kind === 'share' && isHostDeviceId(hostDeviceId)
        ? `share-host:${hostDeviceId}`
        : null;
      member = { agentDeviceId, providerId, computer: host ?? `${kind}:${agentDeviceId}` };
    }
    if (!member) continue;
    const key = providerGroupEntryKey(member.agentDeviceId, member.providerId);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(member);
  }
  return members.length > 0 ? members : null;
}

export function collectMobileProviderGroups(input: {
  /** 被控电脑：组里的它就是任务所在电脑，按被控电脑那一栏比。 */
  hostDeviceId: string;
  /** 被控电脑自己的目录。 */
  hostProviders: readonly ProviderView[];
  /** 列表里其他电脑与分享的目录。 */
  catalogs: readonly Pick<RemoteAgentCatalog, 'deviceId' | 'providers'>[];
}): MobileProviderGroups {
  const sizes = new Map<string, number>();
  const groupKeys = new Set<string>();
  const memberOf = new Map<string, MobileProviderGroupEntry>();
  const addGroup = (deviceId: string | null, provider: ProviderView) => {
    if (provider.remoteInvocationEnabled !== true) return;
    const key = providerGroupEntryKey(deviceId, provider.id);
    const members = readSummaryMembers(provider);
    if (!members) {
      // 分享来的组只告诉受邀者台数，不给名单(§8)。
      const shared = deviceId && isProviderShareAgentDeviceId(deviceId) ? readProviderShareGroupSize(provider) : null;
      if (shared !== null) sizes.set(key, shared);
      return;
    }
    // 台数按电脑算：同一台电脑上的几个账号(含同一台分享来的几个)只算一台(与桌面端一致)。
    sizes.set(key, new Set(members.map((member) => member.computer)).size);
    groupKeys.add(key);
    for (const member of members) {
      // 组员就是组那一项本身，或是被控电脑自己的供应商(被控电脑那一栏照常显示)。
      if (member.agentDeviceId === null || member.agentDeviceId === input.hostDeviceId) continue;
      const memberKey = providerGroupEntryKey(member.agentDeviceId, member.providerId);
      if (!memberOf.has(memberKey)) memberOf.set(memberKey, { deviceId, providerId: provider.id });
    }
  };
  for (const provider of input.hostProviders) addGroup(null, provider);
  for (const catalog of input.catalogs) {
    for (const provider of catalog.providers) addGroup(catalog.deviceId, provider);
  }
  for (const key of groupKeys) memberOf.delete(key);
  return { hidden: new Set(memberOf.keys()), sizes, memberOf };
}

const DEVICE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const PROVIDER_ID = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * 读被控电脑 `provider-group:remote` 的 `session-group` 回包 `{ group: { groupDeviceId, providerId } | null }`
 * (这个任务此刻归哪个组)。坐标换成选择器的：组建在被控电脑自己身上(`groupDeviceId` 为 null 或就是被控电脑)时
 * 位置为 null。格式不对按没归组处理。
 */
export function parseSessionProviderGroup(raw: unknown, hostDeviceId: string): MobileProviderGroupEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const group = (raw as { group?: unknown }).group;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
  const { groupDeviceId = null, providerId } = group as { groupDeviceId?: unknown; providerId?: unknown };
  if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) return null;
  if (groupDeviceId === null || groupDeviceId === hostDeviceId) return { deviceId: null, providerId };
  if (typeof groupDeviceId !== 'string' || !DEVICE_ID.test(groupDeviceId)) return null;
  return { deviceId: groupDeviceId, providerId };
}
