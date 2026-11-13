/** Localized, lossless schedule labels. Parsing uses the same rules as execution. */
import { parseCron } from '@cindy/maker-scheduler/cron';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function cronToHuman(expr: string, t: Translate, locale: string): string {
  let cron: ReturnType<typeof parseCron>;
  try {
    cron = parseCron(expr);
  } catch {
    return expr;
  }
  const label = (key: string, values?: Record<string, unknown>) =>
    t(`scheduler.builtinTemplates.schedule.${key}`, values);
  const { minute, hour, dayOfMonth, month, dayOfWeek } = cron;
  let time: string;
  if (hour.length === 24) {
    time = minute.length === 60
      ? label('everyMinute')
      : label('hourlyAt', { minutes: minute.map(pad).join(', ') });
  } else if (minute.length === 1) {
    time = label('atTimes', { times: hour.map((h) => `${pad(h)}:${pad(minute[0])}`).join(', ') });
  } else {
    time = label('atHoursMinutes', { hours: numbers(hour), minutes: numbers(minute) });
  }
  const weekday = dayOfWeek.map((day) => formatWeekday(day, locale)).join(', ');
  const dates = label('monthDays', { days: numbers(dayOfMonth) });
  const days = cron.domRestricted && cron.dowRestricted
    ? label('daysOrWeekdays', { days: dates, weekdays: weekday })
    : cron.domRestricted ? dates : cron.dowRestricted ? weekday : '';
  // Keep familiar compact labels for common templates.
  if (hour.length === 1 && minute.length === 1 && month.length === 12) {
    const clock = `${pad(hour[0])}:${pad(minute[0])}`;
    if (!cron.domRestricted && !cron.dowRestricted) return label('daily', { time: clock });
    if (!cron.domRestricted && dayOfWeek.join(',') === '1,2,3,4,5') return label('weekdays', { time: clock });
    if (!cron.domRestricted && dayOfWeek.length === 1) return label('weekly', { time: clock, weekday });
    if (!cron.dowRestricted && dayOfMonth.length === 1) return label('monthly', { time: clock, day: dayOfMonth[0] });
  }
  const months = month.length === 12 ? '' : label('inMonths', {
    months: month.map((m) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2024, m - 1, 1)))).join(', '),
  });
  return [months, days, time].filter(Boolean).join(' · ');
}

/** Compress only consecutive values, never elide a scheduled hour or minute. */
function numbers(values: readonly number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = values[i];
    while (i + 1 < values.length && values[i + 1] === values[i] + 1) i++;
    ranges.push(start === values[i] ? String(start) : `${start}–${values[i]}`);
  }
  return ranges.join(', ');
}

function formatWeekday(weekday: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2024, 0, 7 + weekday)));
}

function pad(value: number): string { return String(value).padStart(2, '0'); }
