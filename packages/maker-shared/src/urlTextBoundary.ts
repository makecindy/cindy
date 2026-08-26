/**
 * 裸 http(s) URL 在聊天正文里的切边权威。
 *
 * Desktop 用户消息、Desktop GFM autolink 后处理、Mobile markdown 分词共用这一份，
 * 避免「URL 后面粘着（说明）」这类尾巴在一端被切掉、另一端点进 404。
 * 匹配可以按扫描器各自写；href 从哪一刀结束只问 `clipBareHttpAutolink`。
 */

// 尾部 ASCII 标点集合：GFM spec 会剥掉 ? ! . , : * _ ~，此处额外加了 ;
// 以便把 `https://x.com/foo; 然后` 这类散文分号也视为 URL 边界。

const PROSE_TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', ';']);
const MARKDOWN_FORMATTING_TRAILING_PUNCT = new Set(['*', '_', '~']);
export const MARKDOWN_WRAP_MARKERS = ['**', '__', '~~', '*', '_', '~'] as const;

/**
 * 找出裸 URL 中第一个应回退给 prose 的未配对括号位置。
 *
 * GFM autolink 会把 `https://x.com/1(base main)` 的 `base` 当成 URL path
 * 吃掉，因为空格才结束匹配；在聊天文本里 path 末尾这类未配对 `(` 基本
 * 都是 URL 后的说明。配对括号默认保留，兼容 Wikipedia 类 `/Foo_(bar)`；
 * 只有 code-host 数字资源路径（如 `/pull/283`）后的配对括号才按说明切掉。
 * Query / fragment 里的未配对括号默认不动，避免误伤 `?q=(foo` /
 * `?q=a)b` 这类真实 URL；只有 code-host 资源 URL 后明显是状态说明
 * 开头的截断前缀（如 `#discussion_r1(base`）才切回 prose。
 */
export function cutBeforeUnbalancedParenProse(
  raw: string,
  cut: number = raw.length,
  options: { wrappingParenCount?: number } = {},
): number {
  const scanCut = Math.min(Math.max(cut, 0), raw.length);
  const effectiveEnd = trimProseTrailingPunct(raw, scanCut);
  const queryOrHashIndex = raw.search(/[?#]/);
  const wrappingParenCount = options.wrappingParenCount ?? 0;
  const noteEnd = trimUnmatchedTrailingClosers(
    raw,
    trimMarkdownFormattingTrailingPunct(raw, effectiveEnd),
  );
  const openParenIndexes: number[] = [];
  const parenPairs: Array<{ open: number; close: number }> = [];
  for (let i = 0; i < effectiveEnd; i++) {
    const ch = raw[i];
    if (ch === '(') {
      openParenIndexes.push(i);
      continue;
    }
    if (ch !== ')') continue;
    const openIndex = openParenIndexes.pop();
    if (openIndex != null) {
      parenPairs.push({ open: openIndex, close: i });
      continue;
    }
    if (i >= noteEnd) {
      continue;
    }
    if (queryOrHashIndex >= 0 && i >= queryOrHashIndex) {
      if (
        wrappingParenCount > 0 &&
        countUnmatchedClosingParens(raw.slice(i + 1, effectiveEnd)) < wrappingParenCount
      ) {
        return i;
      }
      continue;
    }
    if (raw[i + 1] != null && !/\s/.test(raw[i + 1])) {
      return i;
    }
  }
  return (
    openParenIndexes.find((openIndex) => queryOrHashIndex < 0 || openIndex < queryOrHashIndex) ??
    openParenIndexes.find((openIndex) =>
      isCodeHostTruncatedStatusNote(raw, openIndex, noteEnd, queryOrHashIndex),
    ) ??
    parenPairs.find(
      ({ open, close }) =>
        isCodeHostParentheticalNote(raw, open, close, queryOrHashIndex) &&
        close === noteEnd - 1,
    )?.open ??
    raw.length
  );
}

function isCodeHostTruncatedStatusNote(
  raw: string,
  open: number,
  noteEnd: number,
  queryOrHashIndex: number,
): boolean {
  if (queryOrHashIndex < 0 || open < queryOrHashIndex) return false;
  if (!canTreatQueryOrHashParenAsStatusNote(raw, open, queryOrHashIndex)) return false;
  const notePrefix = raw.slice(open + 1, noteEnd);
  return (
    /^base(?: [A-Za-z0-9._/-]*)?$/i.test(notePrefix) &&
    isCodeHostNumericResourcePath(raw.slice(0, queryOrHashIndex))
  );
}

function isCodeHostParentheticalNote(
  raw: string,
  open: number,
  close: number,
  queryOrHashIndex: number,
): boolean {
  if (queryOrHashIndex < 0 || open < queryOrHashIndex) {
    return isCodeHostNumericResourcePath(raw.slice(0, open));
  }
  if (!canTreatQueryOrHashParenAsStatusNote(raw, open, queryOrHashIndex)) return false;
  const note = raw.slice(open + 1, close);
  return (
    isLikelyCodeHostStatusNote(note) &&
    isCodeHostNumericResourcePath(raw.slice(0, queryOrHashIndex))
  );
}

function canTreatQueryOrHashParenAsStatusNote(
  raw: string,
  open: number,
  queryOrHashIndex: number,
): boolean {
  const lastAmpersand = raw.lastIndexOf('&', open - 1);
  const segmentStart = Math.max(queryOrHashIndex + 1, lastAmpersand + 1);
  const currentSegment = raw.slice(segmentStart, open);
  if (!currentSegment.includes('=')) return true;
  return /^diff=split$/i.test(currentSegment);
}

function isLikelyCodeHostStatusNote(note: string): boolean {
  return /^base(?: [A-Za-z0-9._/-]+)*,[A-Z][A-Z0-9_-]*$/i.test(note);
}

export function isCodeHostNumericResourcePath(prefix: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(prefix);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname;
  if (host === 'github.com') {
    return /^\/[^/]+\/[^/]+\/(?:pulls?|issues?)\/\d+\/?$/i.test(pathname);
  }
  if (host === 'gitlab.com') {
    return /^\/.+\/(?:-\/)?(?:issues?|merge_requests?)\/\d+\/?$/i.test(pathname);
  }
  return false;
}

function trimProseTrailingPunct(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && PROSE_TRAILING_PUNCT.has(raw[end - 1])) {
    end--;
  }
  return end;
}

function trimMarkdownFormattingTrailingPunct(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && MARKDOWN_FORMATTING_TRAILING_PUNCT.has(raw[end - 1])) {
    end--;
  }
  return end;
}

function trimUnmatchedTrailingClosers(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && raw[end - 1] === ')') {
    const seg = raw.slice(0, end);
    const opens = (seg.match(/\(/g) ?? []).length;
    const closes = (seg.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    end--;
  }
  return end;
}

/**
 * Cut authority/path-level square/brace brackets that GFM autolink may treat
 * as URL text. Query and fragment are left alone because brackets are common
 * there after copy/paste from search URLs or app-specific links.
 */
export function cutBeforePathBracketProse(raw: string): number {
  const schemeIndex = raw.indexOf('://');
  const authorityStart = schemeIndex >= 0 ? schemeIndex + 3 : 0;
  const pathStart = raw.indexOf('/', authorityStart);
  const queryOrHashIndex = raw.search(/[?#]/);
  const pathScanEnd = queryOrHashIndex < 0 ? raw.length : queryOrHashIndex;
  for (let i = authorityStart; i < pathScanEnd; i++) {
    if (!'[]{}'.includes(raw[i])) continue;
    if (pathStart >= 0 && i >= pathStart) return i;
    if (canParseUrlPrefix(raw.slice(0, i))) return i;
  }
  const queryBracketCut = cutBeforeUnmatchedQueryBracket(raw, queryOrHashIndex, raw.length);
  if (queryBracketCut < raw.length) return queryBracketCut;
  return raw.length;
}

function canParseUrlPrefix(prefix: string): boolean {
  try {
    const parsed = new URL(prefix);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

function cutBeforeUnmatchedQueryBracket(
  raw: string,
  queryOrHashIndex: number,
  scanEnd: number,
): number {
  if (queryOrHashIndex < 0) return raw.length;
  const counts: Record<string, number> = { ']': 0, '}': 0 };
  const matchingClose: Record<string, ']' | '}'> = { '[': ']', '{': '}' };
  for (let i = queryOrHashIndex; i < scanEnd; i++) {
    const ch = raw[i];
    if (ch === '[' || ch === '{') {
      counts[matchingClose[ch]]++;
      continue;
    }
    if (ch !== ']' && ch !== '}') continue;
    if (counts[ch] <= 0) return i;
    counts[ch]--;
  }
  return raw.length;
}

export function cutBeforeClosingMarkdownWrap(raw: string, marker: string | null): number {
  if (!marker) return raw.length;
  let markerIndex = raw.indexOf(marker);
  while (markerIndex >= 0) {
    if (isMarkdownWrapCloseCandidate(raw, marker, markerIndex)) {
      return markerIndex;
    }
    markerIndex = raw.indexOf(marker, markerIndex + marker.length);
  }
  return raw.length;
}

export function isMarkdownWrapOpenBoundary(ch: string | undefined): boolean {
  return ch == null || !isAsciiAlnum(ch);
}

function isMarkdownWrapCloseCandidate(raw: string, marker: string, markerIndex: number): boolean {
  if (marker !== '_' && marker !== '__') return true;
  const before = raw[markerIndex - 1];
  const after = raw[markerIndex + marker.length];
  return !(isAsciiAlnum(before) && isAsciiAlnum(after));
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9]/.test(ch);
}

export function countUnmatchedOpeningParens(text: string | null): number {
  if (!text) return 0;
  let count = 0;
  for (const ch of text) {
    if (ch === '(') {
      count++;
      continue;
    }
    if (ch === ')' && count > 0) {
      count--;
    }
  }
  return count;
}

function countUnmatchedClosingParens(text: string): number {
  let openCount = 0;
  let closeCount = 0;
  for (const ch of text) {
    if (ch === '(') {
      openCount++;
      continue;
    }
    if (ch === ')') {
      if (openCount > 0) {
        openCount--;
      } else {
        closeCount++;
      }
    }
  }
  return closeCount;
}

/**
 * 从给定切点继续向左收缩，剥掉 autolink 末尾不该属于 URL 的字符。
 *
 * 保留配对括号，兼容 Wikipedia 类 URL `/Foo_(bar)`；剥掉悬空的 `(` 和
 * 未配对的 `)`，匹配 GFM 对裸 URL 边界的处理习惯。
 */
export function shrinkAutolinkTrailingJunk(
  url: string,
  cut: number = url.length,
  options: {
    stripMarkdownFormattingPunct?: boolean;
    stripWrappingApostrophe?: boolean;
    stripWrappingParenCount?: number;
  } = {},
): number {
  let end = Math.min(Math.max(cut, 0), url.length);
  const queryOrHashIndex = url.search(/[?#]/);
  let stripWrappingParenCount = Math.max(
    0,
    (options.stripWrappingParenCount ?? 0) - countUnmatchedClosingParens(url.slice(end)),
  );
  while (end > 0) {
    const ch = url[end - 1];
    const isInQueryOrFragment = queryOrHashIndex >= 0 && end - 1 >= queryOrHashIndex;
    if (
      PROSE_TRAILING_PUNCT.has(ch) ||
      (options.stripMarkdownFormattingPunct &&
        MARKDOWN_FORMATTING_TRAILING_PUNCT.has(ch)) ||
      (ch === '(' && !isInQueryOrFragment) ||
      (ch === "'" && options.stripWrappingApostrophe)
    ) {
      end--;
      continue;
    }
    if (ch === ')') {
      const seg = url.slice(0, end);
      const opens = (seg.match(/\(/g) ?? []).length;
      const closes = (seg.match(/\)/g) ?? []).length;
      if (closes > opens) {
        if (isInQueryOrFragment) {
          if (stripWrappingParenCount <= 0) break;
          stripWrappingParenCount--;
        }
        end--;
        continue;
      }
    }
    break;
  }
  return end;
}

/**
 * 扫描器用的裸 http(s) 源。任意 Unicode 空白 / 尖括号 / 引号 / 省略号 /
 * 真正的 CJK·全角标点处结束。全角字母、半角片假名、々 等字母
 * 留在地址里；U+3002 / U+FF0E / U+FF61 是 IDN 点号，留给 clip 按
 * authority 决定。半角括号留给 `clipBareHttpAutolink` 按配对处理。
 */
export const BARE_HTTP_URL_RE_SOURCE =
  String.raw`https?://[^\s<>"\u2013-\u2015\u2018-\u201F\u2022\u2026\u3000-\u3001\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30FB\uFE10-\uFE19\uFF01-\uFF0D\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF60\uFF62-\uFF65]+`;

const MARKDOWN_FORMATTING_STRIP_BOUNDARY =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;

function isAutolinkPunctuationBoundary(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code == null) return false;
  if (ch === '"' || ch === '`') return true;
  if (code < 0x80) return false;
  return /^\p{P}$/u.test(ch) || /^\p{Z}$/u.test(ch);
}

/** URL 标准会把这三者归一成 `.` 的域名分隔符。 */
function isIdnDomainDot(ch: string | undefined): boolean {
  const code = ch?.codePointAt(0);
  return code === 0x3002 || code === 0xff0e || code === 0xff61;
}

function firstAuthDelimiterIndex(text: string, from = 0): number {
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '/' || ch === '?' || ch === '#') return index;
  }
  return text.length;
}

/** IDN 点号只在 hostname 内保留；端口和 IPv6 `]` 之后仍是正文边界。 */
function hostnameRange(raw: string): { start: number; end: number } {
  const scheme = raw.match(/^https?:\/\//i);
  let start = scheme ? scheme[0].length : 0;
  const authEnd = firstAuthDelimiterIndex(raw, start);
  const at = raw.lastIndexOf('@', authEnd - 1);
  if (at >= start) start = at + 1;
  if (raw[start] === '[') {
    const close = raw.indexOf(']', start + 1);
    return { start, end: close >= 0 && close < authEnd ? close + 1 : authEnd };
  }
  for (let index = start; index < authEnd; index += 1) {
    if (raw[index] === ':') return { start, end: index };
  }
  return { start, end: authEnd };
}

function isHostLabelChar(ch: string | undefined): boolean {
  if (ch == null || isIdnDomainDot(ch)) return false;
  if (ch === '/' || ch === '?' || ch === '#' || ch === ':' || ch === '@') return false;
  return !isAutolinkPunctuationBoundary(ch);
}

function isCjkLetter(ch: string): boolean {
  return /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u.test(ch);
}

function nextHostLabelEnd(raw: string, from: number, hostEnd: number): number {
  let index = from;
  while (index < hostEnd) {
    const code = raw.codePointAt(index);
    if (code == null) break;
    const char = String.fromCodePoint(code);
    if (isIdnDomainDot(char) || char === '.') break;
    if (!isHostLabelChar(char)) break;
    index += char.length;
  }
  return index;
}

function isIdnDotInHostname(
  raw: string,
  index: number,
  hostStart: number,
  hostEnd: number,
): boolean {
  if (index < hostStart || index >= hostEnd) return false;
  if (!isIdnDomainDot(raw[index] ?? '') || !isHostLabelChar(raw[index + 1])) return false;
  const labelEnd = nextHostLabelEnd(raw, index + 1, hostEnd);
  const chars = [...raw.slice(index + 1, labelEnd)];
  if (chars.length === 0) return false;
  // 俄文/拉丁等字母脚本是真 IDN 标签，不限长度。
  if (chars.some((ch) => /^\p{L}$/u.test(ch) && !isCjkLetter(ch))) return true;
  if (chars.some((ch) => /[A-Za-z0-9]/.test(ch))) return true;
  // 纯汉字标签：后面还有域名分隔符，或已有 path/port/query，说明主机还没完。
  // 无路径的歧义场景才用 1–3 字 TLD 上限，避免 `。这是说明` 并进主机名。
  const after = raw[labelEnd];
  if (after === '.' || isIdnDomainDot(after) || hostEnd < raw.length) return true;
  return chars.length <= 3;
}

/**
 * 标点是正文边界。hostname 里真 IDN 点号留下；完整主机后的 `。这是说明` 切掉。
 */
function findAutolinkProseBoundary(raw: string): number {
  const { start: hostStart, end: hostEnd } = hostnameRange(raw);
  for (let index = 0; index < raw.length; ) {
    const code = raw.codePointAt(index);
    if (code == null) break;
    const char = String.fromCodePoint(code);
    if (
      isAutolinkPunctuationBoundary(char) &&
      !isIdnDotInHostname(raw, index, hostStart, hostEnd)
    ) {
      return index;
    }
    index += char.length;
  }
  return raw.length;
}

export function markdownWrapMarkerFromPrefix(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  for (const marker of MARKDOWN_WRAP_MARKERS) {
    if (!prefix.endsWith(marker)) continue;
    return isMarkdownWrapOpenBoundary(prefix[prefix.length - marker.length - 1])
      ? marker
      : null;
  }
  return null;
}

export type ClipBareHttpAutolinkOptions = {
  prefix?: string | null;
  markdownWrapMarker?: string | null;
  stripMarkdownFormattingPunct?: boolean | 'auto';
  /** Desktop GFM 会把 path 里的 `[]`/`{}` 当说明；Mobile 原匹配器会保留。 */
  cutPathBrackets?: boolean;
};

/**
 * 返回 `raw` 里真实 href 的结束下标（不含）。
 * prefix 是 URL 前面的正文，用来识别包裹括号 / 引号 / markdown 开标记。
 */
export function clipBareHttpAutolink(
  raw: string,
  options: ClipBareHttpAutolinkOptions = {},
): number {
  const prefix = options.prefix ?? '';
  const wrappingParenCount = countUnmatchedOpeningParens(prefix);
  const marker =
    options.markdownWrapMarker === undefined
      ? markdownWrapMarkerFromPrefix(prefix)
      : options.markdownWrapMarker;
  const boundaryIndex = findAutolinkProseBoundary(raw);
  const boundaryCut = boundaryIndex;
  const markdownCut = cutBeforeClosingMarkdownWrap(raw, marker);
  const limited = Math.min(boundaryCut, markdownCut);
  const proseCut = Math.min(
    limited,
    cutBeforeUnbalancedParenProse(raw, limited, { wrappingParenCount }),
    options.cutPathBrackets === false ? raw.length : cutBeforePathBracketProse(raw),
  );
  const stripMarkdown =
    options.stripMarkdownFormattingPunct === true ||
    (options.stripMarkdownFormattingPunct === 'auto' &&
      (markdownCut < raw.length ||
        hasTrailingMultiCharMarkdownMarkerAfterCodeHostResource(raw, proseCut) ||
        (boundaryIndex < raw.length &&
          proseCut === boundaryCut &&
          MARKDOWN_FORMATTING_STRIP_BOUNDARY.test(raw[boundaryIndex]))));
  return shrinkAutolinkTrailingJunk(raw, proseCut, {
    stripMarkdownFormattingPunct: stripMarkdown,
    stripWrappingApostrophe: prefix.endsWith("'"),
    stripWrappingParenCount: wrappingParenCount,
  });
}

export function clipBareHttpAutolinkText(
  raw: string,
  options: ClipBareHttpAutolinkOptions = {},
): string {
  return raw.slice(0, clipBareHttpAutolink(raw, options));
}

function hasTrailingMultiCharMarkdownMarkerAfterCodeHostResource(
  raw: string,
  cut: number,
): boolean {
  if (cut < 2) return false;
  return ['**', '__', '~~'].some(
    (marker) =>
      raw.slice(cut - marker.length, cut) === marker &&
      isCodeHostNumericResourcePath(raw.slice(0, cut - marker.length)),
  );
}
