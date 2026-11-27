import type { TFunction } from 'i18next';

const MINUTE_MS = 60_000;

/**
 * 剩余时长的唯一分解: 胶囊(compact)与悬浮窗(详细)都从这里取, 只差拼几段 ——
 * 粗口径因此永远是细口径的前缀, 不会出现「点开反而变少」。
 * 天/小时/分钟向下取整, 只有末位分钟向上取整, 防止还没到点就归零。
 */
export function formatQuotaRemainingDuration(
  remainMs: number,
  t: TFunction,
  options?: { compact?: boolean },
): string | null {
  if (!Number.isFinite(remainMs) || remainMs <= 0) return null;
  const minutes = Math.max(1, Math.ceil(remainMs / MINUTE_MS));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    return hours
      ? `${days}${t('todaySpend.unit.day')} ${hours}${t('todaySpend.unit.hour')}`
      : `${days}${t('todaySpend.unit.day')}`;
  }
  if (hours > 0) {
    return options?.compact || !rest
      ? `${hours}${t('todaySpend.unit.hour')}`
      : `${hours}${t('todaySpend.unit.hour')} ${rest}${t('todaySpend.unit.minute')}`;
  }
  return `${minutes}${t('todaySpend.unit.minute')}`;
}

/**
 * chip 主体用的紧凑剩余时长(距 reset 还有多久):「4天 1小时」/「3小时」/「45分钟」/「41秒」。
 * Codex 与 Claude 订阅两种形态统一用它当窗口 label(所有限额窗口都算给用户);
 * 无数据 / 已过期 → null, 调用方回退窗口名。
 * 天级带小时段, 与悬浮窗逐字相同(剩 4天1小时 不写成「5天」); 小时以下只留一级,
 * 最后一分钟降到秒级, 配合秒级 tick(computeCountdownTickDelayMs)逐秒走动。
 *
 * windowMinutes 已知时剩余时长以窗口长度封顶: 窗口刚重置时 resetsAt 可能因服务端
 * 取整或时钟偏差比 now 晚出窗口长度一点点, 不封顶会多显示一小时。
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
    remainMs = Math.min(remainMs, windowMinutes * MINUTE_MS);
  }
  if (remainMs < MINUTE_MS) {
    return `${Math.max(1, Math.ceil(remainMs / 1000))}${t('todaySpend.unit.second')}`;
  }
  return formatQuotaRemainingDuration(remainMs, t, { compact: true });
}

/** 不下发 windowMinutes 的 Claude 5h / 周限窗口的固定长度。 */
export const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
