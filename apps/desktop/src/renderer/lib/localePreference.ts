import {
  isClassicalReplyStyle,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';
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

const CLASSICAL_STYLE_STORAGE_KEY = 'classicalReplyStyle';

/**
 * Output style of AI replies, or null when the user never chose one for this computer
 * (the interface language then decides; see defaultClassicalReplyStyleFor).
 */
export function readStoredClassicalStyle(): ClassicalReplyStyleId | null {
  try {
    const raw = localStorage.getItem(CLASSICAL_STYLE_STORAGE_KEY);
    if (isClassicalReplyStyle(raw)) return raw;
  } catch {
    // Storage may be unavailable in sandboxed windows.
  }
  return null;
}

export function writeStoredClassicalStyle(style: ClassicalReplyStyleId): void {
  try {
    localStorage.setItem(CLASSICAL_STYLE_STORAGE_KEY, style);
  } catch {
    // A blocked write keeps the in-memory choice for this window.
  }
}
