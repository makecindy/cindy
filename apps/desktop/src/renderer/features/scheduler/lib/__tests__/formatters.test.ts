import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { formatNextRun } from '../formatters';

const zhTranslate = ((key: string, options?: Record<string, unknown>) => {
  const count = Number(options?.count ?? 0);
  if (key.endsWith('intervalMinutes')) return `${count}分钟`;
  if (key.endsWith('intervalHours')) return `${count}小时`;
  if (key.endsWith('intervalDays')) return `${count}天`;
  if (key.endsWith('.next')) return `下次 ${options?.when}（${options?.interval}后）`;
  return String(options?.defaultValue ?? key);
}) as TFunction;

describe('scheduler formatters', () => {
  it('localizes the next-run interval before interpolating it into the sentence', () => {
    const now = new Date(2026, 0, 1, 9, 0).getTime();

    expect(formatNextRun(now + 30 * 60_000, now, zhTranslate)).toContain('（30分钟后）');
    expect(formatNextRun(now + 3 * 60 * 60_000, now, zhTranslate)).toContain('（3小时后）');
    expect(formatNextRun(now + 2 * 24 * 60 * 60_000, now, zhTranslate)).toContain('（2天后）');
  });
});
