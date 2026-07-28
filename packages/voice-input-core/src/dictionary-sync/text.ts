/**
 * 词条文本归一化与主键。
 *
 * 与 desktop `apps/desktop/src/shared/voiceInputData.ts` 的
 * `normalizeVoiceInputDictionaryEntryText` / `dictionaryTextKey` 行为逐字一致 ——
 * 同步合并的主键必须和本地学习路径的查找键是同一个键,否则同一个词在两条路径
 * 下会被认成两个词。desktop 侧在同步接线时改为复用本模块,消除漂移可能。
 *
 * 主键取小写归一化文本(而不是词条 id):id 是各设备本地生成的,两台设备各自学
 * 到同一个词会得到不同 id,拿 id 当同步主键会让同一个词永远合并不到一起。
 */

/** 单条词条文本上限,与 desktop MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS 一致。 */
export const MAX_DICTIONARY_TERM_CHARS = 120;

export function normalizeDictionaryTermText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_DICTIONARY_TERM_CHARS)
    .trim();
}

/**
 * 合并主键。空字符串表示该文本不可用作词条。
 *
 * **必须用 locale 无关的 `toLowerCase()`**,不能用 `toLocaleLowerCase()`:后者跟随
 * 设备系统语言,土耳其语 locale 下 `I` 折叠成 `ı`(无点)而英语 locale 折叠成 `i`。
 * 这个值是 CRDT 记录键和物化 id —— 同一个词在两台不同语言设置的电脑上会落到两条
 * 互不相干的记录,永远收敛不了。跨设备一致性优先于个别语言的大小写直觉。
 */
export function dictionaryTermKey(text: unknown): string {
  return normalizeDictionaryTermText(text).toLowerCase();
}
