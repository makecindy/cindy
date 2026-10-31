/**
 * Classical reply styles: while a classical UI edition is shown (文言 for the Chinese
 * editions today; Japanese 古文 / Korean 한문 editions can add their own family later)
 * the AI answers in that register, shaped by the output style the user picked next to
 * the language.
 *
 * The choice belongs to the client the user is typing on, the same way the UI language
 * does: Desktop keeps it locally and Mobile sends it with each turn. Only a known style
 * id survives normalization, so wire values never become prompt text.
 */

/** Classical UI editions by literary family. */
export const CLASSICAL_FAMILY_BY_LOCALE = {
  'zh-Hant-x-lzh': 'lzh',
  'zh-Hans-x-lzh': 'lzh',
} as const;

export type ClassicalFamily = (typeof CLASSICAL_FAMILY_BY_LOCALE)[keyof typeof CLASSICAL_FAMILY_BY_LOCALE];

/**
 * Output styles a family offers, in menu order. The first one is the default; `plain`
 * keeps the classical interface but lets replies follow the user's own language.
 * `prompt` is what the model is told; adding a style is one entry here plus its label.
 */
export const CLASSICAL_REPLY_STYLES = {
  lzh: [
    { id: 'prose', prompt: 'elegant, readable classical prose (文言)' },
    { id: 'tang-poetry', prompt: 'the manner of Tang poetry (唐詩): weave in regulated verse or quatrains of five or seven characters' },
    { id: 'song-ci', prompt: 'the manner of Song lyrics (宋詞): weave in lines set to tune patterns, with lingering imagery' },
    { id: 'yuan-qu', prompt: 'the manner of Yuan sanqu songs (元曲): lively, colloquial-tinged verse lines' },
    { id: 'chu-ci', prompt: 'the manner of the Chu ci (楚辭): sweeping lines with 兮, rich in mythic imagery' },
    { id: 'parallel-prose', prompt: 'parallel prose (駢文): balanced four- and six-character couplets' },
    { id: 'pre-qin', prompt: 'terse pre-Qin masters prose (先秦諸子): aphoristic, argued by analogy' },
    { id: 'historian', prompt: 'the Grand Historian narrative style (史傳, 太史公筆法): measured narration closing with a brief verdict' },
    { id: 'ming-qing-essay', prompt: 'light Ming–Qing familiar essays (明清小品): relaxed, witty and intimate' },
    { id: 'plain', prompt: '' },
  ],
} as const satisfies Record<ClassicalFamily, readonly { id: string; prompt: string }[]>;

export type ClassicalReplyStyleId = (typeof CLASSICAL_REPLY_STYLES)[ClassicalFamily][number]['id'];

export const DEFAULT_CLASSICAL_REPLY_STYLE: ClassicalReplyStyleId = 'prose';

export function classicalFamilyOf(locale: string | null | undefined): ClassicalFamily | null {
  if (typeof locale !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CLASSICAL_FAMILY_BY_LOCALE, locale)
    ? CLASSICAL_FAMILY_BY_LOCALE[locale as keyof typeof CLASSICAL_FAMILY_BY_LOCALE]
    : null;
}

const ALL_STYLE_IDS: ReadonlySet<string> = new Set(
  Object.values(CLASSICAL_REPLY_STYLES).flatMap((styles) => styles.map((style) => style.id)),
);

export function isClassicalReplyStyle(value: unknown): value is ClassicalReplyStyleId {
  return typeof value === 'string' && ALL_STYLE_IDS.has(value);
}

/** The style's instruction within a family, or null when replies keep their usual language. */
export function classicalStylePrompt(family: ClassicalFamily, style: ClassicalReplyStyleId): string | null {
  const entry = CLASSICAL_REPLY_STYLES[family].find((candidate) => candidate.id === style)
    ?? CLASSICAL_REPLY_STYLES[family][0];
  return entry.prompt ? entry.prompt : null;
}
