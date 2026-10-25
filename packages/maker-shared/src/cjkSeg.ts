/**
 * CJK 字间插空格 —— messages_fts 的写入侧与查询侧共用规格。
 *
 * 覆盖范围只收 Unicode Han 字（`\p{Script=Han}`）。假名、谚文、全角折叠、
 * 标点都不处理；英文 / 数字 / 空白原样保留。改这个函数 = 必须配新的重建
 * migration，否则新旧行的索引形态会分裂，一致性判据会误报。
 *
 * 写入侧：连续汉字中间插空格，并在汉字与相邻 Latin/数字之间也插空格，
 * 让 FTS5 unicode61 把每个汉字当成独立 token，且不与英文粘成一个 token。
 * combining mark（`\\p{M}`）附着在前一个汉字上，不阻断分词。
 * 查询侧：同一规则把 CJK run 收成 phrase（`"边 界"`），要求相邻且有序。
 *
 * 已知限制：汉字被标点隔开时（如「边，界」）unicode61 会产出相邻 token，
 * 查询 phrase `"边 界"` 仍可能命中。这是按字索引的固有噪声（微信 VerbatimTokenizer
 * 同款），不是 bug；收窄覆盖范围不会消除它。
 */

export const CJK_SEG_SQL_FN = 'cjk_seg';

const HAN_CHAR_RE = /\p{Script=Han}/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const MARK_RE = /\p{M}/u;

function isHanCodePoint(ch: string): boolean {
  return HAN_CHAR_RE.test(ch);
}

function isLetterOrNumber(ch: string): boolean {
  return LETTER_OR_NUMBER_RE.test(ch);
}

function isMark(ch: string): boolean {
  return MARK_RE.test(ch);
}

export function cjkSeg(input: unknown): string | null {
  if (input == null) return null;
  const text = typeof input === 'string' ? input : String(input);
  if (text.length === 0) return text;
  const chars = [...text];
  let out = '';
  let lastBoundary = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (isMark(ch)) {
      out += ch;
      continue;
    }
    if (lastBoundary) {
      const hanNow = isHanCodePoint(ch);
      const hanPrev = isHanCodePoint(lastBoundary);
      if (
        (hanNow && hanPrev) ||
        (hanNow && isLetterOrNumber(lastBoundary)) ||
        (hanPrev && isLetterOrNumber(ch))
      ) {
        out += ' ';
      }
    }
    out += ch;
    lastBoundary = ch;
  }
  return out;
}

/**
 * cjkSeg 的逐字符映射版：输出与 cjkSeg 完全一致，同时给出与原文的逐字符对齐
 * 表（segChars[k] ↔ 原文码点下标 segToOrig[k]；插入空格处为 -1）。
 *
 * buildSnippetFromContent 用它在原文对齐的索引串里定位查询 token 的分词形态、
 * 再映回原文坐标打高亮；不能用「比对空格字符」做对齐，否则插入空格撞上原文
 * 真实空格时会错位。
 */
export function cjkSegAligned(
  input: unknown,
): { segChars: string[]; segToOrig: Int32Array } | null {
  if (input == null || typeof input !== 'string') return null;
  if (input.length === 0) return { segChars: [], segToOrig: new Int32Array(0) };
  const chars = [...input];
  const segChars: string[] = [];
  const segToOrig: number[] = [];
  let lastBoundary = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (isMark(ch)) {
      segChars.push(ch);
      segToOrig.push(i);
      continue;
    }
    if (lastBoundary) {
      const hanNow = isHanCodePoint(ch);
      const hanPrev = isHanCodePoint(lastBoundary);
      if (
        (hanNow && hanPrev) ||
        (hanNow && isLetterOrNumber(lastBoundary)) ||
        (hanPrev && isLetterOrNumber(ch))
      ) {
        segChars.push(' ');
        segToOrig.push(-1);
      }
    }
    segChars.push(ch);
    segToOrig.push(i);
    lastBoundary = ch;
  }
  return { segChars, segToOrig: Int32Array.from(segToOrig) };
}

/** 在码点数组上找 needle，返回码点下标；不用 String.indexOf（那是 UTF-16 单元下标）。 */
function indexOfCodePoints(haystack: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0 || from > haystack.length - needle.length) return -1;
  for (let i = from; i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

export function isHanChar(ch: string): boolean {
  return HAN_CHAR_RE.test(ch);
}

const SNIPPET_CONTEXT_CHARS = 24;
/** snippet 窗口硬上限（码点数，含上下文）。跨命中不再拉整条超长消息。 */
const SNIPPET_MAX_CHARS = SNIPPET_CONTEXT_CHARS * 2 + 32;
/**
 * 重建 snippet 时扫描 / 经 worker 传回的最大字符数。超长消息只看前缀，
 * 命中落在此前缀之后时退回文首 fallback，召回本身不受影响。
 * SQLite 对 TEXT 的 substr() 按 UTF-8 字符计，和 JS 码点扫描对齐。
 */
export const SNIPPET_SOURCE_MAX_CHARS = 16_384;

/**
 * 从原文 content 上重建搜索 snippet：在「与原文逐字符对齐的分词形态」里定位
 * 查询 token 的分词形态，把命中区间映回原文坐标，打 `<mark>` 并按上下文截窗。
 *
 * 为什么不能用 SQLite snippet()：它返回的是 messages_fts.content——被 cjk_seg
 * 插过空格的索引形态，直接展示会篡改原文（「foo登录bar」多出假空格、「登录 报错」
 * 的真空格被折叠吞掉）。也为什么不用 offsets()：那是 FTS3/4 函数，FTS5 没有。
 * 写入侧 cjkSeg 只插空格不删改字符，因此拿查询 token 在 cjkSegAligned 的索引串里
 * 定位即可精确还原命中位置，且 snippet 里每个空格都来自用户原文。
 *
 * 恒返回非空 string（找不到命中时退化为纯文本前窗），满足 SessionSearchHit.snippet:
 * string 契约。`<mark>` 是本函数添加的哨兵；原文里的 `<` / `>` / `&` 先转成实体，
 * 消费端按实体还原，避免用户内容里的真 `<mark>` 被当成控制标记。
 */
export function buildSnippetFromContent(content: unknown, queryTokens: readonly string[]): string {
  const raw = typeof content === 'string' ? content : content == null ? '' : String(content);
  if (!raw) return '';
  const text = takeCodePoints(raw, SNIPPET_SOURCE_MAX_CHARS);

  const aligned = cjkSegAligned(text);
  if (!aligned || aligned.segChars.length === 0) return fallbackSnippet(text);
  const { segChars, segToOrig } = aligned;
  const foldedSeg = segChars.map((ch) => ch.toLowerCase());

  // 把每个查询 token 的分词形态在码点数组里定位成 [segStart, segEnd) 区间，
  // 再经 segToOrig 映回原文码点区间（跳过 -1 的插入空格位）。
  // 查找全程用码点下标，不能用 String.indexOf / .length（那是 UTF-16 单元）。
  const spans: Array<{ start: number; end: number }> = [];
  for (const token of queryTokens) {
    const needle = cjkSeg(token);
    if (!needle || needle.length === 0) continue;
    const needleChars = [...needle];
    const foldedNeedle = needleChars.map((ch) => ch.toLowerCase());
    let from = 0;
    for (;;) {
      const at = indexOfCodePoints(foldedSeg, foldedNeedle, from);
      if (at < 0) break;
      from = at + needleChars.length;
      const first = segToOrig[at]!;
      const last = segToOrig[at + needleChars.length - 1]!;
      if (first < 0 || last < 0) continue;
      const start = Math.min(first, last);
      const end = Math.max(first, last) + 1;
      spans.push({ start, end });
    }
  }

  const origChars = [...text];
  if (spans.length === 0) return fallbackSnippet(text);

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.start <= prev.end) prev.end = Math.max(prev.end, span.end);
    else merged.push({ ...span });
  }

  // 取最紧凑的一段命中簇，窗口硬上限，避免「首命中到末命中」把整条超长消息拉回来。
  const cluster = pickCompactSnippetCluster(merged, SNIPPET_MAX_CHARS);
  const hitStart = cluster[0]!.start;
  const hitEnd = cluster[cluster.length - 1]!.end;
  let winStart = Math.max(0, hitStart - SNIPPET_CONTEXT_CHARS);
  let winEnd = Math.min(origChars.length, hitEnd + SNIPPET_CONTEXT_CHARS);
  if (winEnd - winStart > SNIPPET_MAX_CHARS) {
    winEnd = Math.min(origChars.length, winStart + SNIPPET_MAX_CHARS);
    if (winEnd < hitEnd) {
      winEnd = Math.min(origChars.length, hitEnd);
      winStart = Math.max(0, winEnd - SNIPPET_MAX_CHARS);
    }
  }

  let out = '';
  if (winStart > 0) out += '…';
  let cursor = winStart;
  for (const span of cluster) {
    const s = Math.max(span.start, winStart);
    const e = Math.min(span.end, winEnd);
    if (e <= cursor) continue;
    out += escapeSnippetText(origChars.slice(cursor, s).join(''));
    out += `<mark>${escapeSnippetText(origChars.slice(s, e).join(''))}</mark>`;
    cursor = e;
  }
  out += escapeSnippetText(origChars.slice(cursor, winEnd).join(''));
  if (winEnd < origChars.length) out += '…';
  return out;

  function fallbackSnippet(t: string): string {
    const chars = [...t];
    if (chars.length <= SNIPPET_CONTEXT_CHARS * 2) return escapeSnippetText(t);
    return `${escapeSnippetText(chars.slice(0, SNIPPET_CONTEXT_CHARS).join(''))}…`;
  }
}

/**
 * snippet 走 `<mark>` 哨兵协议。原文里的 `<` / `>` 必须先转成实体，
 * 否则用户内容里的真 `<mark>` / `</mark>` 会被消费端当成控制标记，
 * 把原文改写成高亮片段。`&` 也一并转义，避免二次解析把实体还原错。
 */
function escapeSnippetText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function takeCodePoints(text: string, max: number): string {
  const chars: string[] = [];
  for (const ch of text) {
    if (chars.length >= max) return chars.join('');
    chars.push(ch);
  }
  return text;
}

function pickCompactSnippetCluster(
  merged: Array<{ start: number; end: number }>,
  maxChars: number,
): Array<{ start: number; end: number }> {
  if (merged.length <= 1) return merged;
  let bestStart = 0;
  let bestEnd = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  let j = 0;
  for (let i = 0; i < merged.length; i += 1) {
    while (j + 1 < merged.length && merged[j + 1]!.end - merged[i]!.start <= maxChars) {
      j += 1;
    }
    const span = merged[j]!.end - merged[i]!.start;
    const count = j - i;
    const bestCount = bestEnd - bestStart;
    if (count > bestCount || (count === bestCount && span < bestSpan)) {
      bestStart = i;
      bestEnd = j;
      bestSpan = span;
    }
  }
  return merged.slice(bestStart, bestEnd + 1);
}
