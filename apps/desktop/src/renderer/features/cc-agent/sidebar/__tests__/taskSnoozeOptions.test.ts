import { describe, expect, it } from 'vitest';
import { parseTaskSnoozeTime, taskSnoozeOptions, toLocalDateTimeValue } from '../taskSnoozeOptions';

// Unit: the requested calendar presets must not turn into fixed 24-hour delays.
// Covers evening expiry, Monday/week/year rollover and custom input bounds at the production helper.
describe('task snooze calendar choices', () => {
  it('offers exact hourly delays and local evening, tomorrow and next Monday', () => {
    const now = new Date(2026, 10, 13, 1, 55, 17);
    const options = taskSnoozeOptions(now);
    expect(
      options
        .filter((option) => option.hours)
        .map((option) => option.until.getTime() - now.getTime()),
    ).toEqual([3_600_000, 10_800_000]);
    expect(
      options.filter((option) => !option.hours).map((option) => toLocalDateTimeValue(option.until)),
    ).toEqual(['2026-11-13T18:00', '2026-11-14T09:00', '2026-11-16T09:00']);
  });

  it('omits an elapsed evening and always chooses the following Monday', () => {
    const now = new Date(2026, 10, 16, 18);
    const options = taskSnoozeOptions(now);
    expect(options.some((option) => option.id === 'thisEvening')).toBe(false);
    expect(toLocalDateTimeValue(options.find((option) => option.id === 'nextWeek')!.until)).toBe(
      '2026-11-23T09:00',
    );
  });

  it('uses calendar days over DST and year boundaries', () => {
    for (const [now, expected] of [
      [new Date(2026, 2, 7, 23), '2026-03-08T09:00'],
      [new Date(2026, 9, 31, 23), '2026-11-01T09:00'],
      [new Date(2026, 11, 31, 23), '2027-01-01T09:00'],
    ] as const) {
      expect(
        toLocalDateTimeValue(
          taskSnoozeOptions(now).find((option) => option.id === 'tomorrow')!.until,
        ),
      ).toBe(expected);
    }
    const sunday = new Date(2026, 10, 15, 23);
    expect(
      toLocalDateTimeValue(
        taskSnoozeOptions(sunday).find((option) => option.id === 'nextWeek')!.until,
      ),
    ).toBe('2026-11-16T09:00');
  });

  it('accepts future local input and rejects invalid, past and beyond-one-year input', () => {
    const now = new Date(2026, 10, 13, 12).getTime();
    expect(parseTaskSnoozeTime('2026-11-14T09:30', now)?.getHours()).toBe(9);
    for (const value of ['', 'bad', '2026-02-30T09:00', '2026-11-13T12:00', '2028-01-01T09:00']) {
      expect(parseTaskSnoozeTime(value, now)).toBeNull();
    }
  });
});
