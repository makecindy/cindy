import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type LocalePreference, type SupportedLocale } from '../../shared/locale';

const LOCALE_STORAGE_KEY = 'language';
let unpersistedPreference: LocalePreference | undefined;

export function writeStoredLocale(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, preference);
    unpersistedPreference = undefined;
  } catch {
    // A blocked storage write must not change this window's effective language.
    unpersistedPreference = preference;
  }
}

export function readStoredLocale(): LocalePreference {
  if (unpersistedPreference !== undefined) return unpersistedPreference;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'system' || (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw))) {
      return raw as LocalePreference;
    }
  } catch {
    // Storage may be unavailable in sandboxed windows.
  }
  return 'system';
}

export function effectiveOf(pref: LocalePreference): SupportedLocale {
  if (pref !== 'system') return pref;
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const locale = window.electronAPI?.preferredSystemLocale;
  return typeof locale === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ? (locale as SupportedLocale)
    : DEFAULT_LOCALE;
}

/** Read before providers mount, without React, i18next initialization or IPC. */
export function getEffectiveLocale(): SupportedLocale {
  return effectiveOf(readStoredLocale());
}
