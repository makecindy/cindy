// DateTimeFormat construction is expensive on large history lists. Retain only
// the current locale; never cache formatted dates (relative dates keep advancing).
let locale: string | undefined;
let dateFormatter: Intl.DateTimeFormat | undefined;
let timeFormatter: Intl.DateTimeFormat | undefined;
const dateTimeFormatters = new Map<boolean, Intl.DateTimeFormat>();

export function clearPresentationDateFormatters(): void {
  locale = undefined;
  dateFormatter = undefined;
  timeFormatter = undefined;
  dateTimeFormatters.clear();
}

function selectLocale(next: string): void {
  if (locale === next) return;
  clearPresentationDateFormatters();
  locale = next;
}

export function formatPresentationDate(date: Date, language: string): string {
  selectLocale(language);
  dateFormatter ??= new Intl.DateTimeFormat(language);
  return dateFormatter.format(date);
}

export function formatPresentationTime(date: Date, language: string): string {
  selectLocale(language);
  timeFormatter ??= new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' });
  return timeFormatter.format(date);
}

/** A call has its own timestamp in the card header, including today's date. */
export function formatShortDateTime(timestamp: number, language: string): string {
  selectLocale(language);
  const includeYear = new Date(timestamp).getFullYear() !== new Date().getFullYear();
  let formatter = dateTimeFormatters.get(includeYear);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, {
      ...(includeYear && { year: 'numeric' }), month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    dateTimeFormatters.set(includeYear, formatter);
  }
  return formatter.format(timestamp);
}
