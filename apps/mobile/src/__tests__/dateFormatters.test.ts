import { afterEach, expect, it, vi } from 'vitest';
import { clearPresentationDateFormatters, formatPresentationDate, formatPresentationTime } from '@/i18n/dateFormatters';

afterEach(() => { vi.restoreAllMocks(); clearPresentationDateFormatters(); });

it('reuses date/time formatters across large histories without caching their output', () => {
  const NativeFormatter = Intl.DateTimeFormat;
  const dates = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, i)));
  const date = new NativeFormatter('zh-CN');
  const time = new NativeFormatter('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const constructor = vi.spyOn(Intl, 'DateTimeFormat');
  for (const value of dates) {
    expect(formatPresentationDate(value, 'zh-CN')).toBe(date.format(value));
    expect(formatPresentationTime(value, 'zh-CN')).toBe(time.format(value));
  }
  expect(constructor).toHaveBeenCalledTimes(2);
  expect(formatPresentationDate(dates[0], 'en')).toBe(new NativeFormatter('en').format(dates[0]));
  expect(constructor).toHaveBeenCalledTimes(3);
  clearPresentationDateFormatters(); // foreground return after a timezone change
  formatPresentationDate(dates[0], 'en');
  expect(constructor).toHaveBeenCalledTimes(4);
});
