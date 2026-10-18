import { describe, expect, it } from 'vitest';
import { normalizeHourlyTokenUsage } from '../hourlyTokenUsage';

describe('hourly usage input', () => {
  it('distinguishes an older source from a supported source without records', () => {
    expect(normalizeHourlyTokenUsage(undefined)).toBeUndefined();
    expect(normalizeHourlyTokenUsage({})).toBeUndefined();
    expect(normalizeHourlyTokenUsage([])).toEqual([]);
  });

  it('rejects invalid wire values and drops unrelated fields', () => {
    const row = { day: '2026-10-16', hour: 8, tokens: 120 };
    expect(
      normalizeHourlyTokenUsage([
        { ...row, title: 'unrelated' },
        null,
        false,
        { ...row, hour: -1 },
        { ...row, hour: 24 },
        { ...row, hour: 1.5 },
        { ...row, tokens: Infinity },
        { ...row, tokens: -1 },
        { ...row, tokens: 0 },
        { ...row, tokens: '120' },
        { ...row, day: 'invalid' },
      ]),
    ).toEqual([row]);
  });
});
