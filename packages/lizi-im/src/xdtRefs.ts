/**
 * xdtRefs.ts — `xdt-image://` / `xdt-file://` 引用解析(渠道无关)。
 * ---------------------------------------------------------------------------
 * agent 文本里嵌的 xdt-* markdown 引用在各渠道的流式/收尾处理是同一套语义:
 *   - 中间帧: 替换成占位文本(渠道不接受裸 xdt-* URL)
 *   - finalize: 图片上传到渠道、文件单独发消息、正文剥掉 file 链接
 * 本模块只做纯文本解析, 上传/发送由各渠道 streamingText 自己实现。
 *
 * 引用形态(与 legacy feishuBot/replyClient.ts 对齐):
 *   图片  `![alt](xdt-image://...)` 或 `![alt](cindy-media://...)`(媒体总仓
 *         当前地址,生成图与集成图片均为此形态)
 *   文件  `[name](xdt-file:///abs/path)`
 */

import path from 'node:path';

export interface XdtImageRef {
  alt: string;
  url: string;
  start: number;
  end: number;
}

interface ParsedXdtRef extends XdtImageRef {
  kind: 'image' | 'file';
  escaped: boolean;
}

export interface MarkdownCodeRange {
  start: number;
  end: number;
}

function runLength(text: string, start: number, char: string): number {
  let end = start;
  while (text[end] === char) end += 1;
  return end - start;
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function lineEndAfterNewline(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline === -1 ? text.length : newline + 1;
}

function isBlankLine(text: string, start: number, end: number): boolean {
  return text.slice(start, end).trim() === '';
}

function contentLeavesParagraphOpen(content: string): boolean {
  if (content === '') return false;
  if (/^#{1,6}(?:[ \t]+|$)/.test(content)) return false;
  if (/^(?:={1,}|-{1,})[ \t]*$/.test(content)) return false;
  if (/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(content)) return false;
  if (/^(?:`{3,}|~{3,})/.test(content)) return false;
  return true;
}

function listItemContentIndent(text: string, start: number, end: number): number | null {
  const line = text.slice(start, end);
  const match = line.match(/^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)/);
  if (!match) return null;
  let columns = match[0].length - match[2].length;
  for (const char of match[2]) {
    columns += char === '\t' ? 4 - (columns % 4) : 1;
  }
  return columns;
}

function indentedCodeStartLines(text: string): Set<number> {
  const starts = new Set<number>();
  let lineStart = 0;
  let paragraphOpen = false;
  let activeListIndent: number | null = null;
  let activeQuoteDepth = 0;
  while (lineStart < text.length) {
    const lineEnd = lineEndAfterNewline(text, lineStart);
    const prefix = lineContainerPrefix(text, lineStart, lineEnd);
    if (prefix.quoteDepth !== activeQuoteDepth) {
      paragraphOpen = false;
      activeListIndent = null;
      activeQuoteDepth = prefix.quoteDepth;
    }
    const blank = text.slice(prefix.cursor, lineEnd).trim() === '';
    const indent = prefix.indent;
    const containedByList =
      activeListIndent !== null && indent >= activeListIndent && indent < activeListIndent + 4;
    const startsIndentedCode = indent >= 4 && !paragraphOpen && !containedByList;
    if (startsIndentedCode) starts.add(lineStart);

    if (!blank) {
      const relativeListIndent = listItemContentIndent(text, prefix.cursor, lineEnd);
      if (relativeListIndent !== null) activeListIndent = indent + relativeListIndent;
      else if (indent === 0) activeListIndent = null;
    }
    if (blank || startsIndentedCode) paragraphOpen = false;
    else if (indent < 4 || containedByList) {
      paragraphOpen = contentLeavesParagraphOpen(
        text.slice(prefix.cursor, lineEnd).trim(),
      );
    }
    lineStart = lineEnd;
  }
  return starts;
}

function isIndentedCodeContinuation(text: string, start: number, end: number): boolean {
  const prefix = lineContainerPrefix(text, start, end);
  return prefix.indent >= 4 || text.slice(prefix.cursor, end).trim() === '';
}

interface LineContainerPrefix {
  cursor: number;
  quoteDepth: number;
  indent: number;
}

function lineContainerPrefix(text: string, lineStart: number, lineEnd: number): LineContainerPrefix {
  let cursor = lineStart;
  let quoteDepth = 0;
  let indent = 0;
  while (cursor < lineEnd) {
    const indentStart = cursor;
    let spaces = 0;
    while (cursor < lineEnd && spaces < 3 && text[cursor] === ' ') {
      cursor += 1;
      spaces += 1;
    }
    if (text[cursor] !== '>') {
      // The three-space limit applies to a fence relative to its container,
      // not to the indentation that keeps a continuation inside a list.
      cursor = indentStart;
      indent = 0;
      while (cursor < lineEnd && (text[cursor] === ' ' || text[cursor] === '\t')) {
        if (text[cursor] === '\t') indent += 4 - (indent % 4);
        else indent += 1;
        cursor += 1;
      }
      break;
    }
    quoteDepth += 1;
    cursor += 1;
    if (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    indent = 0;
  }
  return { cursor, quoteDepth, indent };
}

interface FenceMarker {
  start: number;
  marker: '`' | '~';
  run: number;
  quoteDepth: number;
  listContentIndent: number | null;
}

function fenceMarkerAtLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  allowListMarker: boolean,
  maxIndent: number,
): FenceMarker | null {
  const prefix = lineContainerPrefix(text, lineStart, lineEnd);
  if (prefix.indent > maxIndent) return null;
  let cursor = prefix.cursor;
  let contentIndent = prefix.indent;
  let listContentIndent: number | null = null;
  while (allowListMarker && cursor < lineEnd) {
    let markerEnd = cursor;
    if (text[markerEnd] === '-' || text[markerEnd] === '+' || text[markerEnd] === '*') {
      markerEnd += 1;
    } else {
      let digits = 0;
      while (markerEnd < lineEnd && digits < 9) {
        const code = text.charCodeAt(markerEnd);
        if (code < 48 || code > 57) break;
        markerEnd += 1;
        digits += 1;
      }
      if (digits === 0 || (text[markerEnd] !== '.' && text[markerEnd] !== ')')) break;
      markerEnd += 1;
    }
    if (text[markerEnd] !== ' ' && text[markerEnd] !== '\t') break;
    contentIndent += markerEnd - cursor;
    cursor = markerEnd;
    while (text[cursor] === ' ' || text[cursor] === '\t') {
      contentIndent += text[cursor] === '\t' ? 4 - (contentIndent % 4) : 1;
      cursor += 1;
    }
    listContentIndent = contentIndent;
  }
  const marker = text[cursor];
  if (marker !== '`' && marker !== '~') return null;
  const run = runLength(text, cursor, marker);
  return run >= 3
    ? { start: cursor, marker, run, quoteDepth: prefix.quoteDepth, listContentIndent }
    : null;
}

function isValidFenceOpener(text: string, marker: FenceMarker, lineEnd: number): boolean {
  return (
    marker.marker !== '`' ||
    !text.slice(marker.start + marker.run, lineEnd).includes('`')
  );
}

function lineStaysInFenceContainer(
  text: string,
  lineStart: number,
  lineEnd: number,
  opening: FenceMarker,
): boolean {
  const prefix = lineContainerPrefix(text, lineStart, lineEnd);
  if (opening.quoteDepth > 0 && prefix.quoteDepth < opening.quoteDepth) return false;
  if (opening.listContentIndent === null || isBlankLine(text, lineStart, lineEnd)) return true;
  return prefix.indent >= opening.listContentIndent;
}

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_TAG_RE = new RegExp(
  `^</?(?:${HTML_BLOCK_TAGS})(?:\\s|/?>|$)`,
  'i',
);
const HTML_TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const HTML_ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z0-9_.:-]*';
const HTML_ATTRIBUTE_VALUE = `(?:[^\\s"'=<>\\x60]+|'[^']*'|"[^"]*")`;
const COMPLETE_HTML_TAG_RE = new RegExp(
  `^(?:<${HTML_TAG_NAME}(?:\\s+${HTML_ATTRIBUTE_NAME}(?:\\s*=\\s*${HTML_ATTRIBUTE_VALUE})?)*\\s*/?>|</${HTML_TAG_NAME}\\s*>)[ \\t]*(?:\\r?\\n)?$`,
);

interface HtmlBlockLineStart {
  contentStart: number;
  quoteDepth: number;
  listContentIndent: number | null;
}

function htmlBlockLineStart(
  text: string,
  lineStart: number,
  lineEnd: number,
): HtmlBlockLineStart | null {
  const prefix = lineContainerPrefix(text, lineStart, lineEnd);
  if (prefix.indent > 3) return null;
  let cursor = prefix.cursor;
  let contentIndent = prefix.indent;
  let listContentIndent: number | null = null;
  while (cursor < lineEnd) {
    let markerEnd = cursor;
    if (text[markerEnd] === '-' || text[markerEnd] === '+' || text[markerEnd] === '*') {
      markerEnd += 1;
    } else {
      let digits = 0;
      while (markerEnd < lineEnd && digits < 9) {
        const code = text.charCodeAt(markerEnd);
        if (code < 48 || code > 57) break;
        markerEnd += 1;
        digits += 1;
      }
      if (digits === 0 || (text[markerEnd] !== '.' && text[markerEnd] !== ')')) break;
      markerEnd += 1;
    }
    if (text[markerEnd] !== ' ' && text[markerEnd] !== '\t') break;
    contentIndent += markerEnd - cursor;
    cursor = markerEnd;
    while (text[cursor] === ' ' || text[cursor] === '\t') {
      contentIndent += text[cursor] === '\t' ? 4 - (contentIndent % 4) : 1;
      cursor += 1;
    }
    listContentIndent = contentIndent;
  }
  return { contentStart: cursor, quoteDepth: prefix.quoteDepth, listContentIndent };
}

function lineStaysInHtmlBlockContainer(
  text: string,
  lineStart: number,
  lineEnd: number,
  opening: HtmlBlockLineStart,
): boolean {
  const prefix = lineContainerPrefix(text, lineStart, lineEnd);
  if (opening.quoteDepth > 0 && prefix.quoteDepth < opening.quoteDepth) return false;
  if (opening.listContentIndent === null || isBlankLine(text, lineStart, lineEnd)) return true;
  return prefix.indent >= opening.listContentIndent;
}

function lineLeavesParagraphOpen(
  text: string,
  lineStart: number,
  lineEnd: number,
  start: HtmlBlockLineStart,
): boolean {
  const content = text.slice(start.contentStart, lineEnd).trim();
  return contentLeavesParagraphOpen(content);
}

function markdownHtmlBlockRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const lowerText = text.toLowerCase();
  let lineStart = 0;
  let paragraphOpen = false;
  let paragraphQuoteDepth = 0;
  while (lineStart < text.length) {
    const lineEnd = lineEndAfterNewline(text, lineStart);
    const opening = htmlBlockLineStart(text, lineStart, lineEnd);
    if (!opening) {
      paragraphOpen = false;
      lineStart = lineEnd;
      continue;
    }
    const content = text.slice(opening.contentStart, lineEnd);
    const contentLower = content.toLowerCase();
    let closingMarker: string | null = null;
    let blankTerminated = false;
    if (content.startsWith('<!--')) closingMarker = '-->';
    else if (content.startsWith('<?')) closingMarker = '?>';
    else if (content.startsWith('<![CDATA[')) closingMarker = ']]>';
    else if (/^<![A-Z]/.test(content)) closingMarker = '>';
    else {
      const rawTag = contentLower.match(/^<(pre|script|style|textarea)(?:\s|>|$)/)?.[1];
      if (rawTag) closingMarker = `</${rawTag}>`;
      else if (HTML_BLOCK_TAG_RE.test(content)) blankTerminated = true;
      else if (
        (!paragraphOpen || paragraphQuoteDepth !== opening.quoteDepth) &&
        COMPLETE_HTML_TAG_RE.test(content)
      ) {
        blankTerminated = true;
      }
      else {
        paragraphOpen = lineLeavesParagraphOpen(text, lineStart, lineEnd, opening);
        paragraphQuoteDepth = opening.quoteDepth;
        lineStart = lineEnd;
        continue;
      }
    }

    let blockEnd = text.length;
    if (closingMarker) {
      const closingLower = closingMarker.toLowerCase();
      let searchLine = lineStart;
      while (searchLine < text.length) {
        const searchEnd = lineEndAfterNewline(text, searchLine);
        if (
          searchLine !== lineStart &&
          !lineStaysInHtmlBlockContainer(text, searchLine, searchEnd, opening)
        ) {
          blockEnd = searchLine;
          break;
        }
        const searchStart =
          searchLine === lineStart
            ? opening.contentStart + content.indexOf('<') + 1
            : lineContainerPrefix(text, searchLine, searchEnd).cursor;
        const closingInLine = lowerText.slice(searchStart, searchEnd).indexOf(closingLower);
        if (closingInLine >= 0) {
          blockEnd = searchEnd;
          break;
        }
        searchLine = searchEnd;
      }
    } else if (blankTerminated) {
      let searchLine = lineEnd;
      while (searchLine < text.length) {
        const searchEnd = lineEndAfterNewline(text, searchLine);
        if (!lineStaysInHtmlBlockContainer(text, searchLine, searchEnd, opening)) {
          blockEnd = searchLine;
          break;
        }
        if (isBlankLine(text, searchLine, searchEnd)) {
          blockEnd = searchLine;
          break;
        }
        searchLine = searchEnd;
      }
    }
    ranges.push({ start: lineStart, end: blockEnd });
    paragraphOpen = false;
    lineStart = blockEnd;
  }
  return ranges;
}

function mergeMarkdownRanges(ranges: MarkdownCodeRange[]): MarkdownCodeRange[] {
  const sorted = ranges.sort((a, b) => a.start - b.start);
  const merged: MarkdownCodeRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Locate non-rendered Markdown regions without copying large model output. */
export function markdownCodeRanges(text: string): MarkdownCodeRange[] {
  const fences: MarkdownCodeRange[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const openingLineEnd = lineEndAfterNewline(text, lineStart);
    const opening = fenceMarkerAtLine(text, lineStart, openingLineEnd, true, 3);
    if (!opening || !isValidFenceOpener(text, opening, openingLineEnd)) {
      lineStart = openingLineEnd;
      continue;
    }

    let searchLine = openingLineEnd;
    let fenceEnd = text.length;
    while (searchLine < text.length) {
      const candidateLineEnd = lineEndAfterNewline(text, searchLine);
      if (!lineStaysInFenceContainer(text, searchLine, candidateLineEnd, opening)) {
        fenceEnd = searchLine;
        break;
      }
      // A closing fence inside a list must use the existing container's
      // continuation indentation. A fresh list marker is code content.
      const closing = fenceMarkerAtLine(
        text,
        searchLine,
        candidateLineEnd,
        false,
        (opening.listContentIndent ?? 0) + 3,
      );
      if (
        closing?.marker === opening.marker &&
        closing.run >= opening.run &&
        closing.quoteDepth === opening.quoteDepth &&
        (opening.listContentIndent !== null || closing.listContentIndent === null)
      ) {
        const rest = text.slice(closing.start + closing.run, candidateLineEnd).trim();
        if (rest === '') {
          fenceEnd = candidateLineEnd;
          break;
        }
      }
      searchLine = candidateLineEnd;
    }
    fences.push({ start: lineStart, end: fenceEnd });
    lineStart = fenceEnd;
  }

  const blocks = [...fences];
  const indentedStarts = indentedCodeStartLines(text);
  lineStart = 0;
  while (lineStart < text.length) {
    const fence = codeRangeAt(fences, lineStart);
    if (fence) {
      lineStart = fence.end;
      continue;
    }
    const lineEnd = lineEndAfterNewline(text, lineStart);
    if (!indentedStarts.has(lineStart)) {
      lineStart = lineEnd;
      continue;
    }
    const blockStart = lineStart;
    let blockEnd = lineEnd;
    lineStart = lineEnd;
    while (lineStart < text.length) {
      const nextFence = codeRangeAt(fences, lineStart);
      if (nextFence) break;
      const nextLineEnd = lineEndAfterNewline(text, lineStart);
      if (
        !isIndentedCodeContinuation(text, lineStart, nextLineEnd)
      ) {
        break;
      }
      blockEnd = nextLineEnd;
      lineStart = nextLineEnd;
    }
    blocks.push({ start: blockStart, end: blockEnd });
  }
  blocks.push(...markdownHtmlBlockRanges(text));
  const mergedBlocks = mergeMarkdownRanges(blocks);

  const ranges = [...mergedBlocks];
  let blockIndex = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const block = mergedBlocks[blockIndex];
    if (block && cursor >= block.start) {
      cursor = block.end;
      blockIndex += 1;
      continue;
    }
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    const openingRun = runLength(text, cursor, '`');
    if (isEscapedAt(text, cursor)) {
      cursor += openingRun;
      continue;
    }
    let search = cursor + openingRun;
    let closingEnd = -1;
    while (search < text.length && (!block || search < block.start)) {
      const next = text.indexOf('`', search);
      if (next === -1 || (block && next >= block.start)) break;
      const closingRun = runLength(text, next, '`');
      if (closingRun === openingRun) {
        closingEnd = next + closingRun;
        break;
      }
      search = next + closingRun;
    }
    if (closingEnd === -1) {
      cursor += openingRun;
      continue;
    }
    ranges.push({ start: cursor, end: closingEnd });
    cursor = closingEnd;
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Remove residual bare internal file URLs while preserving Markdown code examples. */
export function sanitizeBareXdtFileUrls(text: string): string {
  const ranges = markdownCodeRanges(text);
  const lower = text.toLowerCase();
  const scheme = 'xdt-file://';
  let cursor = 0;
  let sanitized = '';
  while (cursor < text.length) {
    const start = lower.indexOf(scheme, cursor);
    if (start < 0) return sanitized + text.slice(cursor);
    if (isMarkdownCodePosition(ranges, start)) {
      sanitized += text.slice(cursor, start + scheme.length);
      cursor = start + scheme.length;
      continue;
    }
    let end = start + scheme.length;
    while (end < text.length && !/[\s<>"'`\])]/.test(text[end])) end += 1;
    sanitized += `${text.slice(cursor, start)}附件`;
    cursor = end;
  }
  return sanitized;
}

function codeRangeAt(
  ranges: readonly MarkdownCodeRange[],
  position: number,
): MarkdownCodeRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (position < range.start) high = mid - 1;
    else if (position >= range.end) low = mid + 1;
    else return range;
  }
  return null;
}

export function isMarkdownCodePosition(
  ranges: readonly MarkdownCodeRange[],
  position: number,
): boolean {
  return codeRangeAt(ranges, position) !== null;
}

function markdownLabelEnd(
  text: string,
  start: number,
  closeByOpen: Int32Array,
): { end: number; nested: boolean } {
  const closing = closeByOpen[start - 1];
  if (closing !== -1 && text[closing + 1] === '(') {
    return { end: closing, nested: false };
  }
  const firstNested = text.indexOf('[', closing === -1 ? start : closing + 1);
  if (firstNested !== -1) return { end: firstNested, nested: true };
  return { end: text.length, nested: false };
}

function markdownLinkOpenPrefix(
  text: string,
  closeByOpen: Int32Array,
  codeRanges: readonly MarkdownCodeRange[],
): Int32Array {
  const prefix = new Int32Array(text.length + 1);
  let codeRangeIndex = 0;
  for (let opening = 0; opening < text.length; opening += 1) {
    prefix[opening + 1] = prefix[opening];
    while (codeRanges[codeRangeIndex]?.end <= opening) codeRangeIndex += 1;
    const codeRange = codeRanges[codeRangeIndex];
    if (text[opening] !== '[' || (codeRange !== undefined && codeRange.start <= opening)) continue;
    if (isEscapedAt(text, opening)) continue;
    const closing = closeByOpen[opening];
    if (closing === -1 || text[closing + 1] !== '(') continue;
    const image = opening > 0 && text[opening - 1] === '!' && !isEscapedAt(text, opening - 1);
    if (!image) prefix[opening + 1] += 1;
  }
  return prefix;
}

function markdownBracketPairs(text: string): Int32Array {
  const closeByOpen = new Int32Array(text.length);
  closeByOpen.fill(-1);
  const stack: number[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') {
      if (text[cursor + 1] === '[' && stack.length === 0) {
        cursor += 1;
        stack.push(cursor);
        continue;
      }
      cursor += 1;
      continue;
    }
    if (text[cursor] === '[') {
      stack.push(cursor);
    } else if (text[cursor] === ']' && stack.length > 0) {
      closeByOpen[stack.pop()!] = cursor;
    }
  }
  return closeByOpen;
}

function markdownParenPairs(text: string): {
  closeByOpen: Int32Array;
  openByClose: Int32Array;
} {
  const closeByOpen = new Int32Array(text.length);
  const openByClose = new Int32Array(text.length);
  closeByOpen.fill(-1);
  openByClose.fill(-1);
  const stack: number[] = [];
  let titleQuote: '"' | "'" | null = null;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (titleQuote) {
      if (text[cursor] === titleQuote) titleQuote = null;
      if (text[cursor] === '\n' || text[cursor] === '\r') titleQuote = null;
      continue;
    }
    if (
      (text[cursor] === '"' || text[cursor] === "'") &&
      stack.length > 0 &&
      (text[cursor - 1] === ' ' ||
        text[cursor - 1] === '\t' ||
        text[cursor - 1] === '\n' ||
        text[cursor - 1] === '\r')
    ) {
      titleQuote = text[cursor] as '"' | "'";
      continue;
    }
    if (text[cursor] === '(') {
      stack.push(cursor);
    } else if (text[cursor] === ')' && stack.length > 0) {
      const opening = stack.pop()!;
      closeByOpen[opening] = cursor;
      openByClose[cursor] = opening;
    }
  }
  return { closeByOpen, openByClose };
}

function markdownWhitespacePositions(text: string): number[] {
  const positions: number[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\' && isMarkdownEscapablePunctuation(text[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (/\s/.test(text[cursor])) positions.push(cursor);
  }
  return positions;
}

function isMarkdownEscapablePunctuation(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function hasInvalidAngleDestinationChar(text: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (text[cursor] === '\\' && isMarkdownEscapablePunctuation(text[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '<' || text[cursor] === '\n' || text[cursor] === '\r') return true;
  }
  return false;
}

function hasWhitespaceBetween(positions: readonly number[], start: number, end: number): boolean {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (positions[mid] < start) low = mid + 1;
    else high = mid;
  }
  return low < positions.length && positions[low] < end;
}

function markdownTitleWhitespaceEnd(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  if (text[cursor] === '\r') {
    cursor += text[cursor + 1] === '\n' ? 2 : 1;
  } else if (text[cursor] === '\n') {
    cursor += 1;
  }
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  return text[cursor] === '\r' || text[cursor] === '\n' ? -1 : cursor;
}

function plainTitleUrlEnd(text: string, titleStart: number, schemeStart: number): number {
  let cursor = titleStart;
  while (text[cursor - 1] === ' ' || text[cursor - 1] === '\t') cursor -= 1;
  if (text[cursor - 1] === '\n') {
    cursor -= text[cursor - 2] === '\r' ? 2 : 1;
  } else if (text[cursor - 1] === '\r') {
    cursor -= 1;
  }
  while (text[cursor - 1] === ' ' || text[cursor - 1] === '\t') cursor -= 1;
  if (
    cursor === titleStart ||
    cursor <= schemeStart ||
    text[cursor - 1] === '\r' ||
    text[cursor - 1] === '\n'
  ) {
    return -1;
  }
  return cursor;
}

const MAX_COMMONMARK_LINK_DESTINATION_PAREN_DEPTH = 32;

function exceedsPlainDestinationParenDepth(text: string, start: number, end: number): boolean {
  let depth = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    if (text[cursor] === '\\' && isMarkdownEscapablePunctuation(text[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === '(') {
      depth += 1;
      if (depth > MAX_COMMONMARK_LINK_DESTINATION_PAREN_DEPTH) return true;
    } else if (text[cursor] === ')') {
      depth -= 1;
    }
  }
  return false;
}

function angleReferenceEnd(text: string, closingAngle: number): number {
  const whitespaceStart = closingAngle + 1;
  let cursor = markdownTitleWhitespaceEnd(text, whitespaceStart);
  if (cursor === -1) return -1;
  if (text[cursor] === ')') return cursor;
  if (cursor === whitespaceStart) return -1;
  const opener = text[cursor];
  const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === '(' ? ')' : null;
  if (!closer) return -1;
  cursor += 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === closer) break;
    if (text[cursor] === '\n' || text[cursor] === '\r') return -1;
    cursor += 1;
  }
  if (text[cursor] !== closer) return -1;
  cursor += 1;
  cursor = markdownTitleWhitespaceEnd(text, cursor);
  if (cursor === -1) return -1;
  return text[cursor] === ')' ? cursor : -1;
}

function plainReferenceBounds(
  text: string,
  schemeStart: number,
  endParen: number,
  openByClose: Int32Array,
  whitespacePositions: readonly number[],
): { endParen: number; urlEnd: number } {
  const fallback = (): { endParen: number; urlEnd: number } => ({
    endParen,
    urlEnd: hasWhitespaceBetween(whitespacePositions, schemeStart, endParen)
      ? schemeStart
      : endParen,
  });
  let titleEnd = endParen - 1;
  while (text[titleEnd] === ' ' || text[titleEnd] === '\t') titleEnd -= 1;

  const closingTitle = text[titleEnd];
  let openingTitle: '"' | "'";
  if (closingTitle === '"' || closingTitle === "'") {
    openingTitle = closingTitle;
  } else if (closingTitle === ')') {
    const titleStart = openByClose[titleEnd];
    if (titleStart <= schemeStart) return fallback();
    const urlEnd = plainTitleUrlEnd(text, titleStart, schemeStart);
    if (urlEnd === -1) return fallback();
    if (hasWhitespaceBetween(whitespacePositions, schemeStart, urlEnd)) {
      return { endParen, urlEnd: schemeStart };
    }
    return { endParen, urlEnd };
  } else {
    return fallback();
  }

  let titleStart = titleEnd - 1;
  while (titleStart > schemeStart) {
    if (text[titleStart] === openingTitle) {
      let slashes = 0;
      for (let i = titleStart - 1; i >= schemeStart && text[i] === '\\'; i -= 1) slashes += 1;
      if (slashes % 2 === 0) break;
    }
    if (text[titleStart] === '\n' || text[titleStart] === '\r') {
      return fallback();
    }
    titleStart -= 1;
  }
  if (text[titleStart] !== openingTitle) {
    return fallback();
  }
  const urlEnd = plainTitleUrlEnd(text, titleStart, schemeStart);
  if (urlEnd === -1) {
    return fallback();
  }
  if (hasWhitespaceBetween(whitespacePositions, schemeStart, urlEnd)) {
    return { endParen, urlEnd: schemeStart };
  }
  return { endParen, urlEnd };
}

/**
 * 判定 text[openBracket] 处是否**直接**开始一个 managed-media 引用。判据与
 * parseXdtRefs 主循环逐条同语义(前一字符 '!' 决定 image、alt 方括号配对、
 * '](' 收尾、按 image 与否认 scheme), 只读、无副作用。
 *
 * "直接"很关键: 合法嵌套方括号属于当前 label；畸形外层候选则由主循环从
 * 后续 '[' 恢复。
 */
function refStartsAt(
  text: string,
  openBracket: number,
  codeRanges: readonly MarkdownCodeRange[],
  bracketCloseByOpen: Int32Array,
): boolean {
  if (codeRangeAt(codeRanges, openBracket)) return false;
  const image = openBracket > 0 && text[openBracket - 1] === '!';
  const label = markdownLabelEnd(text, openBracket + 1, bracketCloseByOpen);
  if (label.end >= text.length || label.nested) return false;

  const urlStart = label.end + 2;
  const schemeStart = text[urlStart] === '<' ? urlStart + 1 : urlStart;
  return image
    ? text.startsWith('xdt-image://', schemeStart) || text.startsWith('cindy-media://', schemeStart)
    : text.startsWith('xdt-file://', schemeStart);
}

/**
 * Parse managed-media Markdown in one forward pass. Model output is
 * uncontrolled input, so this deliberately avoids the former global regexes:
 * repeated near-matches could make the regex engine rescan a long suffix.
 */
function parseXdtRefs(text: string): ParsedXdtRef[] {
  const refs: ParsedXdtRef[] = [];
  const codeRanges = markdownCodeRanges(text);
  const bracketCloseByOpen = markdownBracketPairs(text);
  const linkOpenPrefix = markdownLinkOpenPrefix(text, bracketCloseByOpen, codeRanges);
  const parenPairs = markdownParenPairs(text);
  const whitespacePositions = markdownWhitespacePositions(text);
  let cursor = 0;
  let cachedAngle = -2;
  const nextAngle = (from: number): number => {
    if (cachedAngle === -1 || cachedAngle >= from) return cachedAngle;
    cachedAngle = text.indexOf('>', from);
    return cachedAngle;
  };

  while (cursor < text.length) {
    const openBracket = text.indexOf('[', cursor);
    if (openBracket === -1) break;
    const codeRange = codeRangeAt(codeRanges, openBracket);
    if (codeRange) {
      cursor = codeRange.end;
      continue;
    }

    const image = openBracket > 0 && text[openBracket - 1] === '!';
    const start = image ? openBracket - 1 : openBracket;
    const altStart = openBracket + 1;
    const label = markdownLabelEnd(text, altStart, bracketCloseByOpen);
    const altEnd = label.end;

    // A nested opening bracket only supersedes an unmatched outer label.
    // Balanced nested brackets are already included in altEnd.
    if (label.nested) {
      cursor = altEnd;
      continue;
    }
    if (altEnd >= text.length) break;

    if (!image && linkOpenPrefix[altEnd] > linkOpenPrefix[altStart]) {
      cursor = altStart;
      continue;
    }

    const urlStart = altEnd + 2;
    const angleWrapped = text[urlStart] === '<';
    const schemeStart = angleWrapped ? urlStart + 1 : urlStart;
    const scheme = image
      ? text.startsWith('xdt-image://', schemeStart)
        ? 'xdt-image://'
        : text.startsWith('cindy-media://', schemeStart)
          ? 'cindy-media://'
          : null
      : text.startsWith('xdt-file://', schemeStart)
        ? 'xdt-file://'
        : null;
    if (!scheme) {
      cursor = urlStart;
      continue;
    }

    const closingAngle = angleWrapped ? nextAngle(schemeStart + scheme.length) : -1;
    const initialEndParen = angleWrapped
      ? closingAngle === -1 || hasInvalidAngleDestinationChar(text, schemeStart, closingAngle)
        ? -1
        : angleReferenceEnd(text, closingAngle)
      : parenPairs.closeByOpen[altEnd + 1];
    if (initialEndParen === -1) {
      // A malformed angle-wrapped candidate must not terminate the whole
      // scan: a later, independent managed-media reference may still be valid.
      // Advance beyond this scheme so recovery remains strictly linear.
      if (angleWrapped) {
        cursor = schemeStart + scheme.length;
        continue;
      }
      cursor = schemeStart + scheme.length;
      continue;
    }
    const bounds = angleWrapped
      ? { endParen: initialEndParen, urlEnd: closingAngle }
      : plainReferenceBounds(
          text,
          schemeStart,
          initialEndParen,
          parenPairs.openByClose,
          whitespacePositions,
        );
    const { endParen, urlEnd } = bounds;
    if (!angleWrapped && exceedsPlainDestinationParenDepth(text, schemeStart, urlEnd)) {
      cursor = schemeStart + scheme.length;
      continue;
    }
    // 畸形恢复(#1856 review P2): 未闭合引用会让本候选一路扫到**下一个**引用
    // 的右括号, 把后续合法引用整段吞进自己的 URL —— 收集丢附件, transform 还会
    // 把整段错误改写。判据是 URL 段里出现**构成引用起点**的 '['(#1856 review
    // P1 收窄: 早先"出现任意 '[' 就放弃"过宽, 把合法方括号文件名如
    // `[f](xdt-file:///tmp/report[final].pdf)` 静默丢掉 —— 旧正则实现与收敛前
    // 的解析器都接受这类 URL)。命中即放弃本候选、从那个 '[' 恢复前向扫描;
    // 一个都不命中就照常收下, URL 里的 '['/']' 原样保留。
    //
    // cursor 仍严格前进: recovery ≥ urlStart + scheme.length > openBracket。
    // 恢复判定本身是线性(本解析器防 ReDoS/防回扫的前提): refStartsAt 的 alt
    // 方括号和圆括号都在进入主循环前一次配对；且恢复点是本段第一个引用起点，
    // 下一候选的 URL 段从它之后才开始，各候选扫描区间不重叠。
    let recovery = -1;
    for (
      let bracket = text.indexOf('[', schemeStart + scheme.length);
      bracket !== -1 && bracket < urlEnd;
      bracket = text.indexOf('[', bracket + 1)
    ) {
      if (refStartsAt(text, bracket, codeRanges, bracketCloseByOpen)) {
        recovery = bracket;
        break;
      }
    }
    if (recovery !== -1) {
      cursor = recovery;
      continue;
    }
    if (urlEnd > schemeStart + scheme.length) {
      refs.push({
        kind: image ? 'image' : 'file',
        escaped: isEscapedAt(text, start),
        alt: text.slice(altStart, altEnd),
        url: text.slice(schemeStart, urlEnd),
        start,
        end: endParen + 1,
      });
    }
    cursor = endParen + 1;
  }

  return refs;
}

function replaceXdtRefs(
  text: string,
  refs: ReadonlyArray<ParsedXdtRef>,
  replacement: (ref: ParsedXdtRef) => string,
): string {
  if (refs.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    parts.push(text.slice(cursor, ref.start), replacement(ref));
    cursor = ref.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * 剥掉 Windows 盘符路径解码后残留的多余前导斜杠。
 *
 * 约定写法 xdt-file:///<绝对路径>:Unix 下剥协议后的首个 `/` 就是根;
 * Windows 盘符路径剥完剩 `/C:\...`(或 /C:/...),多余前导 `/` 会让下游
 * 存在性检查 / 目录白名单比对失败 → 文件静默丢失(2026-07-16 hook 渠道
 * 实踩)。这里是该归一化的唯一实现 —— hook-control/outbound.ts 的严格版
 * 解析(fail-closed 读盘校验)也消费它, 不再各持副本。
 */
export function normalizeXdtAbsPath(decoded: string): string {
  return decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
}

/** xdt-file://<absPath> → absPath (URL-decoded). */
export function xdtFileUrlToAbsPath(url: string): string {
  const raw = url.replace(/^xdt-file:\/\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return normalizeXdtAbsPath(decoded);
}

/** Replace xdt-* refs with placeholder text suitable for intermediate frames. */
export function stripXdtForStreaming(text: string): string {
  const refs = parseXdtRefs(text);
  return replaceXdtRefs(text, refs, (ref) => {
    if (ref.kind === 'image') return `[🖼️ ${ref.alt || '图片'} · 上传中...]`;
    const display = ref.alt || path.basename(xdtFileUrlToAbsPath(ref.url));
    return `[📎 ${display} · 准备发送...]`;
  });
}

/** Detect if `text` is essentially "only xdt refs" (no real prose). Used for
 *  picking a friendlier placeholder during streaming. */
export function classifyXdtOnly(
  text: string,
): 'image-only' | 'file-only' | 'mixed-or-text' {
  const refs = parseXdtRefs(text);
  const trimmed = replaceXdtRefs(text, refs, () => '').trim();
  if (trimmed.length > 0) return 'mixed-or-text';
  const hasImg = refs.some((ref) => ref.kind === 'image');
  const hasFile = refs.some((ref) => ref.kind === 'file');
  if (hasImg && !hasFile) return 'image-only';
  if (hasFile && !hasImg) return 'file-only';
  return 'mixed-or-text';
}

/** Remove xdt-file links entirely (since they're delivered as separate file messages). */
export function stripXdtFileLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'file');
  return replaceXdtRefs(text, refs, () => '');
}

/** Remove managed-image Markdown after it has been delivered as media. */
export function stripXdtImageLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'image');
  return replaceXdtRefs(text, refs, () => '');
}

export interface XdtFileLink {
  alt: string;
  absPath: string;
}

/** Collect xdt-file links from text, deduped by absPath (model often repeats). */
export function collectXdtFileLinks(text: string): XdtFileLink[] {
  const seen = new Map<string, XdtFileLink>();
  for (const ref of parseXdtRefs(text)) {
    if (ref.kind !== 'file' || ref.escaped) continue;
    const absPath = xdtFileUrlToAbsPath(ref.url);
    if (seen.has(absPath)) continue;
    seen.set(absPath, { alt: ref.alt, absPath });
  }
  return Array.from(seen.values());
}

/** Collect managed-image refs in source order, including text offsets. */
export function collectXdtImageRefs(text: string): XdtImageRef[] {
  return parseXdtRefs(text)
    .filter((ref) => ref.kind === 'image' && !ref.escaped)
    .map(({ alt, url, start, end }) => ({ alt, url, start, end }));
}

/** 文件引用(与 XdtImageRef 同形, url 未解码 —— 调用方自行决定解码与校验策略)。 */
export type XdtFileRef = XdtImageRef;

/**
 * Collect xdt-file refs in source order, including the raw URL. 与
 * collectXdtFileLinks 的差异: 不解码路径、不去重 —— 给需要按 URL 维度
 * 记账 / 自带严格路径校验的调用方(hook-control/outbound)用。
 */
export function collectXdtFileRefs(text: string): XdtFileRef[] {
  return parseXdtRefs(text)
    .filter((ref) => ref.kind === 'file' && !ref.escaped)
    .map(({ alt, url, start, end }) => ({ alt, url, start, end }));
}

export interface XdtRefTransform {
  /** 图片引用替换文本; 缺省 = 该类引用原样保留。 */
  image?: (ref: XdtImageRef) => string;
  /** 文件引用替换文本; 缺省 = 该类引用原样保留。 */
  file?: (ref: XdtFileRef) => string;
}

/**
 * 单遍变换文本里的托管媒体引用(收口正文改写的共享原语)。
 * 与 strip 系列的差异: 替换文案由调用方按引用逐个决定(如"已作为附件
 * 发送" vs 保留可读标签), 而不是固定剥离。
 */
export function transformXdtRefs(text: string, transform: XdtRefTransform): string {
  const refs = parseXdtRefs(text).filter((ref) =>
    ref.kind === 'image' ? transform.image !== undefined : transform.file !== undefined,
  );
  return replaceXdtRefs(text, refs, (ref) =>
    ref.kind === 'image'
      ? transform.image!({ alt: ref.alt, url: ref.url, start: ref.start, end: ref.end })
      : transform.file!({ alt: ref.alt, url: ref.url, start: ref.start, end: ref.end }),
  );
}

/** Collect unique xdt-image URLs from text. */
export function collectXdtImageUrls(text: string): string[] {
  const set = new Set<string>();
  for (const ref of collectXdtImageRefs(text)) set.add(ref.url);
  return Array.from(set);
}
