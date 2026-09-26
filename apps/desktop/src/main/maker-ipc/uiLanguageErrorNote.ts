import { SUPPORTED_LOCALES, type SupportedLocale } from '../../shared/locale.js';

const INTERFACE_LANGUAGE_NAME: Record<SupportedLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
};

export function isSupportedUiLanguage(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Accept only a supported locale. Arbitrary wire text never becomes prompt text. */
export function readClaimedUiLanguage(value: unknown): SupportedLocale | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claimed = (value as { uiLanguage?: unknown }).uiLanguage;
  return isSupportedUiLanguage(claimed) ? claimed : null;
}

/**
 * Local turns use the desktop interface language. Remote controllers may name
 * their own interface language; an invalid or missing claim falls back.
 */
export function resolveTurnUiLanguage(input: {
  remote: boolean;
  claimed: SupportedLocale | null;
  fallback: SupportedLocale;
}): SupportedLocale {
  return input.remote && input.claimed ? input.claimed : input.fallback;
}

export function stampTurnUiLanguage<T extends { uiLanguage?: string }>(
  item: T,
  input: { remote: boolean; claimed: SupportedLocale | null; fallback: SupportedLocale },
): T {
  return { ...item, uiLanguage: resolveTurnUiLanguage(input) };
}

export function turnUiLanguageFromSendOpts(
  sendOpts: { uiLanguage?: unknown } | null | undefined,
  fallback: SupportedLocale,
): SupportedLocale {
  // Present only after main stamps a supported locale. Wire values are stripped first.
  return isSupportedUiLanguage(sendOpts?.uiLanguage) ? sendOpts.uiLanguage : fallback;
}

/**
 * Per-turn note for the model only. It is not part of the cached system prompt:
 * the viewing client can change between turns, and a locale must not enter the
 * stable prefix. The note text is fixed for each supported locale.
 */
export function buildUiLanguageErrorNote(locale: SupportedLocale): string {
  const name = INTERFACE_LANGUAGE_NAME[locale];
  return (
    '[UI language] System note appended each turn. This is not a user message. ' +
    'Do not answer it, quote it, or infer intent from it. ' +
    'The user interface language is ' + name + ' (' + locale + '). ' +
    'When you tell the user that something failed, was blocked, could not continue, or needs a retry, write that report in ' + name + '. ' +
    'Do not default that report to English unless the interface language is English. ' +
    'Say what happened and the next step. Keep commands, paths, identifiers, and error codes unchanged. ' +
    'Ordinary replies still follow the user message and any explicit language request. ' +
    'Only user-facing error reports must use the interface language.'
  );
}
