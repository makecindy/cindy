/**
 * usageFormat.test.ts
 * ---------------------------------------------------------------------------
 * token 紧凑口径 —— desktop 消息动作行与 mobile 操作行共用这一份,
 * 同一轮在两端必须读到同一个数字。
 */

import { describe, expect, it } from 'vitest';

import { formatCompactTokens } from '../usageFormat';

describe('formatCompactTokens', () => {
  it('小于 1k 原样输出', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(1)).toBe('1');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('千位档一位小数', () => {
    expect(formatCompactTokens(1000)).toBe('1.0k');
    expect(formatCompactTokens(12_400)).toBe('12.4k');
    expect(formatCompactTokens(999_949)).toBe('999.9k');
  });

  it('百万档一位小数', () => {
    expect(formatCompactTokens(1_000_000)).toBe('1.0M');
    expect(formatCompactTokens(2_107_700)).toBe('2.1M');
  });

  it('十亿档一位小数(重度会话的 cache read 会到这个量级)', () => {
    expect(formatCompactTokens(1_000_000_000)).toBe('1.0B');
    expect(formatCompactTokens(9_290_698_420)).toBe('9.3B');
  });

  // 舍入不得跨档:999_999 曾输出 "1000.0k"(量级已是 M、单位还停在 k),自相矛盾。
  it('舍入达到 1000.0 时进到上一档', () => {
    expect(formatCompactTokens(999_999)).toBe('1.0M');
    expect(formatCompactTokens(999_950)).toBe('1.0M');
    expect(formatCompactTokens(999_999_999)).toBe('1.0B');
    // 恰好在阈值下方仍留在本档。
    expect(formatCompactTokens(999_949_999)).toBe('999.9M');
  });

  it('超出最大档继续用 B 表达', () => {
    expect(formatCompactTokens(1_000_000_000_000)).toBe('1000.0B');
  });
});
