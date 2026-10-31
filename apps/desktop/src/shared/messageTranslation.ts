import type { SupportedLocale } from './locale';

/** Upper bound for one reply sent to the auxiliary model for translation. */
export const MESSAGE_TRANSLATION_MAX_CHARS = 40_000;

export interface MessageTranslationRequest {
  text: string;
  locale: SupportedLocale;
}

/** `unavailable` = no auxiliary model can run; `failed` = the attempt itself did not succeed. */
export type MessageTranslationResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'unavailable' | 'failed' | 'too_long' };

type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'cyrillic' | 'other';

const SCRIPT_PATTERNS: ReadonlyArray<[Script, RegExp]> = [
  ['kana', /[぀-ヿ]/u],
  ['hangul', /[가-힯ᄀ-ᇿ]/u],
  ['han', /\p{Script=Han}/u],
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['other', /\p{L}/u],
];

function scriptOf(char: string): Script | null {
  for (const [script, pattern] of SCRIPT_PATTERNS) if (pattern.test(char)) return script;
  return null;
}

/** Prose only: code, links and inline literals stay as written and must not decide the language. */
function proseOf(markdown: string): string {
  return markdown
    // A fence left open at the end of a reply still runs to the end of the text.
    .replace(/^[ \t>]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t>]*\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
}

type MarkerLanguage = 'en' | 'es' | 'fr' | 'de' | 'pt';

/**
 * Frequent function words per Latin-script language, picked so that each word
 * is not also a common word in the other listed languages (so no `a`, `in`,
 * `is`, `no`, `que`, `para`, `die`/`was` for English, `es` for German).
 */
const LANGUAGE_MARKERS: Readonly<Record<MarkerLanguage, ReadonlySet<string>>> = {
  en: new Set([
    'the', 'and', 'of', 'to', 'that', 'this', 'with', 'for', 'you', 'your', 'are', 'be', 'been',
    'it', 'its', 'not', 'have', 'has', 'will', 'can', 'from', 'by', 'would', 'should', 'there',
    'which', 'what', 'they', 'we', 'these', 'those', 'because', 'if', 'or', 'but', 'when', 'then',
  ]),
  es: new Set([
    'el', 'los', 'las', 'del', 'una', 'pero', 'muy', 'porque', 'hay', 'sus', 'al', 'lo', 'ya',
    'esto', 'cuando', 'donde', 'puede', 'tiene', 'también', 'y', 'es', 'su', 'con', 'están',
  ]),
  fr: new Set([
    'le', 'les', 'des', 'du', 'une', 'est', 'et', 'pas', 'pour', 'dans', 'avec', 'sur', 'ce',
    'cette', 'vous', 'nous', 'il', 'elle', 'sont', 'mais', 'qui', 'au', 'aux', 'être',
  ]),
  de: new Set([
    'der', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'den', 'dem',
    'sich', 'auch', 'sie', 'wird', 'werden', 'zu', 'von', 'oder', 'wenn', 'dass', 'kann', 'ich',
  ]),
  pt: new Set([
    'não', 'o', 'um', 'uma', 'os', 'do', 'da', 'dos', 'das', 'em', 'ao', 'mas', 'muito', 'você',
    'isso', 'quando', 'pode', 'tem', 'são', 'é', 'e', 'na', 'nas', 'pelo', 'também',
  ]),
};

/**
 * Whether the Latin words read as `language`: enough of its marker words, and
 * more of them than of any other listed language (Spanish and Portuguese, or
 * French and English, share vocabulary otherwise).
 */
function looksLike(language: MarkerLanguage, latinWords: readonly string[]): boolean {
  const lower = latinWords.map((word) => word.toLowerCase());
  const hitsOf = (lang: MarkerLanguage) => lower.filter((word) => LANGUAGE_MARKERS[lang].has(word)).length;
  const hits = hitsOf(language);
  if (hits < 2 || hits / latinWords.length < 0.15) return false;
  return (Object.keys(LANGUAGE_MARKERS) as MarkerLanguage[])
    .every((other) => other === language || hitsOf(other) < hits);
}

/**
 * Whether to offer a translate action for a reply. The entry is hidden only
 * when the reply is recognisably in the UI language; when that cannot be told
 * (a Latin-script reply that is not clearly English, Chinese characters
 * without kana in a Japanese UI, …) the manual entry stays available.
 */
export function needsTranslation(markdown: string, locale: SupportedLocale): boolean {
  const counts: Record<Script, number> = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0, other: 0 };
  const latinWords: string[] = [];
  let total = 0;
  // Latin is counted per word so a Chinese sentence is not outweighed by one English term.
  for (const token of proseOf(markdown).match(/\p{Script=Latin}+|\p{L}/gu) ?? []) {
    const script = scriptOf(token[0]!);
    if (!script) continue;
    if (script === 'latin') latinWords.push(token);
    counts[script] += 1;
    total += 1;
  }
  // Nothing worth translating ("OK", a lone emoji or a code-only reply).
  if (total < 3) return false;
  const share = (script: Script) => counts[script] / total;
  switch (locale) {
    case 'zh-CN':
    case 'zh-TW':
    case 'zh-Hant-x-lzh':
    case 'zh-Hans-x-lzh':
      // Han without kana is Chinese; either script variant stays readable.
      return !(counts.kana === 0 && share('han') >= 0.5);
    case 'ja':
      // Japanese prose always carries kana; Han alone is more likely Chinese.
      return !(counts.kana > 0 && share('kana') + share('han') >= 0.5);
    case 'ko':
      return !(share('hangul') >= 0.5);
    case 'en':
    case 'es':
    case 'fr':
    case 'de':
      return !(share('latin') >= 0.5 && looksLike(locale, latinWords));
    case 'pt-PT':
    case 'pt-BR':
      // Either Portuguese variant stays readable, like the two Chinese scripts.
      return !(share('latin') >= 0.5 && looksLike('pt', latinWords));
  }
}

export const MESSAGE_TRANSLATION_LANGUAGE_NAMES: Readonly<Record<SupportedLocale, string>> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  'pt-PT': 'European Portuguese',
  'pt-BR': 'Brazilian Portuguese',
  'zh-Hant-x-lzh': 'Classical Chinese in Traditional characters',
  'zh-Hans-x-lzh': 'Classical Chinese in Simplified characters',
};
