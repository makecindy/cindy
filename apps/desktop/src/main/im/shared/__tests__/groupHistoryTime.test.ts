import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatImHistoryDateTime,
  formatImHistoryTime,
  formatImHistoryTimeNote,
} from '../groupWindowCore';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IM 群历史时间格式', () => {
  it('与当前同年、同偏移的消息只写 MM-DD HH:mm', () => {
    const now = new Date(2026, 9, 13, 20, 0).getTime();
    expect(formatImHistoryTime(new Date(2026, 9, 11, 13, 52).getTime(), now)).toBe('10-11 13:52');
  });

  it('跨年的消息前补年份', () => {
    const now = new Date(2027, 0, 2, 9, 0).getTime();
    expect(formatImHistoryTime(new Date(2026, 11, 30, 23, 10).getTime(), now)).toMatch(
      /^2026-12-30 23:10( \(UTC[+-]\d{2}:\d{2}\))?$/,
    );
  });

  it('跨夏令时切换(偏移与当前不同)的消息后补该消息自己的偏移', () => {
    const now = new Date(2026, 11, 1, 12, 0).getTime();
    const summer = new Date(2026, 6, 1, 12, 0).getTime();
    // 模拟纽约: 夏季 UTC-04:00, 冬季 UTC-05:00(与运行机器的真实时区无关)。
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) {
      return this.getTime() === summer ? 240 : 300;
    });
    expect(formatImHistoryTime(summer, now)).toBe('07-01 12:00 (UTC-04:00)');
    expect(formatImHistoryTimeNote(now)).toContain('本机时区 UTC-05:00');
  });

  it('检索结果的完整时间总带年份与该消息自己的偏移', () => {
    expect(formatImHistoryDateTime(new Date(2026, 9, 11, 13, 52).getTime())).toMatch(
      /^2026-10-11 13:52 \(UTC[+-]\d{2}:\d{2}\)$/,
    );
  });
});
