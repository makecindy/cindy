import { describe, it, expect } from 'vitest';
import { parseCron, nextRun, cronToHuman } from '../engine/cron.js';

describe('parseCron', () => {
  it('expands */5 in minute field', () => {
    const p = parseCron('*/5 * * * *');
    expect(p.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(p.hour.length).toBe(24);
    expect(p.dayOfMonth.length).toBe(31);
  });

  it('expands range with step "0-30/10"', () => {
    const p = parseCron('0-30/10 * * * *');
    expect(p.minute).toEqual([0, 10, 20, 30]);
  });

  it('parses comma-separated values', () => {
    const p = parseCron('5,15,45 * * * *');
    expect(p.minute).toEqual([5, 15, 45]);
  });

  it('parses 1-5 in dayOfWeek', () => {
    const p = parseCron('0 9 * * 1-5');
    expect(p.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(p.dowRestricted).toBe(true);
    expect(p.domRestricted).toBe(false);
  });

  it('treats dayOfWeek 7 as Sunday (=0)', () => {
    const p = parseCron('0 0 * * 7');
    expect(p.dayOfWeek).toEqual([0]);
  });

  it('expands dayOfWeek steps through the Sunday alias 7', () => {
    expect(parseCron('0 0 * * 7/2').dayOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 5/2').dayOfWeek).toEqual([0, 5]);
  });

  it('rejects out-of-range minute', () => {
    expect(() => parseCron('60 * * * *')).toThrow();
  });

  it('rejects wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('* * * * * *')).toThrow();
  });

  it('rejects malformed numeric field segments instead of partially parsing them', () => {
    expect(() => parseCron('5abc * * * *')).toThrow();
    expect(() => parseCron('*/5abc * * * *')).toThrow();
    expect(() => parseCron('1-2-3 * * * *')).toThrow();
    expect(() => parseCron('1/2/3 * * * *')).toThrow();
  });
});

describe('nextRun', () => {
  it('every 5 minutes (UTC) — from 12:03 → 12:05', () => {
    const from = Date.UTC(2026, 0, 1, 12, 3, 0);
    const next = nextRun('*/5 * * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 12, 5, 0));
  });

  it('every 5 minutes (UTC) — from 12:05:00 boundary → 12:10', () => {
    // Boundary case: at 12:05:00.000 the *current* fire would have been at 12:05.
    // nextRun should return the *next* one, i.e., 12:10.
    const from = Date.UTC(2026, 0, 1, 12, 5, 0);
    const next = nextRun('*/5 * * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 12, 10, 0));
  });

  it('weekday 9am Asia/Shanghai (UTC+8) — Friday 10:00 CST → Monday 09:00 CST', () => {
    // 2026-01-02 is Friday. 10:00 CST = 02:00 UTC.
    // Next 9am on weekday is Monday 2026-01-05 09:00 CST = 01:00 UTC.
    const from = Date.UTC(2026, 0, 2, 2, 0, 0);
    const next = nextRun('0 9 * * 1-5', from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 0, 5, 1, 0, 0));
  });

  it('Feb 27 14:30 UTC — from 2026-02-28 → 2027-02-27 14:30 UTC', () => {
    const from = Date.UTC(2026, 1, 28, 0, 0, 0);
    const next = nextRun('30 14 27 2 *', from, 'UTC');
    expect(next).toBe(Date.UTC(2027, 1, 27, 14, 30, 0));
  });

  it('every 30 minutes — from 14:45 wraps to 15:00 (regression: not 16:00)', () => {
    // After app restart at 14:45 with "*/30 * * * *", the next fire must be 15:00,
    // not 16:00. Earlier code added +2h when wrapping minutes into the next hour,
    // skipping the 15:00 slot entirely.
    const from = Date.UTC(2026, 0, 1, 14, 45, 0);
    const next = nextRun('*/30 * * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 15, 0, 0));
  });

  it('every 30 minutes Asia/Shanghai — from 14:45 local wraps to 15:00 local', () => {
    // 14:45 CST = 06:45 UTC. Next fire 15:00 CST = 07:00 UTC.
    const from = Date.UTC(2026, 0, 1, 6, 45, 0);
    const next = nextRun('*/30 * * * *', from, 'Asia/Shanghai');
    expect(next).toBe(Date.UTC(2026, 0, 1, 7, 0, 0));
  });

  // --- restart-recovery coverage for the 6 UI schedule modes ---
  // Each test simulates "user opens app at <time>" → engine recomputes nextFireAt
  // from now() and persists it back. Verifies all 6 modes land on the right next slot.

  it('Hourly mode (every 2h): restart at 14:45 → 16:00', () => {
    // `0 */2 * * *` → minute=[0], hour=[0,2,4,...,22]
    const from = Date.UTC(2026, 0, 1, 14, 45, 0);
    const next = nextRun('0 */2 * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 16, 0, 0));
  });

  it('Hourly mode (every 3h): restart at 14:45 → 15:00', () => {
    // hour=[0,3,6,9,12,15,18,21]; 14 not in list, next is 15 — same day
    const from = Date.UTC(2026, 0, 1, 14, 45, 0);
    const next = nextRun('0 */3 * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 15, 0, 0));
  });

  it('Daily 09:00 — restart at 14:45 → tomorrow 09:00', () => {
    const from = Date.UTC(2026, 0, 1, 14, 45, 0);
    const next = nextRun('0 9 * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  it('Daily 09:00 — restart at 06:30 → today 09:00', () => {
    const from = Date.UTC(2026, 0, 1, 6, 30, 0);
    const next = nextRun('0 9 * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it('Daily 09:00 — restart exactly at 09:00:00 → tomorrow 09:00 (boundary)', () => {
    // Cron resolution is 1 min; nextRun snaps fromMs to the next minute boundary,
    // so a fire scheduled FOR 09:00 won't be re-issued — it would have fired
    // already by tick(). The next slot is tomorrow.
    const from = Date.UTC(2026, 0, 1, 9, 0, 0);
    const next = nextRun('0 9 * * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  it('Weekdays 09:00 — restart Friday 14:45 → Monday 09:00', () => {
    // 2026-01-02 is Friday. Sat (3rd) and Sun (4th) skipped → Mon 5th.
    const from = Date.UTC(2026, 0, 2, 14, 45, 0);
    const next = nextRun('0 9 * * 1-5', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });

  it('Weekdays 09:00 — restart Saturday 03:00 → Monday 09:00', () => {
    // 2026-01-03 Sat. Day-wrap until Monday.
    const from = Date.UTC(2026, 0, 3, 3, 0, 0);
    const next = nextRun('0 9 * * 1-5', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });

  it('Weekly Mon 09:00 — restart Monday 09:30 → next Monday 09:00', () => {
    // 2026-01-05 Mon 09:30. Already past today's 09:00 → next Mon (Jan 12).
    const from = Date.UTC(2026, 0, 5, 9, 30, 0);
    const next = nextRun('0 9 * * 1', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 12, 9, 0, 0));
  });

  it('Monthly day-15 09:00 — restart on 20th at 14:45 → next-month 15th 09:00', () => {
    const from = Date.UTC(2026, 0, 20, 14, 45, 0);
    const next = nextRun('0 9 15 * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 1, 15, 9, 0, 0));
  });

  it('Monthly day-15 09:00 — restart on 10th at 06:00 → same-month 15th 09:00', () => {
    const from = Date.UTC(2026, 0, 10, 6, 0, 0);
    const next = nextRun('0 9 15 * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 0, 15, 9, 0, 0));
  });

  it('Monthly day-31 — Feb gets skipped, lands on Mar 31', () => {
    // 31st of every month: Feb has no 31st, so we walk through Feb 1..28 (or 29) day-wraps.
    const from = Date.UTC(2026, 1, 1, 0, 0, 0); // Feb 1 00:00
    const next = nextRun('0 9 31 * *', from, 'UTC');
    expect(next).toBe(Date.UTC(2026, 2, 31, 9, 0, 0)); // Mar 31 09:00
  });

  it('crosses DST start in America/New_York (2026-03-08)', () => {
    // DST starts 2026-03-08 02:00 EST → 03:00 EDT.
    // cron "0 12 * * *" — daily noon local.
    // EST offset: UTC-5; EDT offset: UTC-4.
    // 2026-03-07 12:00 EST = 17:00 UTC. We start just after that.
    // Next fire: 2026-03-08 12:00 EDT = 16:00 UTC.
    const from = Date.UTC(2026, 2, 7, 17, 0, 1);
    const next = nextRun('0 12 * * *', from, 'America/New_York');
    expect(next).toBe(Date.UTC(2026, 2, 8, 16, 0, 0));
  });

  it('crosses DST end in America/New_York (2026-11-01)', () => {
    // DST ends 2026-11-01 02:00 EDT → 01:00 EST.
    // cron "0 12 * * *" — daily noon local.
    // 2026-10-31 12:00 EDT = 16:00 UTC. We start just after that.
    // Next fire: 2026-11-01 12:00 EST = 17:00 UTC.
    const from = Date.UTC(2026, 9, 31, 16, 0, 1);
    const next = nextRun('0 12 * * *', from, 'America/New_York');
    expect(next).toBe(Date.UTC(2026, 10, 1, 17, 0, 0));
  });
});

describe('cronToHuman', () => {
  it('prebakes common patterns', () => {
    expect(cronToHuman('* * * * *')).toBe('Every minute');
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronToHuman('0 * * * *')).toBe('Every hour');
  });

  it('formats time-of-day', () => {
    expect(cronToHuman('0 9 * * *')).toContain('At 09:00');
  });

  it('mentions weekdays', () => {
    const s = cronToHuman('0 9 * * 1-5');
    expect(s).toContain('At 09:00');
    expect(s).toContain('Mon');
    expect(s).toContain('Fri');
  });

  it('falls back to expr on parse error', () => {
    expect(cronToHuman('not a cron')).toBe('not a cron');
  });
});
