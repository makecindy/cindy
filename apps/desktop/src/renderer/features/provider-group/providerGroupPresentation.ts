/**
 * 供应商组的界面按物理电脑聚合(2026-10-15 用户要求)：同一台电脑上登录了几个同品牌账号时，
 * 底层仍是几个独立的组内账号(各自的上限、暂停与冷却)，界面上收在同一台电脑下面；只有一个账号的电脑不分两层。
 */
import {
  providerGroupPhysicalDeviceKey,
  type ProviderGroupMember,
  type ProviderGroupMemberStatus,
  type ProviderGroupPhysicalMember,
} from '../../../shared/providerGroup';

export interface ProviderGroupDeviceBucket<T> {
  key: string;
  items: T[];
}

/**
 * 按物理电脑聚合展示(分享来的按分享者那台电脑)，保留每个账号槽位的原始顺序与对象；电脑按它第一个账号出现的位置排。
 */
export function groupProviderGroupItems<T extends ProviderGroupPhysicalMember>(
  items: readonly T[],
): ProviderGroupDeviceBucket<T>[] {
  const buckets = new Map<string, ProviderGroupDeviceBucket<T>>();
  for (const item of items) {
    const key = providerGroupPhysicalDeviceKey(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.items.push(item);
    else buckets.set(key, { key, items: [item] });
  }
  return [...buckets.values()];
}

/** 账号行的名称：那台电脑上这个供应商现在的显示名，读不到时用加入时的快照；旧组两者都没有时为 null。 */
export function providerGroupAccountName(
  member: Pick<ProviderGroupMember, 'providerName'>,
  status: Pick<ProviderGroupMemberStatus, 'providerName'> | undefined,
): string | null {
  return status?.providerName || member.providerName || null;
}

type VersionStatus = Pick<ProviderGroupMemberStatus, 'appVersion' | 'guestSupport'>;

/** 电脑这一层的版本：同一台电脑的几个账号是同一个应用，取读到的版本；任一账号需要更新就提示。 */
export function providerGroupDeviceVersion(
  statuses: readonly (VersionStatus | undefined)[],
): VersionStatus | undefined {
  const known = statuses.filter((status): status is VersionStatus => status != null);
  if (known.length === 0) return undefined;
  const appVersion = known.find((status) => status.appVersion)?.appVersion;
  const guestSupport = known.some((status) => status.guestSupport === 'needs-update')
    ? 'needs-update' as const
    : known[0].guestSupport;
  return { ...(appVersion ? { appVersion } : {}), ...(guestSupport ? { guestSupport } : {}) };
}
