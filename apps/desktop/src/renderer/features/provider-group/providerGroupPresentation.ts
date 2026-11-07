/**
 * 供应商组的界面按物理电脑聚合(2026-10-15 用户要求)：同一台电脑上登录了几个同品牌账号时，
 * 底层仍是几个独立的组内账号(各自的上限、暂停与冷却)，界面上收在同一台电脑下面；只有一个账号的电脑不分两层。
 */
import { formatQuotaResetAt } from '@/components/status/usageCardModel';
import type { useTranslation } from 'react-i18next';

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

export function memberStatusText(
  t: ReturnType<typeof useTranslation>['t'],
  status: ProviderGroupMemberStatus | undefined,
  locale: string,
  nowMs: number = Date.now(),
): string {
  if (!status) return t('providerGroup.member.status.checking');
  switch (status.state) {
    case 'available':
      // 「可用」不报负载，整列空着时就看不出每台跑了几个；状态词直接承载运行数。
      return status.running > 0
        ? t('providerGroup.member.runningCount', { count: status.running })
        : t('providerGroup.member.status.idle');
    case 'full':
      return t('providerGroup.member.status.full');
    case 'paused':
      return t('providerGroup.member.status.paused');
    case 'cooling': {
      // 不在今天恢复的(周上限等)带上日期，不让「约 16:00 恢复」看起来像今天就能用。
      const time = status.coolingUntil ? formatQuotaResetAt(status.coolingUntil / 1000, nowMs, locale) : null;
      return time
        ? t('providerGroup.member.status.coolingUntil', { time })
        : t('providerGroup.member.status.cooling');
    }
    case 'offline':
      return t('providerGroup.member.status.offline');
    case 'unavailable':
    default:
      return t(`providerGroup.member.status.unavailable.${status.reason ?? 'disconnected'}`);
  }
}
