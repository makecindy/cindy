import { describe, it, expect } from 'vitest';
import {
  tryParseMonthlyPreset,
  nextMonthlyFire,
  nextCronOrMonthlyFire,
} from '../engine/monthlyClamp.js';

describe('tryParseMonthlyPreset', () => {
  it('parses canonical monthly preset `MM HH D * *`', () => {
    expect(tryParseMonthlyPreset('0 9 31 * *')).toEqual({ minute: 0, hour: 9, day: 31 });
    expect(tryParseMonthlyPreset('30 14 1 * *')).toEqual({ minute: 30, hour: 14, day: 1 });
  });

  it('rejects when DOW is restricted (would be a weekly variant)', () => {
    expect(tryParseMonthlyPreset('0 9 31 * 1')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 31 * 1-5')).toBeNull();
  });

  it('rejects when month is restricted', () => {
    expect(tryParseMonthlyPreset('0 9 31 1 *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 31 */2 *')).toBeNull();
  });

  it('rejects daily / weekly patterns', () => {
    expect(tryParseMonthlyPreset('0 9 * * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 * * 1')).toBeNull();
  });

  it('rejects DOM lists/ranges (custom territory, keep standard cron semantics)', () => {
    expect(tryParseMonthlyPreset('0 9 1,15 * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 1-5 * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 */7 * *')).toBeNull();
  });

  it('rejects out-of-range fields', () => {
    expect(tryParseMonthlyPreset('60 9 31 * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 24 31 * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 32 * *')).toBeNull();
    expect(tryParseMonthlyPreset('0 9 0 * *')).toBeNull();
  });
});

describe('nextMonthlyFire', () => {
  // Use Asia/Shanghai (UTC+8, no DST) for most cases — matches default UI timezone.

  it('day=31 from mid-Jan → fires this month (1/31)', () => {
    // 2026-01-15 12:00 CST
    const from = Date.UTC(2026, 0, 15, 4, 0); // 12:00 CST = 04:00 UTC
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    // Expect 2026-01-31 09:00 CST = 01:00 UTC
    expect(next).toBe(Date.UTC(2026, 0, 31, 1, 0));
  });

  it('day=31 from 1/31 09:00 sharp → next is 2/28 (clamp, non-leap year 2026)', () => {
    const from = Date.UTC(2026, 0, 31, 1, 0); // 09:00 CST sharp
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    // 2026-02-28 09:00 CST
    expect(next).toBe(Date.UTC(2026, 1, 28, 1, 0));
  });

  it('day=31 from 2/15 → 2/28 (clamp, non-leap)', () => {
    const from = Date.UTC(2026, 1, 15, 4, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 1, 28, 1, 0));
  });

  it('day=31 from 4/15 → 4/30 (clamp, 30-day month)', () => {
    const from = Date.UTC(2026, 3, 15, 4, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 3, 30, 1, 0));
  });

  it('day=31 from 4/30 09:00 sharp → 5/31 (next month has 31)', () => {
    const from = Date.UTC(2026, 3, 30, 1, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 4, 31, 1, 0));
  });

  it('day=29 in leap-year Feb (2024) → fires 2/29', () => {
    // 2024-02-15 12:00 CST
    const from = Date.UTC(2024, 1, 15, 4, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 29 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2024, 1, 29, 1, 0));
  });

  it('day=29 in non-leap Feb (2026) → fires 2/28 (clamp)', () => {
    const from = Date.UTC(2026, 1, 15, 4, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 29 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 1, 28, 1, 0));
  });

  it('year rollover: day=31 from 12/31 09:00 sharp → 1/31 next year', () => {
    const from = Date.UTC(2026, 11, 31, 1, 0);
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2027, 0, 31, 1, 0));
  });

  it('day=1 always fires on the 1st (no clamp ever needed)', () => {
    const from = Date.UTC(2026, 0, 1, 1, 0); // 09:00 CST sharp on 1st
    const next = nextMonthlyFire({ minute: 0, hour: 9, day: 1 }, from, 'Asia/Shanghai');
    // sharp boundary skips to next month's 1st
    expect(next).toBe(Date.UTC(2026, 1, 1, 1, 0));
  });

  it('respects timezone: day=31 09:00 in UTC vs Asia/Shanghai differ by 8h', () => {
    const from = Date.UTC(2026, 0, 15, 0, 0);
    const utc = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'UTC');
    const cst = nextMonthlyFire({ minute: 0, hour: 9, day: 31 }, from, 'Asia/Shanghai');
    expect(utc).toBe(Date.UTC(2026, 0, 31, 9, 0));
    expect(cst).toBe(Date.UTC(2026, 0, 31, 1, 0));
  });
});

describe('nextCronOrMonthlyFire (dispatch)', () => {
  it('routes monthly preset through clamp algorithm', () => {
    const from = Date.UTC(2026, 1, 15, 4, 0);
    const result = nextCronOrMonthlyFire('0 9 31 * *', from, 'Asia/Shanghai');
    // Monthly preset clamp: Feb 28 (non-leap) at 09:00 CST
    expect(result).toBe(Date.UTC(2026, 1, 28, 1, 0));
  });

  it('falls back to standard cron for non-preset shapes', () => {
    // `0 9 * * *` daily → not a monthly preset, goes through nextRun
    const from = Date.UTC(2026, 0, 15, 4, 0); // 12:00 CST
    const result = nextCronOrMonthlyFire('0 9 * * *', from, 'Asia/Shanghai');
    // next 09:00 CST after 12:00 CST = next day 09:00 CST
    expect(result).toBe(Date.UTC(2026, 0, 16, 1, 0));
  });

  it('falls back to standard cron for custom DOM lists (no clamp)', () => {
    // `0 9 31 * *` would clamp; `0 9 1,31 * *` is custom and stays vixie-cron
    const from = Date.UTC(2026, 1, 15, 4, 0); // mid-Feb
    const result = nextCronOrMonthlyFire('0 9 1,31 * *', from, 'Asia/Shanghai');
    // Standard cron: Feb has no 31, Feb 1 already past → next is March 1 09:00 CST
    expect(result).toBe(Date.UTC(2026, 2, 1, 1, 0));
  });

  it('monthly preset in the DST fall-back overlap does not skip the month', () => {
    // 2026-11-01 06:31Z = 01:31 EST (second pass of the repeated 01:xx hour).
    // `45 1 1 * *` fires at wall 01:45 on the 1st; the earlier occurrence
    // (05:45Z) is in the past, which used to push the fire to Dec 1 and skip
    // November entirely.
    const from = Date.UTC(2026, 10, 1, 6, 31, 0);
    const result = nextCronOrMonthlyFire('45 1 1 * *', from, 'America/New_York');
    expect(result).toBe(Date.UTC(2026, 10, 1, 6, 45, 0));
  });
});
