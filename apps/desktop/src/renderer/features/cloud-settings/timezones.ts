/** IANA identifiers stay on the wire. Offsets are display-only and follow DST. */
export const COMMON_TIMEZONES: Record<string, string> = {
  UTC: 'utc',
  'Asia/Shanghai': 'shanghai',
  'Asia/Hong_Kong': 'hongKong',
  'Asia/Taipei': 'taipei',
  'Asia/Tokyo': 'tokyo',
  'Asia/Seoul': 'seoul',
  'Asia/Singapore': 'singapore',
  'Asia/Kolkata': 'kolkata',
  'Asia/Dubai': 'dubai',
  'Europe/London': 'london',
  'Europe/Paris': 'paris',
  'Europe/Berlin': 'berlin',
  'America/New_York': 'newYork',
  'America/Los_Angeles': 'losAngeles',
  'Australia/Sydney': 'sydney',
};

export function timezoneOffset(zone: string, now = new Date()): string {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value;
    return value?.replace('GMT', 'UTC') ?? zone;
  } catch {
    // Keep an existing server value visible instead of silently changing policy.
    return '';
  }
}

/** The offset as people write it, by today's rules: UTC+8, UTC+5:30, UTC−4, UTC. */
export function shortOffset(zone: string, now = new Date()): string {
  const match = /^UTC([+-])(\d\d):(\d\d)$/.exec(timezoneOffset(zone, now));
  if (!match) return timezoneOffset(zone, now);
  const minutes = match[3] === '00' ? '' : `:${match[3]}`;
  return `UTC${match[1] === '-' ? '−' : '+'}${Number(match[2])}${minutes}`;
}
