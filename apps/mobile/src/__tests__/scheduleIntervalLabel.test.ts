import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { formatScheduleInterval } from '@/scheduler/scheduleIntervalLabel';
import { buildMobileScheduleInput, createMobileScheduleDraft } from '@/scheduler/scheduleFormModel';
import en from '@/i18n/locales/en/devices.json';
import zhCN from '@/i18n/locales/zh-CN/devices.json';
import zhTW from '@/i18n/locales/zh-TW/devices.json';
import ja from '@/i18n/locales/ja/devices.json';
import ko from '@/i18n/locales/ko/devices.json';

describe('preserved schedule interval labels', () => {
  it.each([
    [61_000, '1 minute 1 second'],
    [450_000, '7 minutes 30 seconds'],
    [28 * 60_000, '28 minutes'],
    [59 * 60_000, '59 minutes'],
    [59_000, '59 seconds'],
    [61_001, '1 minute 1 second 1 millisecond'],
    [1, '1 millisecond'],
  ])('formats %i ms without a repeating minute fraction', (ms, expected) => {
    expect(formatScheduleInterval(ms, 'en')).toBe(expected);
  });

  it.each([
    ['en', en, '1 minute 1 second'],
    ['zh-CN', zhCN, '1分钟 1秒钟'],
    ['zh-TW', zhTW, '1 分鐘 1 秒'],
    ['ja', ja, '1 分 1 秒'],
    ['ko', ko, '1분 1초'],
  ] as const)('interpolates a localized duration in %s', async (locale, resources, expected) => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, resources: { [locale]: { translation: resources } } });
    const duration = formatScheduleInterval(61_000, locale);
    expect(duration).toBe(expected);
    const hint = i18n.t('automations.form.intervalPreservedHint', { duration });
    expect(hint).toContain(expected);
    expect(hint).not.toContain('{{');
    expect(hint).not.toContain('1.016666');
  });

  it('does not change the stored interval when formatting an untouched draft', () => {
    const draft = {
      ...createMobileScheduleDraft(null), name: 'Legacy', prompt: 'run',
      intervalMinutes: '', sourceIntervalMs: 61_001, intervalMinutesTouched: false,
    };
    formatScheduleInterval(draft.sourceIntervalMs, 'en');
    expect(buildMobileScheduleInput(draft).intervalMs).toBe(61_001);
  });
});
