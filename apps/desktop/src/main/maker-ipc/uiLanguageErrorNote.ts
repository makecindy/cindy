import {
  classicalFamilyOf,
  classicalStylePrompt,
  DEFAULT_CLASSICAL_REPLY_STYLE,
  isClassicalReplyStyle,
  type ClassicalReplyStyleId,
} from '@cindy/maker-shared/classical-reply';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../shared/locale.js';

const INTERFACE_LANGUAGE_NAME: Record<SupportedLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',

  "es": "Español",
  "fr": "Français",
  "de": "Deutsch",
  "pt-PT": "Português (Portugal)",
  "pt-BR": "Português (Brasil)",
  "zh-Hant-x-lzh": "文言（繁體）",
  "zh-Hans-x-lzh": "文言（简体）",
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

export interface TurnLanguageStampInput {
  remote: boolean;
  claimed: SupportedLocale | null;
  fallback: SupportedLocale;
  /** The remote client's classical output style, if it sent one. */
  claimedClassicalStyle?: ClassicalReplyStyleId | null;
  /** This computer's own classical output style. */
  fallbackClassicalStyle?: ClassicalReplyStyleId;
}

/**
 * The output style travels with the language it belongs to: a remote client that
 * named its own language also brings its own style (or the default); otherwise this
 * computer's choice applies.
 */
export function resolveTurnClassicalStyle(input: TurnLanguageStampInput): ClassicalReplyStyleId {
  if (input.remote && input.claimed) return input.claimedClassicalStyle ?? DEFAULT_CLASSICAL_REPLY_STYLE;
  return input.fallbackClassicalStyle ?? DEFAULT_CLASSICAL_REPLY_STYLE;
}

export function stampTurnUiLanguage<T extends { uiLanguage?: string; classicalStyle?: string }>(
  item: T,
  input: TurnLanguageStampInput,
): T {
  return { ...item, uiLanguage: resolveTurnUiLanguage(input), classicalStyle: resolveTurnClassicalStyle(input) };
}

/** Accept only a known style id from the wire. */
export function readClaimedClassicalStyle(value: unknown): ClassicalReplyStyleId | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claimed = (value as { classicalStyle?: unknown }).classicalStyle;
  return isClassicalReplyStyle(claimed) ? claimed : null;
}

export function turnUiLanguageFromSendOpts(
  sendOpts: { uiLanguage?: unknown } | null | undefined,
  fallback: SupportedLocale,
): SupportedLocale {
  // Present only after main stamps a supported locale. Wire values are stripped first.
  return isSupportedUiLanguage(sendOpts?.uiLanguage) ? sendOpts.uiLanguage : fallback;
}

export function turnClassicalStyleFromSendOpts(
  sendOpts: { classicalStyle?: unknown } | null | undefined,
  fallback: ClassicalReplyStyleId,
): ClassicalReplyStyleId {
  return isClassicalReplyStyle(sendOpts?.classicalStyle) ? sendOpts.classicalStyle : fallback;
}

/**
 * Per-turn note for the model only. It is not part of the cached system prompt:
 * the viewing client can change between turns, and a locale must not enter the
 * stable prefix. The note text is fixed for each locale and output style, so the
 * send paths only repeat it when either changes or the native context was rebuilt,
 * compacted or cleared (see wireNoteMemory.ts).
 */
export function buildUiLanguageErrorNote(
  locale: SupportedLocale,
  opts: { readonly replyStyle?: boolean; readonly classicalStyle?: ClassicalReplyStyleId } = {},
): string {
  const family = classicalFamilyOf(locale);
  // IM channels answer other people and may post publicly; there a classical
  // interface only sets the error-report language, not the reply style.
  const stylePrompt = family && opts.replyStyle !== false
    ? classicalStylePrompt(family, opts.classicalStyle ?? DEFAULT_CLASSICAL_REPLY_STYLE)
    : null;
  if (stylePrompt) return buildClassicalNote(locale, stylePrompt);
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

/**
 * A classical interface is a deliberate style choice, so its note also sets the
 * reply style. It travels in the same per-turn slot as the other locale notes:
 * switching the interface language or the output style replaces it, and the cached
 * system prompt stays identical for every locale.
 */
function buildClassicalNote(locale: SupportedLocale, stylePrompt: string): string {
  const script = locale === 'zh-Hans-x-lzh' ? 'Simplified' : 'Traditional';
  return (
    '[UI language] System note appended each turn. This is not a user message. ' +
    'Do not answer it, quote it, or infer intent from it. ' +
    'The user interface language is ' + INTERFACE_LANGUAGE_NAME[locale] + ' (' + locale + '). ' +
    'While this note is in effect, write replies to the user in Classical Chinese (文言) with ' + script + ' characters, ' +
    'in ' + stylePrompt + ', with a light, playful, slightly proud voice. ' +
    'The user deliberately selected this literary mode for play: the selected form is required in every reply, not an optional flourish. ' +
    'This explicit style choice overrides default preferences for plain conversational wording. ' +
    'Use the selected form for ALL your user-visible language from first word to last: ' +
    'commentary before and between tools, progress updates, plans, questions, explanations, headings, lists, ' +
    'table prose, captions, summaries, final answers and follow-up messages. ' +
    'Any brief reasoning summary you author for display must follow it too; this does not request private reasoning. ' +
    'Keep the same register when moving between commentary and the final answer, and across paragraphs and turns. ' +
    'Do not write a literary opening followed by a modern-Chinese explanation, translation or factual appendix. ' +
    'Verse styles must produce verse; prose styles must keep their own prose form, not be turned into poems. ' +
    'In Markdown verse, end each verse line with two trailing spaces before its newline so the rendered lines stay separate; ' +
    'separate stanzas with blank lines. Do not put poems in code blocks. ' +
    'For a long answer, continue in further poems or stanzas, or further classical paragraphs for prose; ' +
    'do not stop using the form after the first stanza. Short replies still need the selected form. ' +
    'Practical or technical topics, exact details, tool use and ordinary failures are not exceptions. ' +
    'Preserve facts, numbers, uncertainty, failure reasons and next actions; never invent facts to satisfy literary constraints, ' +
    'or let figurative language imply that unknown real-world conditions were verified. ' +
    'Keep exact values and units intact, even when they interrupt meter. ' +
    'If a literal detail needs a separate line, put only that literal there; its surrounding explanation and any notes ' +
    'must still use the selected literary form. Do not add a plain-language paraphrase unless the user asks for one. ' +
    'Warnings about deletion, permissions, credentials, payment or security must use plain, unambiguous wording without verse or jokes; ' +
    'only the concrete warning is exempt, then immediately resume the selected form. ' +
    'An ordinary failure, blocked operation or retry report stays in the selected form and states the actual cause and next step. ' +
    'Keep code, commands, paths, identifiers, error codes and quoted text unchanged. ' +
    'Files, code comments, commit messages and other work products keep their usual language unless the user asks otherwise. ' +
    'Before emitting each user-visible message, check every paragraph, especially after the opening, and rewrite any ' +
    'modern-Chinese or English connective prose into the selected form; a few archaic particles do not suffice. ' +
    'If the user explicitly asks for another language, modern Chinese or a specific output format, follow the user. ' +
    'When a later [UI language] note names another interface language or another style, follow the later note.'
  );
}
