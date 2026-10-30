import { describe, expect, it, vi } from 'vitest';

import en from '../i18n/locales/en/message.json';
import zhCN from '../i18n/locales/zh-CN/message.json';
import zhTW from '../i18n/locales/zh-TW/message.json';
import ja from '../i18n/locales/ja/message.json';
import ko from '../i18n/locales/ko/message.json';
import { formatLocalizedDuration, formatLocalizedSeconds } from '../session/sessionDurationFormat';
import { formatMobileSystemCard } from '../session/systemCard';

// Exercise the real catalogs without loading native system-locale detection.
const state = vi.hoisted(() => ({ catalog: {} as Record<string, unknown> }));
vi.mock('@/i18n', () => ({
  i18n: {
    t(key: string, values: Record<string, number>) {
      const template = key.replace(/^message\./, '').split('.').reduce<unknown>((node, part) =>
        (node as Record<string, unknown>)[part], state.catalog);
      if (typeof template !== 'string') throw new Error(`Missing duration translation: ${key}`);
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]));
    },
  },
}));

describe('localized task durations', () => {
  it.each([
    [en, '21h 31m', '2d 3h 4m', '1h 0m', '1d 0h 0m'],
    [zhCN, '21 小时 31 分', '2 天 3 小时 4 分', '1 小时 0 分', '1 天 0 小时 0 分'],
    [zhTW, '21 小時 31 分', '2 天 3 小時 4 分', '1 小時 0 分', '1 天 0 小時 0 分'],
    [ja, '21時間31分', '2日3時間4分', '1時間0分', '1日0時間0分'],
    [ko, '21시간 31분', '2일 3시간 4분', '1시간 0분', '1일 0시간 0분'],
  ] as const)('converts long durations using the catalog %#', (catalog, hours, days, hour, day) => {
    state.catalog = catalog;
    expect(formatLocalizedDuration(77_516_000)).toBe(hours);
    expect(formatLocalizedDuration(183_845_000)).toBe(days);
    expect(formatLocalizedDuration(3_599_600)).toBe(hour);
    expect(formatLocalizedDuration(86_399_600)).toBe(day);
  });

  it('preserves short-duration rounding and live zero values', () => {
    state.catalog = en;
    expect(formatLocalizedDuration(400)).toBe('1s');
    expect(formatLocalizedDuration(59_499)).toBe('59s');
    expect(formatLocalizedDuration(59_500)).toBe('1m');
    expect(formatLocalizedDuration(65_000)).toBe('1m 5s');
    expect(formatLocalizedDuration(120_000)).toBe('2m');
    expect(formatLocalizedDuration(3_599_000)).toBe('59m 59s');
    expect(formatLocalizedDuration(86_399_000)).toBe('23h 59m');
    expect(formatLocalizedDuration(86_700_000)).toBe('1d 0h 5m');
    expect(formatLocalizedSeconds(0)).toBe('0s');
    expect(formatLocalizedSeconds(60, { alwaysShowSeconds: true })).toBe('1m 0s');
    expect(formatLocalizedSeconds(3_600, { alwaysShowSeconds: true })).toBe('1h 0m');
    expect(formatLocalizedSeconds(86_400, { alwaysShowSeconds: true })).toBe('1d 0h 0m');
  });

  it('keeps compaction tenths of a second below an hour in the actual system card', () => {
    state.catalog = en;
    expect(formatMobileSystemCard('compact', { durationMs: 1500 }).title).toBe('Auto compact · 1.5s');
    expect(formatMobileSystemCard('compact', { durationMs: 75_500 }).title).toBe('Auto compact · 75.5s');
    expect(formatMobileSystemCard('compact', { durationMs: 3_599_900 }).title).toBe('Auto compact · 3599.9s');
    expect(formatMobileSystemCard('compact', { durationMs: 3_600_000 }).title).toBe('Auto compact · 1h 0m');
  });
});
