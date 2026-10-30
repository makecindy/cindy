import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import en from '../../i18n/locales/en/common.json';
import zhCN from '../../i18n/locales/zh-CN/common.json';
import zhTW from '../../i18n/locales/zh-TW/common.json';
import ja from '../../i18n/locales/ja/common.json';
import ko from '../../i18n/locales/ko/common.json';
import { formatCompactionDuration, formatSessionDuration, formatShellDuration } from '../sessionDurationFormat';

function translator(catalog: Record<string, unknown>): TFunction {
  return ((key: string, values: Record<string, string | number>) => {
    const template = key.split('.').reduce<unknown>((node, part) =>
      (node as Record<string, unknown>)[part], catalog);
    if (typeof template !== 'string') throw new Error(`Missing translation: ${key}`);
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]));
  }) as TFunction;
}

describe('Desktop task durations', () => {
  it.each([
    [en, '21h 31m', '2d 3h 4m', '1h 0m', '1d 0h 0m'],
    [zhCN, '21 小时 31 分', '2 天 3 小时 4 分', '1 小时 0 分', '1 天 0 小时 0 分'],
    [zhTW, '21 小時 31 分', '2 天 3 小時 4 分', '1 小時 0 分', '1 天 0 小時 0 分'],
    [ja, '21時間31分', '2日3時間4分', '1時間0分', '1日0時間0分'],
    [ko, '21시간 31분', '2일 3시간 4분', '1시간 0분', '1일 0시간 0분'],
  ] as const)('localizes promoted units with real catalog %#', (catalog, hours, days, hour, day) => {
    const t = translator(catalog);
    expect(formatSessionDuration(77_516_000, t)).toBe(hours);
    expect(formatSessionDuration(183_845_000, t)).toBe(days);
    expect(formatSessionDuration(3_599_600, t)).toBe(hour);
    expect(formatSessionDuration(86_399_600, t)).toBe(day);
  });

  it('uses localized units in work summaries and preserves live padding', () => {
    const t = translator(zhCN);
    expect(t('chat.workGroup.worked', { duration: formatSessionDuration(183_845_000, t) }))
      .toBe('已工作 2 天 3 小时 4 分');
    const options = { minimumSeconds: 0, alwaysShowRemainder: true, padRemainder: true };
    expect(formatSessionDuration(0, t, options)).toBe('0s');
    expect(formatSessionDuration(65_000, t, options)).toBe('1m 05s');
    expect(formatSessionDuration(7_509_000, t, options)).toBe('2 小时 05 分');
    expect(formatSessionDuration(86_400_000, t, options)).toBe('1 天 00 小时 00 分');
  });

  it('keeps exact shell milliseconds below an hour', () => {
    const t = translator(en);
    expect(formatShellDuration(1500, t)).toBe('1500ms');
    expect(formatShellDuration(59_999, t)).toBe('59999ms');
    expect(formatShellDuration(3_599_999, t)).toBe('3599999ms');
    expect(formatShellDuration(3_600_000, t)).toBe('1h 0m');
    expect(formatShellDuration(86_400_000, translator(zhCN))).toBe('1 天 0 小时 0 分');
  });

  it('keeps fractional compaction seconds below an hour', () => {
    const t = translator(en);
    expect(formatCompactionDuration(1500, t)).toBe('1.5s');
    expect(formatCompactionDuration(75_500, t)).toBe('75.5s');
    expect(formatCompactionDuration(3_599_900, t)).toBe('3599.9s');
    expect(formatCompactionDuration(3_600_000, t)).toBe('1h 0m');
  });
});
