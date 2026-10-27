import { describe, expect, it } from 'vitest';

import { cronToHuman } from '../cronToHuman';

import i18next from 'i18next';
import zhCN from '@/i18n/locales/zh-CN/common.json';
const i18n = i18next.createInstance();
void i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } }, initAsync: false });
const zh = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));

describe('cronToHuman', () => {
  it('localizes the built-in template schedule shapes', () => {
    expect(cronToHuman('0 2 * * *', zh, 'zh-CN')).toBe('每天 02:00');
    expect(cronToHuman('0 10 * * 1-5', zh, 'zh-CN')).toBe('工作日 10:00');
    expect(cronToHuman('0 16 * * 5', zh, 'zh-CN')).toBe('周五 16:00');
    expect(cronToHuman('0 10 1 * *', zh, 'zh-CN')).toBe('每月 1 日 10:00');
  });

  it('localizes month-restricted schedules', () => {
    expect(cronToHuman('0 9 * 1 *', zh, 'zh-CN')).toBe('1月 · 09:00');
  });
  // Regression: hourly lists fell back to English and elided the actual hours.
  // Production formatter; prior tests only covered daily templates. Unit tier.
  it.each([
    ['5 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 * * *', '每小时第 05 分'],
    ['19 0,6,12,23 * * *', '00:19, 06:19, 12:19, 23:19'],
    ['*/20 9-17 * * 1-5', '周一, 周二, 周三, 周四, 周五 · 9–17 时的第 0, 20, 40 分'],
    ['0 9 1 * 1', '每月 1 日或每周 周一 · 09:00'],
  ])('retains every time and the engine day-OR semantics: %s', (cron, expected) => {
    expect(cronToHuman(cron, zh, 'zh-CN')).toBe(expected);
  });
});
