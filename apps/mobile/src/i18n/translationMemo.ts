import { i18n } from '@/i18n';

// Plural and interpolated labels cost tens of microseconds each in i18next on Android,
// and the task list rebuilds hundreds of them on every task update. A label depends only
// on the language, key and values, so keep it until the language or resources change.
const MAX_LABELS = 2000;
const labels = new Map<string, string>();
let watching = false;

function clearLabels(): void {
  labels.clear();
}

export function memoizedTranslation(key: string, options?: Readonly<Record<string, unknown>>): string {
  if (!watching) {
    watching = true;
    i18n.on?.('languageChanged', clearLabels);
    i18n.store?.on?.('added', clearLabels);
    i18n.store?.on?.('removed', clearLabels);
  }
  const cacheKey = `${i18n.language}\u0000${key}\u0000${options ? JSON.stringify(options) : ''}`;
  const previous = labels.get(cacheKey);
  if (previous !== undefined) return previous;
  const label = i18n.t(key, options as Record<string, unknown>);
  if (labels.size >= MAX_LABELS) labels.clear();
  labels.set(cacheKey, label);
  return label;
}
