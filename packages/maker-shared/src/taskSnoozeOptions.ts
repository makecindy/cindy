export type TaskSnoozeOption = {
  id: 'oneHour' | 'threeHours' | 'thisEvening' | 'tomorrow' | 'nextWeek';
  until: Date;
  hours?: number;
};

/** Calendar presets use local wall time, including across DST and month/year boundaries. */
export function taskSnoozeOptions(now: Date): TaskSnoozeOption[] {
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  // Monday means the following Monday, never this morning.
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  return [
    { id: 'oneHour', hours: 1, until: new Date(now.getTime() + 3_600_000) },
    { id: 'threeHours', hours: 3, until: new Date(now.getTime() + 3 * 3_600_000) },
    ...(evening > now ? [{ id: 'thisEvening' as const, until: evening }] : []),
    { id: 'tomorrow', until: tomorrow },
    { id: 'nextWeek', until: nextWeek },
  ];
}

export function formatTaskSnoozeTime(option: TaskSnoozeOption, now: Date, locale: string): string {
  const crossesDay =
    option.hours !== undefined && option.until.toDateString() !== now.toDateString();
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(option.id === 'nextWeek' || crossesDay ? { weekday: 'short' as const } : {}),
  }).format(option.until);
}

export function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Keep the host's one-year limit, and reject nonexistent local times during DST transitions. */
export function parseTaskSnoozeTime(value: string, nowMs: number): Date | null {
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) &&
    ms > nowMs &&
    ms <= nowMs + 366 * 86_400_000 &&
    toLocalDateTimeValue(date) === value
    ? date
    : null;
}
