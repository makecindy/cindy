import type { CurrentlyRunningInfo } from 'expo-updates';

import { i18n } from '@/i18n';

// 热更验证标记:纯 JS 常量,发 OTA 后在设备设置页看到该值即证明热更 bundle 已生效。
// 每次要验证热更时改这个值(建议带日期),验证完可保留或删除,对功能无影响。
export const OTA_VERIFY_MARKER = 'ota-check-20260707-2';

/** 设置页「更新信息」区块的一条只读展示行。 */
export interface MobileUpdateInfoRow {
  id: string;
  label: string;
  value: string;
}

// 只取展示需要的字段,避免依赖 CurrentlyRunningInfo 的全部字段(也让单测 fixture 最小化)。
type MobileUpdateInfoInput = Pick<
  CurrentlyRunningInfo,
  'updateId' | 'channel' | 'createdAt' | 'isEmbeddedLaunch' | 'runtimeVersion'
>;

/** 当前实际运行的热更版本:OTA 用短 updateId,内置 bundle 明确标成随整包。 */
export function currentMobileOtaVersion(
  currentlyRunning: Pick<CurrentlyRunningInfo, 'updateId' | 'isEmbeddedLaunch'>,
): string {
  if (currentlyRunning.isEmbeddedLaunch) return i18n.t('settings.updateInfo.embedded');
  return currentlyRunning.updateId?.trim().slice(0, 8) || i18n.t('settings.updateInfo.unknown');
}

/**
 * 把 expo-updates `useUpdates().currentlyRunning` 整理成设置页「更新信息」的只读行(纯函数,便于单测)。
 * 用途:验证 OTA 热更是否生效 + 一眼看这台机当前跑的是哪个 bundle。
 * - 运行来源:isEmbeddedLaunch → 内置(随包),否则 OTA 热更新;
 * - 更新 ID:有就取前 8 位(canonical UUID 全小写),无(dev / expo-updates 未启用)显示 —;
 * - 更新时间:createdAt 本地时间 YYYY-MM-DD HH:mm,无则 —;
 * - Channel / Runtime:trim 后展示,空则 —。
 */
export function buildMobileUpdateInfoRows(currentlyRunning: MobileUpdateInfoInput): MobileUpdateInfoRow[] {
  const updateId = currentlyRunning.updateId;
  const createdAt = currentlyRunning.createdAt;
  return [
    {
      id: 'source',
      label: i18n.t('settings.updateInfo.source'),
      value: currentlyRunning.isEmbeddedLaunch
        ? i18n.t('settings.updateInfo.sourceEmbedded')
        : i18n.t('settings.updateInfo.sourceOta'),
    },
    { id: 'updateId', label: i18n.t('settings.updateInfo.updateId'), value: updateId ? updateId.slice(0, 8) : '—' },
    { id: 'updatedAt', label: i18n.t('settings.updateInfo.updatedAt'), value: createdAt ? formatMobileUpdateTime(createdAt) : '—' },
    { id: 'channel', label: i18n.t('settings.updateInfo.channel'), value: currentlyRunning.channel?.trim() || '—' },
    { id: 'runtimeVersion', label: i18n.t('settings.updateInfo.runtime'), value: currentlyRunning.runtimeVersion?.trim() || '—' },
    { id: 'otaMarker', label: i18n.t('settings.updateInfo.otaMarker'), value: OTA_VERIFY_MARKER },
  ];
}

function formatMobileUpdateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
