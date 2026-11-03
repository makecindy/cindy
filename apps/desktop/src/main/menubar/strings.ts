import type { SupportedLocale } from '../../shared/locale.js';
import type { MenubarStrings } from '../../shared/menubarQuota.js';
import type { MenubarTranslate } from './snapshot.js';

/** Raw template lookup with locale fallback; null when no locale has the key. */
export type MenubarRawLookup = (key: string) => string | null;

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Fills `{{name}}` placeholders; unknown placeholders stay visible so gaps are easy to spot. */
export function fillTemplate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Translator over the `menubar.*` namespace. A numeric `count` selects the CLDR plural
 * variant (`_one`, `_other`, ...) the locale provides, falling back to `_other` and then
 * the bare key.
 */
export function createMenubarTranslate(locale: SupportedLocale, raw: MenubarRawLookup): MenubarTranslate {
  const plurals = new Intl.PluralRules(locale);
  return (key, vars) => {
    const full = `menubar.${key}`;
    let template: string | null = null;
    const count = vars?.count;
    if (typeof count === 'number') {
      template = raw(`${full}_${plurals.select(count)}`) ?? raw(`${full}_other`);
    }
    template ??= raw(full) ?? raw(`${full}_other`) ?? full;
    return fillTemplate(template, vars);
  };
}

/**
 * Templates the helper fills itself. Plural families are sent as `key_one` / `key_other`
 * so Swift can pick by count without plural rules of its own. Locales without a "one"
 * category (Chinese, Japanese, Korean) send `other` for both, so a fallback-locale `_one`
 * never leaks in.
 */
export function buildMenubarUiStrings(
  keys: readonly string[],
  raw: MenubarRawLookup,
  locale: SupportedLocale,
): MenubarStrings {
  const hasOne = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.includes('one');
  const strings: MenubarStrings = {};
  const families = new Set<string>();
  for (const key of keys) {
    const match = key.match(PLURAL_SUFFIX);
    if (match) {
      families.add(key.slice(0, -match[0].length));
      continue;
    }
    const value = raw(`menubar.ui.${key}`);
    if (value !== null) strings[key] = value;
  }
  for (const family of families) {
    const other = raw(`menubar.ui.${family}_other`);
    const one = (hasOne ? raw(`menubar.ui.${family}_one`) : null) ?? other;
    if (other !== null) {
      strings[`${family}_other`] = other;
      strings[family] = other;
    }
    if (one !== null) strings[`${family}_one`] = one;
  }
  return strings;
}
