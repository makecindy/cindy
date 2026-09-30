import type { TFunction } from 'i18next';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * chip 主体用的紧凑剩余时长(距 reset 还有多久): 单级精度 + 向上取整 ——
 * 「7天」/「3小时」/「45分钟」/「41秒」。Codex 与 Claude 订阅两种形态统一用它当窗口
 * label(所有限额窗口都算给用户);无数据 / 已过期 → null, 调用方回退窗口名。
 * 天级向上取整与 Codex 既有 getDaysUntilReset 口径一致(剩 6天10小时 → 7天)。
 * 最后一分钟降到秒级, 配合秒级 tick(computeCountdownTickDelayMs)逐秒走动。
 */
export function formatCompactTimeUntilReset(
  epochSeconds: number | null | undefined,
  nowMs: number,
  t: TFunction,
): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  const remainMs = epochSeconds * 1000 - nowMs;
  if (remainMs <= 0) return null;
  if (remainMs >= DAY_MS) {
    return `${Math.ceil(remainMs / DAY_MS)}${t('todaySpend.unit.day')}`;
  }
  if (remainMs >= 60 * 60 * 1000) {
    return `${Math.ceil(remainMs / (60 * 60 * 1000))}${t('todaySpend.unit.hour')}`;
  }
  if (remainMs >= 60_000) {
    return `${Math.ceil(remainMs / 60_000)}${t('todaySpend.unit.minute')}`;
  }
  return `${Math.max(1, Math.ceil(remainMs / 1000))}${t('todaySpend.unit.second')}`;
}
