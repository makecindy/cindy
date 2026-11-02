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
 * `prompt` defines the form of the whole answer; the shared per-turn note enforces
 * that choice for every style. Adding a style is one entry here plus its label.
 */
export const CLASSICAL_REPLY_STYLES = {
  lzh: [
    { id: 'prose', prompt: 'elegant, readable classical prose (文言): use concise literary syntax and natural classical diction throughout, not modern Chinese with a few archaic particles; keep it prose, without forced verse' },
    { id: 'tang-poetry', prompt: 'the manner of Tang poetry (唐詩): begin directly with a complete four-line quatrain or eight-line regulated poem; choose five or seven Chinese characters per line and keep that count throughout the poem, with line breaks and rhyme; answer the actual question in the poem, even for a short reply' },
    { id: 'song-ci', prompt: 'the manner of Song lyrics (宋詞): compose the answer itself as a complete ci stanza following a recognizable tune pattern, with varied line lengths and lingering imagery' },
    { id: 'yuan-qu', prompt: 'the manner of Yuan sanqu songs (元曲): form a complete short song with varied line lengths, rhyme, lively colloquial turns and a witty closing line; use flexible song rhythm rather than uniform Tang-poem lines' },
    { id: 'chu-ci', prompt: 'the manner of the Chu ci (楚辭): sustain sweeping, rhythmically linked lines with natural 兮 cadences, expressive repetition and rich figurative imagery throughout, rather than adding a lone 兮 to ordinary prose' },
    { id: 'parallel-prose', prompt: 'parallel prose (駢文): build the answer from paired clauses with matching syntax and balanced meaning, favoring four- and six-character rhythms; carry the explanation through those pairs, without forcing a quatrain' },
    { id: 'pre-qin', prompt: 'terse pre-Qin masters prose (先秦諸子): state a clear proposition, develop it through a compact analogy or question and answer, and close with an aphoristic inference; use concise classical prose, not verse' },
    { id: 'historian', prompt: 'the Grand Historian narrative style (史傳, 太史公筆法): narrate the known situation and its causes or sequence in measured classical prose, then close with a brief appraisal such as 論曰; do not invent events or attribute your words to a historical source' },
    { id: 'ming-qing-essay', prompt: 'light Ming–Qing familiar essays (明清小品): write an intimate miniature essay, moving naturally from the present topic or a small observation to a witty, personal reflection; keep relaxed classical prose and an evocative ending, not a poem or a formal historical verdict' },
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
