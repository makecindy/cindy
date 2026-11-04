import { modernLocaleOf, resolveSystemLocale } from './locale';

/** Translation targets are independent of the app's UI locale catalogue. */
export const SCREENSHOT_TRANSLATION_LANGUAGES = [
  'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it',
  'pt-PT', 'pt-BR', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'ms', 'tr', 'nl', 'pl', 'uk',
  'sv', 'da', 'fi', 'nb', 'el', 'he', 'cs', 'ro', 'hu',
] as const;

export type ScreenshotTranslationLanguage = (typeof SCREENSHOT_TRANSLATION_LANGUAGES)[number];
export type ScreenshotTranslationPreference = ScreenshotTranslationLanguage | 'ui';

export function isScreenshotTranslationLanguage(value: unknown): value is ScreenshotTranslationLanguage {
  return typeof value === 'string' && (SCREENSHOT_TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

export function isScreenshotTranslationPreference(value: unknown): value is ScreenshotTranslationPreference {
  return value === 'ui' || isScreenshotTranslationLanguage(value);
}

export function resolveScreenshotTranslationLanguage(preference: unknown, uiLocale: string): ScreenshotTranslationLanguage {
  if (isScreenshotTranslationLanguage(preference)) return preference;
  const locale = modernLocaleOf(resolveSystemLocale(uiLocale));
  return isScreenshotTranslationLanguage(locale) ? locale : 'en';
}

export function screenshotTranslationLanguageName(language: ScreenshotTranslationLanguage, locale: string): string {
  // Script names distinguish Simplified / Traditional, rather than naming countries.
  const tag = language === 'zh-CN' ? 'zh-Hans' : language === 'zh-TW' ? 'zh-Hant' : language;
  return new Intl.DisplayNames([modernLocaleOf(resolveSystemLocale(locale))], { type: 'language' }).of(tag) ?? tag;
}
