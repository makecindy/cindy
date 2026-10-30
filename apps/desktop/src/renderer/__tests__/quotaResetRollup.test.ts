/**
 * quotaResetRollup 纯函数单测:重置检测、滚动插值、倒计时 tick 节奏。
 * hook 生命周期另见 quotaResetRollup.hook.test.tsx。
 */

import { describe, expect, it } from 'vitest';

import {
  COUNTDOWN_TICK_FAST_MS,
  COUNTDOWN_TICK_SLOW_MS,
  RESET_PENDING_MAX_MS,
  ROLLUP_DURATION_MS,
  computeCountdownTickDelayMs,
  rollupDisplayPercent,
  shouldCelebrateQuotaReset,
  type ChipWindowSlot,
} from '../components/status/quotaResetRollup';

function slot(overrides: Partial<ChipWindowSlot>): ChipWindowSlot {
  return { key: 'claude-5h', remainingPercent: 0, resetsAtMs: null, ...overrides };
}

describe('shouldCelebrateQuotaReset', () => {
  it('triggers when the same window rolls to the next cycle with remaining restored', () => {
    // 典型 5h 重置: 剩余 0% → 100%, resetsAt 后移到下一周期
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 0, resetsAtMs: 1_000_000 }),
      slot({ remainingPercent: 100, resetsAtMs: 19_000_000 }),
      1_000_000,
    )).toBe(true);
    // resetsAt 语义确认了重置时, 小幅回升也触发 (轻度使用后的窗口翻转)
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 92, resetsAtMs: 1_000_000 }),
      slot({ remainingPercent: 100, resetsAtMs: 19_000_000 }),
      1_000_000,
    )).toBe(true);
  });

  it('does not infer a reset from a percentage jump without cycle evidence', () => {
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 3 }),
      slot({ remainingPercent: 100 }),
    )).toBe(false);
    // 小幅数据修正不触发
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 60 }),
      slot({ remainingPercent: 72 }),
    )).toBe(false);
    // 大幅回升但没回到接近满额 (双源 merge 口径切换) 不触发
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 10 }),
      slot({ remainingPercent: 70 }),
    )).toBe(false);
  });

  it.each([
    [2_000_000, 2_000_000], // 同周期大幅数据修正
    [2_000_000, 1_500_000], // 截止时间倒退
    [2_000_000, 2_001_000], // 两个截止时间都在未来
    [1_000_001, 19_000_000], // 即使只差1ms,也不猜测服务端时钟偏差
    [500_000, 900_000], // 两份都是历史快照
    [null, 2_000_000],
    [500_000, null],
    [Number.NaN, 2_000_000],
    [500_000, Number.POSITIVE_INFINITY],
  ])('rejects unconfirmed reset times %s → %s', (previousReset, nextReset) => {
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 60, resetsAtMs: previousReset }),
      slot({ remainingPercent: 98, resetsAtMs: nextReset }),
      1_000_000,
    )).toBe(false);
  });

  it('does not celebrate unchanged or sub-point remaining values even across cycles', () => {
    for (const remainingPercent of [98, 98.1, Number.NaN]) {
      expect(shouldCelebrateQuotaReset(
        slot({ remainingPercent: 98, resetsAtMs: 500_000 }),
        slot({ remainingPercent, resetsAtMs: 2_000_000 }),
        1_000_000,
      )).toBe(false);
    }
  });

  it('never triggers across window identities, on decreases, or without a baseline', () => {
    expect(shouldCelebrateQuotaReset(
      slot({ key: 'claude-weekly:total', remainingPercent: 0 }),
      slot({ key: 'claude-weekly:Fable', remainingPercent: 100 }),
    )).toBe(false);
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 100, resetsAtMs: 1_000_000 }),
      slot({ remainingPercent: 40, resetsAtMs: 1_000_000 }),
    )).toBe(false);
    expect(shouldCelebrateQuotaReset(null, slot({ remainingPercent: 100 }))).toBe(false);
    expect(shouldCelebrateQuotaReset(slot({ remainingPercent: 0 }), null)).toBe(false);
    // 同周期内 resetsAt 不变、剩余不升 → 不触发
    expect(shouldCelebrateQuotaReset(
      slot({ remainingPercent: 50, resetsAtMs: 1_000_000 }),
      slot({ remainingPercent: 50, resetsAtMs: 1_000_000 }),
    )).toBe(false);
  });
});

describe('rollupDisplayPercent', () => {
  it('starts at 0, ends at the target, and is monotonic in between', () => {
    expect(rollupDisplayPercent(100, 0)).toBe(0);
    expect(rollupDisplayPercent(100, -5)).toBe(0);
    expect(rollupDisplayPercent(100, ROLLUP_DURATION_MS)).toBe(100);
    expect(rollupDisplayPercent(100, ROLLUP_DURATION_MS + 500)).toBe(100);
    let last = -1;
    for (let elapsed = 0; elapsed <= ROLLUP_DURATION_MS; elapsed += 100) {
      const value = rollupDisplayPercent(100, elapsed);
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
  });

  it('ease-out: the first half covers most of the distance (数字前快后慢地跳)', () => {
    expect(rollupDisplayPercent(100, ROLLUP_DURATION_MS / 2)).toBeGreaterThan(80);
  });

  it('scales to non-100 targets (重置后立即有少量使用的快照)', () => {
    expect(rollupDisplayPercent(98, ROLLUP_DURATION_MS)).toBe(98);
    expect(rollupDisplayPercent(98, ROLLUP_DURATION_MS / 2)).toBeLessThan(98);
  });
});

describe('computeCountdownTickDelayMs', () => {
  const now = 10_000_000;

  it('ticks per second inside the last minute (含刚过点的宽限)', () => {
    expect(computeCountdownTickDelayMs([now + 45_000], now)).toBe(COUNTDOWN_TICK_FAST_MS);
    expect(computeCountdownTickDelayMs([now + 60_500], now)).toBe(COUNTDOWN_TICK_FAST_MS);
    // 刚过 reset 点: 短宽限内保持秒级, 让 label 及时落回窗口名
    expect(computeCountdownTickDelayMs([now - 2_000], now)).toBe(COUNTDOWN_TICK_FAST_MS);
    // 任一窗口进入最后一分钟即切秒级
    expect(computeCountdownTickDelayMs([now + 7 * 24 * 3600 * 1000, now + 30_000], now))
      .toBe(COUNTDOWN_TICK_FAST_MS);
  });

  it('stays on the slow minute tick otherwise', () => {
    expect(computeCountdownTickDelayMs([], now)).toBe(COUNTDOWN_TICK_SLOW_MS);
    expect(computeCountdownTickDelayMs([null], now)).toBe(COUNTDOWN_TICK_SLOW_MS);
    expect(computeCountdownTickDelayMs([now + 5 * 60_000], now)).toBe(COUNTDOWN_TICK_SLOW_MS);
    // 早已过点 (宽限外, 等快照刷新) 不再空转秒级 tick
    expect(computeCountdownTickDelayMs([now - 60_000], now)).toBe(COUNTDOWN_TICK_SLOW_MS);
  });

  it('never overshoots the pending-expiry boundary (悬念超时即刻退出, 不多挂一分钟)', () => {
    // 过点 9 分 40 秒: 下一跳精确落在 10 分钟超时边界 (20s 后), 而不是 60s 后
    expect(computeCountdownTickDelayMs([now - (RESET_PENDING_MAX_MS - 20_000)], now))
      .toBe(20_000);
    // 已超时: 无边界可踩, 回到慢 tick
    expect(computeCountdownTickDelayMs([now - (RESET_PENDING_MAX_MS + 60_000)], now))
      .toBe(COUNTDOWN_TICK_SLOW_MS);
    // 距超时不足 1s: 钳到秒级下限, 不返回 0/负值
    expect(computeCountdownTickDelayMs([now - (RESET_PENDING_MAX_MS - 200)], now))
      .toBe(COUNTDOWN_TICK_FAST_MS);
  });

  it('never overshoots the last-minute boundary (剩 75 秒不能僵住一分钟)', () => {
    // 剩 75s: 下一跳精确落在 remain=61s 边界, 而不是 60s 后 (那时只剩 15s, 秒跳被吃掉大半)
    expect(computeCountdownTickDelayMs([now + 75_000], now)).toBe(75_000 - 61_000);
    // 剩 90s → 29s 后到边界
    expect(computeCountdownTickDelayMs([now + 90_000], now)).toBe(29_000);
    // 已在边界内侧一点点 → 不返回 0/负值, 钳到秒级下限
    expect(computeCountdownTickDelayMs([now + 61_200], now)).toBe(COUNTDOWN_TICK_FAST_MS);
    // 多窗口取最近的边界
    expect(computeCountdownTickDelayMs([now + 7 * 24 * 3600 * 1000, now + 75_000], now))
      .toBe(75_000 - 61_000);
  });
});
