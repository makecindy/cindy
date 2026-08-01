/**
 * usageFormat — 用量数字展示的共享口径(desktop 与 mobile 共用一份)。
 *
 * 消息底部那一格在拿不到金额时退回显示本轮 token,两端必须给出同一个数字形态
 * —— 各写一份必然漂移(同一轮在桌面读作 2.1M、在手机读作 2,097k 就无从核对)。
 */

/** 从小到大:命中第一个「四舍五入后仍不满 1000」的单位。 */
const TOKEN_UNITS: ReadonlyArray<{ divisor: number; suffix: string }> = [
  { divisor: 1_000, suffix: 'k' },
  { divisor: 1_000_000, suffix: 'M' },
  { divisor: 1_000_000_000, suffix: 'B' },
];

/**
 * toFixed(1) 对 ≥999.95 会舍入成 "1000.0" —— 那已经是上一档的量级,
 * 单位却还停在小档(999_999 → "1000.0k"),读起来自相矛盾。命中该阈值就进档。
 */
const UNIT_CARRY_THRESHOLD = 999.95;

/** 紧凑 token 数: ≥1B 用 X.XB, ≥1M 用 X.XM, ≥1k 用 X.Xk, 否则原值。 */
export function formatCompactTokens(n: number): string {
  if (n < TOKEN_UNITS[0].divisor) return String(n);
  for (const { divisor, suffix } of TOKEN_UNITS) {
    const scaled = n / divisor;
    if (scaled < UNIT_CARRY_THRESHOLD) return `${scaled.toFixed(1)}${suffix}`;
  }
  // 超出最大单位(≥ ~1000B)只能继续用 B 表达。
  const largest = TOKEN_UNITS[TOKEN_UNITS.length - 1];
  return `${(n / largest.divisor).toFixed(1)}${largest.suffix}`;
}
