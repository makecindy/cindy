// DateTimeFormat construction is expensive on large history lists. Retain only
// the current locale; never cache formatted dates (relative dates keep advancing).
let locale: string | undefined;
let dateFormatter: Intl.DateTimeFormat | undefined;
let timeFormatter: Intl.DateTimeFormat | undefined;

export function clearPresentationDateFormatters(): void {
  locale = undefined;
  dateFormatter = undefined;
  timeFormatter = undefined;
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
