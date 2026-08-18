/** Localized schedule labels for the template gallery. */

import { cronToHuman as cronToHumanEN } from '@cindy/maker-scheduler/cron';
import { cronToConfig } from './cronCodexPreset';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function cronToHuman(expr: string, t: Translate, locale: string): string {
  const config = cronToConfig(expr);
  const time = `${pad(config.hour)}:${pad(config.minute)}`;

  switch (config.mode) {
    case 'daily':
      return t('scheduler.builtinTemplates.schedule.daily', { time });
    case 'weekdays':
      return t('scheduler.builtinTemplates.schedule.weekdays', { time });
    case 'weekly':
      return t('scheduler.builtinTemplates.schedule.weekly', {
        time,
        weekday: formatWeekday(config.weekday, locale),
      });
    case 'monthly':
      return t('scheduler.builtinTemplates.schedule.monthly', { time, day: config.monthDay });
    default:
      return cronToHumanEN(expr);
  }
}

function formatWeekday(weekday: number, locale: string): string {
  const sunday = new Date(Date.UTC(2024, 0, 7 + weekday));
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(sunday);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
