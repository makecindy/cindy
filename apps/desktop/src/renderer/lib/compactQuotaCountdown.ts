import type { TFunction } from 'i18next';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * chip 主体用的紧凑剩余时长(距 reset 还有多久): 单级精度 + 向上取整 ——
 * 「7天」/「3小时」/「45分钟」/「41秒」。Codex 与 Claude 订阅两种形态统一用它当窗口
 * label(所有限额窗口都算给用户);无数据 / 已过期 → null, 调用方回退窗口名。
 * 天级向上取整与 Codex 既有 getDaysUntilReset 口径一致(剩 6天10小时 → 7天)。
 * 最后一分钟降到秒级, 配合秒级 tick(computeCountdownTickDelayMs)逐秒走动。
 *
 * windowMinutes 已知时剩余时长以窗口长度封顶: 窗口刚重置时 resetsAt 可能因服务端
 * 取整或时钟偏差比 now 晚出窗口长度一点点, 向上取整会把 7 天周限显示成「8天」。
 */
export function formatCompactTimeUntilReset(
  epochSeconds: number | null | undefined,
  nowMs: number,
  t: TFunction,
  windowMinutes?: number | null,
): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return null;
  }
  let remainMs = epochSeconds * 1000 - nowMs;
  if (remainMs <= 0) return null;
  if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    remainMs = Math.min(remainMs, windowMinutes * 60_000);
  }
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

/** 不下发 windowMinutes 的 Claude 5h / 周限窗口的固定长度。 */
export const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
