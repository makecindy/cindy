/**
 * Classical reply styles: the AI answers in a classical register (文言 for the Chinese
 * editions today; Japanese 古文 / Korean 한문 editions can add their own family later),
 * shaped by the output style the user picked next to the language.
 *
 * The classical editions always answer that way. The modern Chinese editions offer the
 * same styles as an optional register: the interface stays modern and only the replies
 * turn classical, so a user can ask for 文言 without reading a 文言 interface.
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
    { id: 'tang-poetry', prompt: 'the manner of Tang poetry (唐詩): compose the entire message in complete four-line quatrains or eight-line regulated poems; choose five or seven Chinese characters per line, with line breaks and rhyme, except where exact literal values must be preserved; carry the actual explanation and next steps in the poems themselves, even for a short reply' },
    { id: 'song-ci', prompt: 'the manner of Song lyrics (宋詞): compose the entire message as complete ci stanzas following a recognizable tune pattern, with varied line lengths and lingering imagery; continue in further stanzas when needed to carry the explanation' },
    { id: 'yuan-qu', prompt: 'the manner of Yuan sanqu songs (元曲): compose the entire message in complete short songs with varied line lengths, rhyme, lively colloquial turns and a witty closing line; continue in further songs when needed, using flexible song rhythm rather than uniform Tang-poem lines' },
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

/**
 * Interface editions whose replies may take a classical style. The classical editions
 * always offer it; the modern Chinese editions offer it optionally, keeping a modern
 * interface while replies follow the chosen register.
 */
export const REPLY_STYLE_FAMILY_BY_LOCALE = {
  ...CLASSICAL_FAMILY_BY_LOCALE,
  'zh-CN': 'lzh',
  'zh-TW': 'lzh',
} as const satisfies Partial<Record<string, ClassicalFamily>>;

export function classicalFamilyOf(locale: string | null | undefined): ClassicalFamily | null {
  if (typeof locale !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CLASSICAL_FAMILY_BY_LOCALE, locale)
    ? CLASSICAL_FAMILY_BY_LOCALE[locale as keyof typeof CLASSICAL_FAMILY_BY_LOCALE]
    : null;
}

/** The style family this interface edition may use, or null when it offers none. */
export function replyStyleFamilyOf(locale: string | null | undefined): ClassicalFamily | null {
  if (typeof locale !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(REPLY_STYLE_FAMILY_BY_LOCALE, locale)
    ? REPLY_STYLE_FAMILY_BY_LOCALE[locale as keyof typeof REPLY_STYLE_FAMILY_BY_LOCALE]
    : null;
}

/**
 * Style used while the user has not chosen one. A classical interface is itself the
 * choice, so it answers in that register; a modern interface stays ordinary until the
 * user asks for a literary style.
 */
export function defaultClassicalReplyStyleFor(locale: string | null | undefined): ClassicalReplyStyleId {
  return classicalFamilyOf(locale) ? DEFAULT_CLASSICAL_REPLY_STYLE : 'plain';
}

/**
 * The classical interface and the modern Chinese interfaces keep separate style
 * choices: picking 唐诗 for a classical interface does not turn a modern interface's
 * replies literary, and each context starts from defaultClassicalReplyStyleFor.
 */
export type ClassicalReplyStyleContext = 'classical' | 'modern';

export function classicalReplyStyleContextOf(
  locale: string | null | undefined,
): ClassicalReplyStyleContext {
  return classicalFamilyOf(locale) ? 'classical' : 'modern';
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
