import {
  classicalReplyStyleContextOf,
  isClassicalReplyStyle,
  type ClassicalReplyStyleContext,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isLocalePreference, LOCALE_STORAGE_KEY, type LocalePreference, type SupportedLocale } from '../../shared/locale';

export { LOCALE_STORAGE_KEY };
let unpersistedPreference: LocalePreference | undefined;

function mirrorLocale(preference: LocalePreference, storage?: Storage): boolean {
  try {
    (storage ?? localStorage).setItem(LOCALE_STORAGE_KEY, preference);
    unpersistedPreference = undefined;
    return true;
  } catch {
    unpersistedPreference = preference;
    return false;
  }
}

/** Before first paint, import a valid legacy choice or restore the saved profile choice. */
export function restoreStoredLocale(): Promise<void> | undefined {
  const restore = typeof window !== 'undefined' && window.electronAPI?.restoreDisplayLanguage;
  if (!restore) return;
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Storage may be blocked. */ }
  return restore(isLocalePreference(legacy) ? legacy : null).then(saved => {
    if (saved && saved !== legacy) mirrorLocale(saved);
  }, () => { /* Keep the legacy value if the host is unavailable. */ });
}

export function writeStoredLocale(
  preference: LocalePreference,
  storage?: Storage,
  onlyIfUnset = false,
): boolean | Promise<boolean> {
  const save = typeof window !== 'undefined' && window.electronAPI?.saveDisplayLanguage;
  if (!save) {
    const mirrored = mirrorLocale(preference, storage);
    if (!mirrored && onlyIfUnset) throw new Error('PERSISTENCE_NOT_CONFIRMED');
    return mirrored;
  }
  return save(preference, onlyIfUnset).then(saved => {
    if (saved) mirrorLocale(preference, storage);
    return saved;
  }, error => {
    if (onlyIfUnset) throw error;
    return false;
  });
}

export function readStoredLocale(): LocalePreference {
  if (unpersistedPreference !== undefined) return unpersistedPreference;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocalePreference(raw)) return raw;
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

const CLASSICAL_STYLE_STORAGE_KEYS = {
  classical: 'classicalReplyStyle',
  modern: 'classicalReplyStyle.modern',
} as const satisfies Record<ClassicalReplyStyleContext, string>;

/**
 * Stored reply style for one context (classical interface / modern Chinese interface),
 * or null when the user never chose one there; each context starts from
 * defaultClassicalReplyStyleFor. The classical key keeps its historical name so
 * existing installs keep their choice.
 */
export function readStoredClassicalStyle(
  context: ClassicalReplyStyleContext,
): ClassicalReplyStyleId | null {
  try {
    const raw = localStorage.getItem(CLASSICAL_STYLE_STORAGE_KEYS[context]);
    if (isClassicalReplyStyle(raw)) return raw;
  } catch {
    // Storage may be unavailable in sandboxed windows.
  }
  return null;
}

export function writeStoredClassicalStyle(
  context: ClassicalReplyStyleContext,
  style: ClassicalReplyStyleId,
): void {
  try {
    localStorage.setItem(CLASSICAL_STYLE_STORAGE_KEYS[context], style);
  } catch {
    // A blocked write keeps the in-memory choice for this window.
  }
}
