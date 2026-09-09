export type PresentationInterpolationValue = string | number | boolean | null | undefined;

export type PresentationTranslator = (
  key: string,
  fallback: string,
  values?: Readonly<Record<string, PresentationInterpolationValue>>,
) => string;

export interface PresentationLocalizer {
  translate: PresentationTranslator;
  formatDate?: (date: Date) => string;
  formatTime?: (date: Date) => string;
}

export function presentationText(
  localizer: PresentationLocalizer | undefined,
  key: string,
  fallback: string,
  values?: Readonly<Record<string, PresentationInterpolationValue>>,
): string {
  return localizer?.translate(key, fallback, values) ?? fallback;
}

export function presentationDate(
  localizer: PresentationLocalizer | undefined,
  date: Date,
): string {
  return localizer?.formatDate?.(date) ?? date.toLocaleDateString();
}

export function presentationTime(
  localizer: PresentationLocalizer | undefined,
  date: Date,
): string {
  return localizer?.formatTime?.(date) ?? date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
