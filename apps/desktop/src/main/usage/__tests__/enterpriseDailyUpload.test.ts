import { expect, it } from 'vitest';
import { dailyUploadSlot, latestUploadableDay } from '../enterpriseDailyUpload';

it('retains the same upload time across restarts and staggers installations', () => {
  const slot = dailyUploadSlot('installation-one');
  expect(slot).toBe(dailyUploadSlot('installation-one'));
  expect(slot).toBeGreaterThanOrEqual(0);
  expect(slot).toBeLessThan(86_400_000);
  expect(slot).not.toBe(dailyUploadSlot('installation-two'));
});

it('makes the previous UTC day eligible at the daily slot and catches up after downtime', () => {
  const slot = 2 * 3_600_000;
  expect(latestUploadableDay(Date.parse('2026-11-18T01:59:59Z'), slot)).toBe('2026-11-16');
  expect(latestUploadableDay(Date.parse('2026-11-18T02:00:00Z'), slot)).toBe('2026-11-17');
  expect(latestUploadableDay(Date.parse('2026-11-22T08:00:00Z'), slot)).toBe('2026-11-21');
});
