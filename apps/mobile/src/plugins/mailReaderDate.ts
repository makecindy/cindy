const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/** Mail dates arrive as RFC 2822 text ("Wed, 21 Oct 2026 09:55:03 +1300"), which
 * Hermes does not reliably parse. Unknown formats return undefined so callers can
 * show the provider's original text instead of a wrong time. */
// RFC 5322 obsolete zone names, in hours from UTC. Military letters are ignored.
const NAMED_ZONES: Record<string, number> = { ut: 0, gmt: 0, utc: 0, z: 0, est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7 };

export function parseMailDate(text: string): Date | undefined {
  const match = /^\s*(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2})(\d{2})|([a-z]{1,3}))?\s*(?:\([^)]*\))?\s*$/i.exec(text);
  if (match) {
    const month = MONTHS.indexOf(match[2].toLowerCase());
    const named = match[10] ? NAMED_ZONES[match[10].toLowerCase()] : undefined;
    // An unknown zone name must not be read as UTC: fall through and show the original text.
    if (month >= 0 && !(match[10] && named === undefined)) {
      const offset = match[7] ? (match[7] === '-' ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9])) : (named ?? 0) * 60;
      const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) - offset * 60_000);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  const fallback = new Date(text);
  return text.trim() && !Number.isNaN(fallback.getTime()) ? fallback : undefined;
}

/** Mail-app style: time today, month and day this year, full date otherwise. */
export function formatMailDate(text: string, language: string, now = new Date()): string {
  const date = parseMailDate(text);
  if (!date) return text;
  const sameYear = date.getFullYear() === now.getFullYear();
  const today = sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  try {
    return new Intl.DateTimeFormat(language, today ? { hour: '2-digit', minute: '2-digit' }
      : { ...(sameYear ? {} : { year: 'numeric' as const }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  } catch { return text; }
}
