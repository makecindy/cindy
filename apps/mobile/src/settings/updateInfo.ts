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
> & Partial<Pick<CurrentlyRunningInfo, 'isEmergencyLaunch' | 'emergencyLaunchReason'>>;

/**
 * 当前实际运行的热更版本:OTA 用短 updateId,内置 bundle 明确标成随整包。
 *
 * emergency launch(expo-updates 没找到可启动 update、退回内置 bundle)下 updateId 为空且
 * isEmbeddedLaunch 也是 false —— 这不是"未知",而是确定跑着内置 bundle 且本次运行内热更
 * 无法生效(reload 会被原生层拒绝)。单独出文案,免得看到"未知"以为是读不到版本。
 */
export function currentMobileOtaVersion(
  currentlyRunning: Pick<CurrentlyRunningInfo, 'updateId' | 'isEmbeddedLaunch'>
    & Partial<Pick<CurrentlyRunningInfo, 'isEmergencyLaunch'>>,
): string {
  if (currentlyRunning.isEmbeddedLaunch) return i18n.t('settings.updateInfo.embedded');
  const shortId = currentlyRunning.updateId?.trim().slice(0, 8);
  if (shortId) return shortId;
  if (currentlyRunning.isEmergencyLaunch) return i18n.t('settings.updateInfo.embeddedFallback');
  return i18n.t('settings.updateInfo.unknown');
}

/**
 * 把 expo-updates `useUpdates().currentlyRunning` 整理成设置页「更新信息」的只读行(纯函数,便于单测)。
 * 用途:验证 OTA 热更是否生效 + 一眼看这台机当前跑的是哪个 bundle。
 * - 运行来源:isEmbeddedLaunch → 内置(随包),否则 OTA 热更新;
 * - 更新 ID:有就取前 8 位(canonical UUID 全小写),无(dev / expo-updates 未启用)显示 —;
 * - 更新时间:createdAt 本地时间 YYYY-MM-DD HH:mm,无则 —;
 * - Channel / Runtime:trim 后展示,空则 —;
 * - 应急启动:仅 isEmergencyLaunch 时追加一行,带上原生给的原因(诊断"热更点了没反应"的第一现场)。
 */
export function buildMobileUpdateInfoRows(currentlyRunning: MobileUpdateInfoInput): MobileUpdateInfoRow[] {
  const updateId = currentlyRunning.updateId;
  const createdAt = currentlyRunning.createdAt;
  const emergencyReason = currentlyRunning.emergencyLaunchReason?.trim();
  return [
    {
      id: 'source',
      label: i18n.t('settings.updateInfo.source'),
      // 应急启动跑的也是内置 bundle(只是没走 embedded update 记录,isEmbeddedLaunch 为 false),
      // 报「OTA 热更新」会跟同一区块里的应急启动行、以及「热更版本」自相矛盾。
      value: currentlyRunning.isEmbeddedLaunch
        ? i18n.t('settings.updateInfo.sourceEmbedded')
        : currentlyRunning.isEmergencyLaunch
          ? i18n.t('settings.updateInfo.sourceEmergencyFallback')
          : i18n.t('settings.updateInfo.sourceOta'),
    },
    { id: 'updateId', label: i18n.t('settings.updateInfo.updateId'), value: updateId ? updateId.slice(0, 8) : '—' },
    { id: 'updatedAt', label: i18n.t('settings.updateInfo.updatedAt'), value: createdAt ? formatMobileUpdateTime(createdAt) : '—' },
    { id: 'channel', label: i18n.t('settings.updateInfo.channel'), value: currentlyRunning.channel?.trim() || '—' },
    { id: 'runtimeVersion', label: i18n.t('settings.updateInfo.runtime'), value: currentlyRunning.runtimeVersion?.trim() || '—' },
    { id: 'otaMarker', label: i18n.t('settings.updateInfo.otaMarker'), value: OTA_VERIFY_MARKER },
    ...(currentlyRunning.isEmergencyLaunch
      ? [{
        id: 'emergencyLaunch',
        label: i18n.t('settings.updateInfo.emergencyLaunch'),
        value: emergencyReason || i18n.t('settings.updateInfo.emergencyLaunchYes'),
      }]
      : []),
  ];
}

function formatMobileUpdateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
