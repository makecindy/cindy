import type { Nodes, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import { parseProjectDeepLinkHref, PROJECT_DEEP_LINK_RE_SOURCE } from '@/lib/deepLink';
import remarkTruncateCjkUrls from './remarkTruncateCjkUrls';

/**
 * 放宽 AI 常见的中文加粗写法。
 *
 * CommonMark 的双星号收尾规则要求：如果加粗内容以标点结束、而右侧
 * 双星号后面紧接普通字符，这组双星号只能被识别为“开始”而不能被识别为
 * “结束”。例如 `**重点。**下一句` 会整段按原文显示。
 *
 * 这里不改用户看到的文字，只在这类已经存在未闭合加粗起点的收尾后插入
 * 一个会被 MarkdownRenderer 的 `skipHtml` 丢弃的 HTML 注释。解析树用于
 * 限定正文段落并排除代码、公式、链接地址和原始 HTML，避免字符扫描改写
 * 这些语法区域。
 */

const HIDDEN_SEPARATOR = '<!--cindy-strong-boundary-->';
const ASCII_PUNCTUATION = '\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E';
const POTENTIAL_BOUNDARY_RE = new RegExp(
  `[\\p{P}\\p{S}${ASCII_PUNCTUATION}]\\*\\*[^\\s\\p{P}\\p{S}${ASCII_PUNCTUATION}]`,
  'u',
);
const UNICODE_WHITESPACE_RE = /^\s$/u;
const UNICODE_PUNCTUATION_RE = new RegExp(
  `^[\\p{P}\\p{S}${ASCII_PUNCTUATION}]$`,
  'u',
);
const PROTECTED_NODE_TYPES = new Set<Nodes['type']>([
  'code',
  'definition',
  'html',
  'inlineCode',
  'math',
]);
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkTruncateCjkUrls);
const proseMarkdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkTruncateCjkUrls);
const characterReferenceParser = unified().use(remarkParse);

interface OffsetRange {
  start: number;
  end: number;
}

interface BoundaryRepair {
  openerStart: number;
  closerStart: number;
  separatorOffset: number;
}

interface MarkdownEdit {
  offset: number;
  deleteCount: number;
  value: string;
}

interface NormalizeStrongDelimiterBoundariesOptions {
  /**
   * 保护因行号对齐而保留源码形态的 `\[...\]` 与跨行 `\(...\)`。
   * 普通渲染会先把它们转换成 remark-math 可识别的美元符号定界符。
   */
  preserveTexDelimiters?: boolean;
}

function classifyCharacter(character: string | undefined): 'whitespace' | 'punctuation' | 'other' {
  if (!character || UNICODE_WHITESPACE_RE.test(character)) return 'whitespace';
  if (UNICODE_PUNCTUATION_RE.test(character)) return 'punctuation';
  return 'other';
}

function characterBefore(text: string, index: number): string | undefined {
  if (index === 0) return undefined;
  const characters = Array.from(text.slice(Math.max(0, index - 2), index));
  return characters.length > 0 ? characters[characters.length - 1] : undefined;
}

function characterAfter(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function nodeRange(node: Nodes): OffsetRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start == null || end == null ? null : { start, end };
}

function decodeCharacterReference(reference: string): string | null {
  const tree = characterReferenceParser.parse(reference) as Root;
  const paragraph = tree.children.length === 1 ? tree.children[0] : null;
  const text =
    paragraph?.type === 'paragraph' && paragraph.children.length === 1
      ? paragraph.children[0]
      : null;
  return text?.type === 'text' && text.value !== reference ? text.value : null;
}

function sourceOffsetAfterValue(
  markdown: string,
  range: OffsetRange,
  value: string,
): number | null {
  let sourceCursor = range.start;
  let valueCursor = 0;

  while (valueCursor < value.length && sourceCursor < range.end) {
    const sourceCharacter = characterAfter(markdown, sourceCursor);
    const valueCharacter = characterAfter(value, valueCursor);
    if (sourceCharacter === valueCharacter) {
      sourceCursor += sourceCharacter?.length ?? 0;
      valueCursor += valueCharacter?.length ?? 0;
      continue;
    }

    const referenceMatch = markdown
      .slice(sourceCursor, range.end)
      .match(/^&(?:#[xX][\dA-Fa-f]+|#\d+|[A-Za-z][A-Za-z\d]+);/u);
    if (!referenceMatch) return null;
    const decoded = decodeCharacterReference(referenceMatch[0]);
    if (!decoded || !value.startsWith(decoded, valueCursor)) return null;
    sourceCursor += referenceMatch[0].length;
    valueCursor += decoded.length;
  }

  return valueCursor === value.length ? sourceCursor : null;
}

function recoveredAutolinkTailRange(
  node: Nodes,
  range: OffsetRange,
  markdown: string,
): OffsetRange | null {
  if (node.type !== 'link' || markdown[range.start] === '[' || markdown[range.start] === '<') {
    return null;
  }
  const onlyChild = node.children.length === 1 ? node.children[0] : null;
  if (onlyChild?.type !== 'text') return null;

  // remarkTruncateCjkUrls 会缩短节点值，但保留覆盖原始裸链接的 source position。
  // 必须把缩短后的 head 映射回原始源码；节点值可能经过字符引用解码，不能把
  // value.length 直接当作源码长度。无法无损映射时宁可继续保护整段链接。
  const tailStart = sourceOffsetAfterValue(markdown, range, onlyChild.value);
  if (tailStart == null) return null;
  return tailStart < range.end ? { start: tailStart, end: range.end } : null;
}

function codeSpanEnd(markdown: string, start: number, end: number): number | null {
  let openerEnd = start + 1;
  while (openerEnd < end && markdown[openerEnd] === '`') openerEnd += 1;
  const delimiterLength = openerEnd - start;
  let scan = openerEnd;

  // 行内代码只由等长的反引号序列闭合；较短或较长的序列属于代码内容。
  while (scan < end) {
    const closerStart = markdown.indexOf('`', scan);
    if (closerStart === -1 || closerStart >= end) return null;
    let closerEnd = closerStart + 1;
    while (closerEnd < end && markdown[closerEnd] === '`') closerEnd += 1;
    if (closerEnd - closerStart === delimiterLength) return closerEnd;
    scan = closerEnd;
  }

  return null;
}

function inlineHtmlEnd(markdown: string, start: number, end: number): number | null {
  const source = markdown.slice(start, end);
  let closer = '>';
  if (source.startsWith('<!--')) closer = '-->';
  else if (source.startsWith('<?')) closer = '?>';
  else if (source.startsWith('<![CDATA[')) closer = ']]>';
  else if (
    !/^<\/?[A-Za-z][A-Za-z\d-]*(?:[\t\n\f\r />]|$)/u.test(source) &&
    !/^<![A-Z]/u.test(source)
  ) {
    return null;
  }

  if (closer !== '>') {
    const closerStart = markdown.indexOf(closer, start + 2);
    return closerStart === -1 || closerStart >= end ? null : closerStart + closer.length;
  }

  let quote: '"' | "'" | null = null;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = markdown[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return cursor + 1;
  }
  return null;
}

function uriAutolinkEnd(markdown: string, start: number, end: number): number | null {
  const closer = markdown.indexOf('>', start + 1);
  if (closer === -1 || closer >= end) return null;
  const destination = markdown.slice(start + 1, closer);
  if (!/^[A-Za-z][A-Za-z\d+.-]{1,31}:/u.test(destination)) return null;
  const hasForbiddenCharacter = Array.from(destination).some(
    (character) => character === '<' || character === '>' || character.charCodeAt(0) <= 0x20,
  );
  return hasForbiddenCharacter ? null : closer + 1;
}

function inlineLinkTailEnd(markdown: string, start: number, end: number): number | null {
  if (markdown[start] !== '(') return null;

  let cursor = start + 1;
  while (cursor < end && /[ \t\n\r]/u.test(markdown[cursor])) cursor += 1;

  if (markdown[cursor] === '<') {
    cursor += 1;
    while (cursor < end) {
      if (markdown[cursor] === '\n' || markdown[cursor] === '<') return null;
      if (markdown[cursor] === '\\' && cursor + 1 < end) {
        cursor += 2;
        continue;
      }
      if (markdown[cursor] === '>') {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (markdown[cursor - 1] !== '>') return null;
  } else {
    let nestedParentheses = 0;
    while (cursor < end) {
      const character = markdown[cursor];
      if (character === '\\' && cursor + 1 < end) {
        cursor += 2;
        continue;
      }
      if (character === '<' || character === '\n' || character === '\r') return null;
      if (character === '(') {
        nestedParentheses += 1;
        cursor += 1;
        continue;
      }
      if (character === ')') {
        if (nestedParentheses === 0) return cursor + 1;
        nestedParentheses -= 1;
        cursor += 1;
        continue;
      }
      if (character === ' ' || character === '\t') {
        if (nestedParentheses > 0) return null;
        break;
      }
      cursor += 1;
    }
  }

  const whitespaceStart = cursor;
  while (cursor < end && /[ \t\n\r]/u.test(markdown[cursor])) cursor += 1;
  if (markdown[cursor] === ')') return cursor + 1;
  if (cursor === whitespaceStart) return null;

  const titleOpener = markdown[cursor];
  const titleCloser = titleOpener === '(' ? ')' : titleOpener;
  if (titleOpener !== '"' && titleOpener !== "'" && titleOpener !== '(') return null;
  cursor += 1;
  while (cursor < end) {
    if (markdown[cursor] === '\\' && cursor + 1 < end) {
      cursor += 2;
      continue;
    }
    if (markdown[cursor] === titleCloser) {
      cursor += 1;
      break;
    }
    if (markdown[cursor] === '\n' || markdown[cursor] === '\r') return null;
    cursor += 1;
  }
  if (markdown[cursor - 1] !== titleCloser) return null;

  while (cursor < end && /[ \t\n\r]/u.test(markdown[cursor])) cursor += 1;
  return markdown[cursor] === ')' ? cursor + 1 : null;
}

function imageDescriptionRange(node: Nodes, markdown: string): OffsetRange | null {
  if (node.type !== 'image' && node.type !== 'imageReference') return null;
  const range = nodeRange(node);
  if (!range || markdown.slice(range.start, range.start + 2) !== '![') return null;

  const nestedBracketStarts: number[] = [];
  for (let cursor = range.start + 2; cursor < range.end; cursor += 1) {
    if (isEscaped(markdown, cursor)) continue;
    if (markdown[cursor] === '`') {
      const end = codeSpanEnd(markdown, cursor, range.end);
      if (end != null) cursor = end - 1;
      continue;
    }
    if (markdown[cursor] === '<') {
      const end =
        uriAutolinkEnd(markdown, cursor, range.end) ??
        inlineHtmlEnd(markdown, cursor, range.end);
      if (end != null) cursor = end - 1;
      continue;
    }
    if (markdown[cursor] === '[') {
      nestedBracketStarts.push(cursor);
      continue;
    }
    if (markdown[cursor] !== ']') continue;
    if (nestedBracketStarts.length > 0) {
      nestedBracketStarts.pop();
      if (nestedBracketStarts.length === 0) {
        const linkEnd = inlineLinkTailEnd(markdown, cursor + 1, range.end);
        if (linkEnd != null) cursor = linkEnd - 1;
      }
      continue;
    }
    return { start: range.start + 2, end: cursor };
  }

  return null;
}

function isLooseInlineMath(node: Nodes, markdown: string): boolean {
  if (node.type !== 'inlineMath') return false;
  const range = nodeRange(node);
  if (!range) return false;
  const raw = markdown.slice(range.start, range.end);
  const inner = raw.replace(/^\$+/, '').replace(/\$+$/, '');
  const nextCharacter = markdown[range.end] ?? '';
  return /^\s|\s$/u.test(inner) || inner.includes('`') || /^\d/u.test(nextCharacter);
}

function collectProtectedRanges(node: Nodes, ranges: OffsetRange[], markdown: string): void {
  if (node.type === 'link' || node.type === 'linkReference') {
    const range = nodeRange(node);
    if (range && markdown[range.start] !== '[') {
      const recoveredTail = recoveredAutolinkTailRange(node, range, markdown);
      ranges.push(recoveredTail ? { start: range.start, end: recoveredTail.start } : range);
      return;
    }
    const childRanges = node.children
      .map((child) => nodeRange(child))
      .filter((childRange): childRange is OffsetRange => childRange !== null);
    if (!range || childRanges.length === 0) {
      if (range) ranges.push(range);
      return;
    }

    // 链接文字是可见正文，需要继续扫描；只保护两侧的 Markdown 链接语法
    // 和地址，避免在目标地址内插入隐藏分隔符。
    ranges.push({ start: range.start, end: childRanges[0].start });
    ranges.push({ start: childRanges[childRanges.length - 1].end, end: range.end });
    for (const child of node.children) collectProtectedRanges(child, ranges, markdown);
    return;
  }

  if (node.type === 'image' || node.type === 'imageReference') {
    const range = nodeRange(node);
    const descriptionRange = imageDescriptionRange(node, markdown);
    if (!range || !descriptionRange) {
      if (range) ranges.push(range);
      return;
    }

    // 图片说明会成为可见替代文字，需要像链接文字一样扫描；只保护 `![`、
    // 目标地址与引用标签等外围语法。
    ranges.push({ start: range.start, end: descriptionRange.start });
    ranges.push({ start: descriptionRange.end, end: range.end });
    const description = markdown.slice(descriptionRange.start, descriptionRange.end);
    const descriptionTree = markdownParser.runSync(
      markdownParser.parse(description),
      description,
    ) as Root;
    const nestedRanges: OffsetRange[] = [];
    collectProtectedRanges(descriptionTree, nestedRanges, description);
    ranges.push(
      ...nestedRanges.map((nestedRange) => ({
        start: descriptionRange.start + nestedRange.start,
        end: descriptionRange.start + nestedRange.end,
      })),
    );
    return;
  }

  if (node.type === 'inlineMath') {
    const range = nodeRange(node);
    if (range && !isLooseInlineMath(node, markdown)) {
      ranges.push(range);
    } else if (range) {
      // 宽松公式会在修复命中时转回普通文字。remark-math 把公式正文折叠成
      // opaque 节点，必须按普通 Markdown 再解析一次，才能继续保护其中的
      // 代码、链接和 HTML，避免隐藏分隔符进入用户可见内容。
      const raw = markdown.slice(range.start, range.end);
      const proseTree = proseMarkdownParser.runSync(proseMarkdownParser.parse(raw), raw) as Root;
      const nestedRanges: OffsetRange[] = [];
      collectProtectedRanges(proseTree, nestedRanges, raw);
      ranges.push(
        ...nestedRanges.map((nestedRange) => ({
          start: range.start + nestedRange.start,
          end: range.start + nestedRange.end,
        })),
      );
    }
    return;
  }

  if (PROTECTED_NODE_TYPES.has(node.type)) {
    const range = nodeRange(node);
    if (range) ranges.push(range);
    return;
  }

  if (!('children' in node)) return;
  for (const child of node.children as Nodes[]) collectProtectedRanges(child, ranges, markdown);
}

function collectRecoveredTailLinkRanges(node: Nodes, ranges: OffsetRange[], markdown: string): void {
  if (!('children' in node)) return;
  const children = node.children as Nodes[];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const range = nodeRange(child);
    const recoveredTail = range ? recoveredAutolinkTailRange(child, range, markdown) : null;

    if (recoveredTail) {
      let cursor = recoveredTail.start;
      for (
        let tailIndex = index + 1;
        tailIndex < children.length && cursor < recoveredTail.end;
        tailIndex += 1
      ) {
        const tailNode = children[tailIndex];
        if (nodeRange(tailNode)) break;

        let value: string | null = null;
        let isLink = false;
        if (tailNode.type === 'text') {
          value = tailNode.value;
        } else if (tailNode.type === 'link') {
          const onlyChild = tailNode.children.length === 1 ? tailNode.children[0] : null;
          if (onlyChild?.type === 'text' && onlyChild.value === tailNode.url) {
            value = onlyChild.value;
            isLink = true;
          }
        }

        if (
          value === null ||
          cursor + value.length > recoveredTail.end ||
          !markdown.startsWith(value, cursor)
        ) {
          break;
        }
        if (isLink) ranges.push({ start: cursor, end: cursor + value.length });
        cursor += value.length;
      }
    }

    collectRecoveredTailLinkRanges(child, ranges, markdown);
  }
}

function expandedRecoveredTailRange(
  siblings: Nodes[],
  childIndex: number,
  recoveredTail: OffsetRange,
  markdown: string,
): OffsetRange {
  let cursor = recoveredTail.start;

  for (let index = childIndex + 1; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    // 普通 text 可能是当前裸链接被空格截断后的剩余源码；下一个带位置的 link
    // 已属于另一段裸链接，不能让每个尾段都重复解析后续所有链接。
    if (sibling.type === 'link' && nodeRange(sibling)) break;

    let value: string | null = null;
    if (sibling.type === 'text') {
      value = sibling.value;
    } else if (sibling.type === 'link') {
      const onlyChild = sibling.children.length === 1 ? sibling.children[0] : null;
      if (onlyChild?.type === 'text' && onlyChild.value === sibling.url) value = onlyChild.value;
    }

    if (value === null || !markdown.startsWith(value, cursor)) break;
    cursor += value.length;
  }

  return { start: recoveredTail.start, end: Math.max(recoveredTail.end, cursor) };
}

function collectRecoveredTailSyntaxRanges(
  node: Nodes,
  ranges: OffsetRange[],
  mathTailStarts: number[],
  looseMathRanges: OffsetRange[],
  imageDescriptionRanges: OffsetRange[],
  markdown: string,
): void {
  if (!('children' in node)) return;

  const children = node.children as Nodes[];
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const range = nodeRange(child);
    const initialRecoveredTail = range ? recoveredAutolinkTailRange(child, range, markdown) : null;
    const recoveredTail = initialRecoveredTail
      ? expandedRecoveredTailRange(children, childIndex, initialRecoveredTail, markdown)
      : null;

    if (recoveredTail) {
      const tail = markdown.slice(recoveredTail.start, recoveredTail.end);
      const tailTree = markdownParser.runSync(markdownParser.parse(tail), tail) as Root;
      const tailRanges: OffsetRange[] = [];
      collectProtectedRanges(tailTree, tailRanges, tail);
      imageDescriptionRanges.push(
        ...collectImageDescriptionRanges(tailTree, tail).map((descriptionRange) => ({
          start: recoveredTail.start + descriptionRange.start,
          end: recoveredTail.start + descriptionRange.end,
        })),
      );
      visit(tailTree, (tailNode) => {
        if (tailNode.type !== 'inlineMath' && tailNode.type !== 'math') return;
        const tailNodeRange = nodeRange(tailNode);
        if (!tailNodeRange) return;
        if (tailNode.type === 'inlineMath' && isLooseInlineMath(tailNode, tail)) {
          looseMathRanges.push({
            start: recoveredTail.start + tailNodeRange.start,
            end: recoveredTail.start + tailNodeRange.end,
          });
        }
        if (!POTENTIAL_BOUNDARY_RE.test(tail.slice(tailNodeRange.start, tailNodeRange.end))) return;
        mathTailStarts.push(recoveredTail.start);
      });
      ranges.push(
        ...tailRanges.map((tailRange) => ({
          start: recoveredTail.start + tailRange.start,
          end: recoveredTail.start + tailRange.end,
        })),
      );
    }

    collectRecoveredTailSyntaxRanges(
      child,
      ranges,
      mathTailStarts,
      looseMathRanges,
      imageDescriptionRanges,
      markdown,
    );
  }
}

function collectProjectDeepLinkRanges(markdown: string, range: OffsetRange): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const source = markdown.slice(range.start, range.end);
  const projectLinkPattern = new RegExp(PROJECT_DEEP_LINK_RE_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = projectLinkPattern.exec(source)) !== null) {
    const value = match[0].replace(/[.,;:!?]+$/, '');
    if (!parseProjectDeepLinkHref(value)) continue;
    const start = range.start + match.index;
    ranges.push({ start, end: start + value.length });
  }

  return ranges;
}

function mergeOffsetRanges(ranges: OffsetRange[]): OffsetRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: OffsetRange[] = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (range.start > previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }

  return merged;
}

function firstRangeEndingAfter(ranges: OffsetRange[], offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstOffsetAtOrAfter(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsets[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rangeContainsSpan(
  ranges: OffsetRange[],
  start: number,
  end: number,
): boolean {
  const range = ranges[firstRangeEndingAfter(ranges, start)];
  return range != null && range.start <= start && end <= range.end;
}

function rangeContainsAnyOffset(range: OffsetRange, sortedOffsets: number[]): boolean {
  const offsetIndex = firstOffsetAtOrAfter(sortedOffsets, range.start);
  return offsetIndex < sortedOffsets.length && sortedOffsets[offsetIndex] < range.end;
}

function collectPreservedTexDelimiterRanges(
  markdown: string,
  protectedRanges: OffsetRange[],
): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const openers: Array<{ offset: number; kind: '(' | '[' }> = [];
  const parenClosers: number[] = [];
  const bracketClosers: number[] = [];
  let scan = 0;
  let noParenCloser = false;
  let noBracketCloser = false;

  // 每段连续反斜杠只检查最后一个字符一次。奇数长度时最后一个反斜杠
  // 未被转义，偶数长度时被转义，避免对同一长序列反复向前计数。
  while (scan < markdown.length) {
    if (markdown[scan] !== '\\') {
      scan += 1;
      continue;
    }

    const runStart = scan;
    while (scan < markdown.length && markdown[scan] === '\\') scan += 1;
    if ((scan - runStart) % 2 === 0 || scan >= markdown.length) continue;

    const delimiterOffset = scan - 1;
    const protectedRange =
      protectedRanges[firstRangeEndingAfter(protectedRanges, delimiterOffset)];
    if (
      protectedRange &&
      protectedRange.start <= delimiterOffset &&
      delimiterOffset < protectedRange.end
    ) {
      continue;
    }

    const kind = markdown[scan];
    if (kind === '(' || kind === '[') openers.push({ offset: delimiterOffset, kind });
    else if (kind === ')') parenClosers.push(delimiterOffset);
    else if (kind === ']') bracketClosers.push(delimiterOffset);
  }

  scan = 0;
  for (const opener of openers) {
    if (opener.offset < scan) continue;
    const isDisplay = opener.kind === '[';
    if (isDisplay ? noBracketCloser : noParenCloser) continue;

    const closers = isDisplay ? bracketClosers : parenClosers;
    const closerIndex = firstOffsetAtOrAfter(closers, opener.offset + 2);
    const close = closers[closerIndex] ?? -1;
    if (close === -1) {
      if (isDisplay) noBracketCloser = true;
      else noParenCloser = true;
      continue;
    }

    ranges.push({ start: opener.offset, end: close + 2 });
    scan = close + 2;
  }

  return ranges;
}

function collectProseRanges(
  tree: Root,
  markdown: string,
  preservedTexDelimiterRanges: OffsetRange[],
): Array<{
  range: OffsetRange;
  protectedRanges: OffsetRange[];
  recoveredMathTailStarts: number[];
  recoveredLooseMathRanges: OffsetRange[];
  recoveredImageDescriptionRanges: OffsetRange[];
}> {
  const proseRanges: Array<{
    range: OffsetRange;
    protectedRanges: OffsetRange[];
    recoveredMathTailStarts: number[];
    recoveredLooseMathRanges: OffsetRange[];
    recoveredImageDescriptionRanges: OffsetRange[];
  }> = [];

  visit(tree, (node, _index, parent) => {
    const isProseRoot =
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      (node.type === 'tableCell' && parent?.type === 'tableRow');
    if (!isProseRoot) return;

    const range = nodeRange(node);
    if (!range) return;
    const protectedRanges: OffsetRange[] = [];
    const recoveredMathTailStarts: number[] = [];
    const recoveredLooseMathRanges: OffsetRange[] = [];
    const recoveredImageDescriptionRanges: OffsetRange[] = [];
    collectProtectedRanges(node, protectedRanges, markdown);
    // remarkTruncateCjkUrls 会把被首个裸链接误吞的尾段重新拆成文本和链接，
    // 尾段的 Markdown 语法没有原始解析节点，需要重新解析后补回保护范围；
    // 插件新生成的链接没有源码位置，再按实际字符位置补回其范围。
    collectRecoveredTailSyntaxRanges(
      node,
      protectedRanges,
      recoveredMathTailStarts,
      recoveredLooseMathRanges,
      recoveredImageDescriptionRanges,
      markdown,
    );
    collectRecoveredTailLinkRanges(node, protectedRanges, markdown);
    protectedRanges.push(...collectProjectDeepLinkRanges(markdown, range));
    // 保留的 TeX 区间按源码顺序收集。先定位首个可能重叠的区间，再只遍历
    // 当前段落实际覆盖的部分，避免每个段落都重新扫描整份文档的公式。
    const firstPreservedTexRange = firstRangeEndingAfter(
      preservedTexDelimiterRanges,
      range.start,
    );
    for (
      let index = firstPreservedTexRange;
      index < preservedTexDelimiterRanges.length &&
      preservedTexDelimiterRanges[index].start < range.end;
      index += 1
    ) {
      protectedRanges.push(preservedTexDelimiterRanges[index]);
    }
    proseRanges.push({
      range,
      protectedRanges: mergeOffsetRanges(protectedRanges),
      recoveredMathTailStarts,
      recoveredLooseMathRanges,
      recoveredImageDescriptionRanges,
    });
  });

  return proseRanges;
}

function collectRecoveredAutolinkTailRanges(tree: Root, markdown: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  visit(tree, 'link', (node) => {
    const range = nodeRange(node);
    if (!range) return;
    const recoveredTail = recoveredAutolinkTailRange(node, range, markdown);
    if (recoveredTail) ranges.push(recoveredTail);
  });
  return ranges;
}

function collectImageDescriptionRanges(tree: Root, markdown: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  visit(tree, (node) => {
    const range = imageDescriptionRange(node, markdown);
    if (range) ranges.push(range);
  });
  return ranges.sort((left, right) => left.start - right.start);
}

function collectLooseMathDelimiterOffsets(
  tree: Root,
  markdown: string,
  boundaryRepairs: BoundaryRepair[],
  recoveredLooseMathRanges: OffsetRange[],
): number[] {
  const offsets: number[] = [];
  const looseMathRanges = [...recoveredLooseMathRanges];
  visit(tree, 'inlineMath', (node) => {
    if (!isLooseInlineMath(node, markdown)) return;
    const range = nodeRange(node);
    if (range) looseMathRanges.push(range);
  });

  const repairOffsets = boundaryRepairs
    .map((repair) => repair.separatorOffset)
    .sort((left, right) => left - right);
  for (const range of looseMathRanges) {
    const repairIndex = firstOffsetAtOrAfter(repairOffsets, range.start + 1);
    if (repairIndex >= repairOffsets.length || repairOffsets[repairIndex] >= range.end) continue;

    for (let cursor = range.start; cursor < range.end && markdown[cursor] === '$'; cursor += 1) {
      offsets.push(cursor);
    }
    for (
      let cursor = range.end - 1;
      cursor >= range.start && markdown[cursor] === '$';
      cursor -= 1
    ) {
      offsets.push(cursor);
    }
  }
  return offsets;
}

function collectBoundaryRepairs(
  markdown: string,
  range: OffsetRange,
  protectedRanges: OffsetRange[],
  isolatedRanges: OffsetRange[],
): BoundaryRepair[] {
  const repairs: BoundaryRepair[] = [];
  let cursor = range.start;
  const openStrongStarts: number[] = [];
  let protectedIndex = 0;
  let isolatedIndex = firstRangeEndingAfter(isolatedRanges, range.start);
  let savedOuterStrongStarts: number[] | null = null;

  while (cursor < range.end) {
    let isolatedRange = isolatedRanges[isolatedIndex];
    while (isolatedRange && cursor >= isolatedRange.end) {
      if (savedOuterStrongStarts) {
        openStrongStarts.splice(0, openStrongStarts.length, ...savedOuterStrongStarts);
        savedOuterStrongStarts = null;
      }
      isolatedIndex += 1;
      isolatedRange = isolatedRanges[isolatedIndex];
    }
    if (isolatedRange && cursor === isolatedRange.start) {
      // 图片说明的加粗标记只在说明内部配对，不能继承外层正文的未闭合状态。
      savedOuterStrongStarts = [...openStrongStarts];
      openStrongStarts.length = 0;
    }

    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && cursor >= protectedRange.end) {
      protectedIndex += 1;
      continue;
    }
    if (protectedRange && cursor >= protectedRange.start) {
      cursor = protectedRange.end;
      protectedIndex += 1;
      continue;
    }

    if (markdown[cursor] !== '*') {
      cursor += 1;
      continue;
    }

    let runEnd = cursor + 1;
    while (runEnd < range.end && markdown[runEnd] === '*') runEnd += 1;
    const runLength = runEnd - cursor;

    if (isEscaped(markdown, cursor) || runLength === 1) {
      cursor = runEnd;
      continue;
    }

    // `***` 及更长序列使用另一套配对规则。这里不猜测其意图，同时清掉
    // 当前配对状态，避免后续双星号跨过不支持的序列发生误配。
    if (runLength > 2) {
      openStrongStarts.length = 0;
      cursor = runEnd;
      continue;
    }

    const before = classifyCharacter(characterBefore(markdown, cursor));
    const after = classifyCharacter(characterAfter(markdown, runEnd));
    const canOpen = after !== 'whitespace' && (after !== 'punctuation' || before !== 'other');
    const canClose = before !== 'whitespace' && (before !== 'punctuation' || after !== 'other');

    if (canClose && openStrongStarts.length > 0) {
      openStrongStarts.pop();
    } else if (
      before === 'punctuation' &&
      after === 'other' &&
      openStrongStarts.length > 0
    ) {
      const openerStart = openStrongStarts.pop();
      if (openerStart != null) {
        repairs.push({ openerStart, closerStart: cursor, separatorOffset: runEnd });
      }
    } else if (canOpen) {
      openStrongStarts.push(cursor);
    }

    cursor = runEnd;
  }

  return repairs;
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  if (edits.length === 0) return markdown;

  const chunks: string[] = [];
  let cursor = markdown.length;
  const sortedEdits = [...edits].sort((left, right) => right.offset - left.offset);
  for (const edit of sortedEdits) {
    chunks.push(markdown.slice(edit.offset + edit.deleteCount, cursor), edit.value);
    cursor = edit.offset;
  }
  chunks.push(markdown.slice(0, cursor));
  return chunks.reverse().join('');
}

/**
 * 让“以标点结束、后面紧接正文”的加粗片段能被解析，同时不改变可见
 * 消息、链接、公式、原始 HTML 和代码示例。
 */
export function normalizeStrongDelimiterBoundaries(
  markdown: string,
  options: NormalizeStrongDelimiterBoundariesOptions = {},
): string {
  if (!markdown.includes('**') || !POTENTIAL_BOUNDARY_RE.test(markdown)) return markdown;

  const tree = markdownParser.runSync(markdownParser.parse(markdown), markdown) as Root;
  const preservedTexDelimiterRanges: OffsetRange[] = [];
  if (options.preserveTexDelimiters) {
    const protectedSyntaxRanges: OffsetRange[] = [];
    collectProtectedRanges(tree, protectedSyntaxRanges, markdown);
    preservedTexDelimiterRanges.push(
      ...collectPreservedTexDelimiterRanges(markdown, mergeOffsetRanges(protectedSyntaxRanges)),
    );
  }
  const proseRanges = collectProseRanges(tree, markdown, preservedTexDelimiterRanges);
  const recoveredImageDescriptionRanges = proseRanges.flatMap(
    ({ recoveredImageDescriptionRanges: ranges }) => ranges,
  );
  const imageDescriptionRanges = mergeOffsetRanges([
    ...collectImageDescriptionRanges(tree, markdown),
    ...recoveredImageDescriptionRanges,
  ]);
  const boundaryRepairs = proseRanges.flatMap(({ range, protectedRanges }) =>
    collectBoundaryRepairs(markdown, range, protectedRanges, imageDescriptionRanges),
  );
  const boundaryInsertions = boundaryRepairs.map((repair) => repair.separatorOffset);
  const recoveredMathTailStarts = proseRanges.flatMap(
    ({ recoveredMathTailStarts: starts }) => starts,
  );
  const recoveredLooseMathRanges = proseRanges.flatMap(
    ({ recoveredLooseMathRanges: ranges }) => ranges,
  );
  if (boundaryInsertions.length === 0 && recoveredMathTailStarts.length === 0) return markdown;

  // 后续 remark 插件会把裸链接误吞的中文尾段切回 text 节点，但此时 Markdown
  // 已经解析完成，尾段里的星号不会再次解析。在需要修复的尾段起点再插入同一个
  // 隐藏分隔符，让首次解析时链接先结束，尾段即可按正文解析。
  const sortedBoundaryInsertions = [...boundaryInsertions].sort((left, right) => left - right);
  const recoveredTailStarts = collectRecoveredAutolinkTailRanges(tree, markdown)
    .filter((range) => rangeContainsAnyOffset(range, sortedBoundaryInsertions))
    .map((range) => range.start);
  const insertions = [
    ...new Set([...boundaryInsertions, ...recoveredTailStarts, ...recoveredMathTailStarts]),
  ];
  const looseMathDelimiterOffsets = collectLooseMathDelimiterOffsets(
    tree,
    markdown,
    boundaryRepairs,
    recoveredLooseMathRanges,
  );
  const imageRepairs = boundaryRepairs.filter((repair) =>
    rangeContainsSpan(
      imageDescriptionRanges,
      repair.openerStart,
      repair.separatorOffset,
    ),
  );
  const imageRepairOffsets = new Set(imageRepairs.map((repair) => repair.separatorOffset));

  const edits: MarkdownEdit[] = [
    ...insertions
      .filter((offset) => !imageRepairOffsets.has(offset))
      .map((offset) => ({ offset, deleteCount: 0, value: HIDDEN_SEPARATOR })),
    ...looseMathDelimiterOffsets.map((offset) => ({ offset, deleteCount: 0, value: '\\' })),
    ...imageRepairs.flatMap((repair) => [
      { offset: repair.openerStart, deleteCount: 2, value: '' },
      { offset: repair.closerStart, deleteCount: 2, value: '' },
    ]),
  ];
  return applyMarkdownEdits(markdown, edits);
}
