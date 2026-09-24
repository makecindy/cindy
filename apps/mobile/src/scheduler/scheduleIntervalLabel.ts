/** Display the stored interval without rounding it to whole minutes. */
export function formatScheduleInterval(intervalMs: number, locale: string): string {
  const parts: string[] = [];
  let remaining = intervalMs;
  for (const [unit, size] of [['minute', 60_000], ['second', 1_000], ['millisecond', 1]] as const) {
    const count = unit === 'millisecond' ? remaining : Math.floor(remaining / size);
    remaining %= size;
    if (count > 0) {
      parts.push(new Intl.NumberFormat(locale, {
        style: 'unit',
        unit,
        unitDisplay: 'long',
        maximumFractionDigits: 20,
      }).format(count));
    }
  }
  return parts.join(' ');
}
