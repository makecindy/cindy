import { describe, expect, it } from 'vitest';

import { cronToHuman } from '../cronToHuman';

const zh = (key: string, options: Record<string, unknown> = {}): string => {
  const messages: Record<string, string> = {
    'scheduler.builtinTemplates.schedule.daily': `每天 ${options.time}`,
    'scheduler.builtinTemplates.schedule.weekdays': `工作日 ${options.time}`,
    'scheduler.builtinTemplates.schedule.weekly': `${options.weekday} ${options.time}`,
    'scheduler.builtinTemplates.schedule.monthly': `每月 ${options.day} 日 ${options.time}`,
  };
  return messages[key] ?? key;
};

describe('cronToHuman', () => {
  it('localizes the built-in template schedule shapes', () => {
    expect(cronToHuman('0 2 * * *', zh, 'zh-CN')).toBe('每天 02:00');
    expect(cronToHuman('0 10 * * 1-5', zh, 'zh-CN')).toBe('工作日 10:00');
    expect(cronToHuman('0 16 * * 5', zh, 'zh-CN')).toBe('周五 16:00');
    expect(cronToHuman('0 10 1 * *', zh, 'zh-CN')).toBe('每月 1 日 10:00');
  });

  it('keeps unsupported custom cron output readable', () => {
    expect(cronToHuman('0 9 * 1 *', zh, 'zh-CN')).toBe('At 09:00 in Jan');
  });
});
