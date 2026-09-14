/**
 * formatUsagePercent — 百分比展示, 与 TodaySpendChip 的 formatTurnUsagePercent 同一形态:
 * 接近整数时不带小数, 否则保留一位并去掉末尾的 .0。
 */
export function formatUsagePercent(value: number): string {
  const percent = Math.min(100, Math.max(0, value * 100));
  if (Math.abs(percent - Math.round(percent)) < 0.05) return `${Math.round(percent)}%`;
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
}
