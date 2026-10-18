/** Aggregate consumption by the recording device's local calendar and hour. */
export interface HourlyTokenUsageRow {
  day: string;
  hour: number;
  tokens: number;
}

/** Old peers omit hourly rows; an empty array means supported with no records. */
export function normalizeHourlyTokenUsage(value: unknown): HourlyTokenUsageRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const { day, hour, tokens } = row as Partial<HourlyTokenUsageRow>;
    return typeof day === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      typeof hour === 'number' &&
      Number.isInteger(hour) &&
      hour >= 0 &&
      hour < 24 &&
      typeof tokens === 'number' &&
      Number.isSafeInteger(tokens) &&
      tokens > 0
      ? [{ day, hour, tokens }]
      : [];
  });
}
