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
  `[\\p{P}${ASCII_PUNCTUATION}]\\*\\*[^\\s\\p{P}${ASCII_PUNCTUATION}]`,
  'u',
);
const UNICODE_WHITESPACE_RE = /^\s$/u;
const UNICODE_PUNCTUATION_RE = new RegExp(`^[\\p{P}${ASCII_PUNCTUATION}]$`, 'u');
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

function imageDescriptionRange(node: Nodes, markdown: string): OffsetRange | null {
  if (node.type !== 'image' && node.type !== 'imageReference') return null;
  const range = nodeRange(node);
  if (!range || markdown.slice(range.start, range.start + 2) !== '![') return null;

  let nestedBrackets = 0;
  for (let cursor = range.start + 2; cursor < range.end; cursor += 1) {
    if (isEscaped(markdown, cursor)) continue;
    if (markdown[cursor] === '[') {
      nestedBrackets += 1;
      continue;
    }
    if (markdown[cursor] !== ']') continue;
    if (nestedBrackets > 0) {
      nestedBrackets -= 1;
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

function collectRecoveredTailSyntaxRanges(
  node: Nodes,
  ranges: OffsetRange[],
  mathTailStarts: number[],
  markdown: string,
): void {
  if (!('children' in node)) return;

  for (const child of node.children as Nodes[]) {
    const range = nodeRange(child);
    const recoveredTail = range ? recoveredAutolinkTailRange(child, range, markdown) : null;

    if (recoveredTail) {
      const tail = markdown.slice(recoveredTail.start, recoveredTail.end);
      const tailTree = markdownParser.runSync(markdownParser.parse(tail), tail) as Root;
      const tailRanges: OffsetRange[] = [];
      collectProtectedRanges(tailTree, tailRanges, tail);
      visit(tailTree, (tailNode) => {
        if (tailNode.type !== 'inlineMath' && tailNode.type !== 'math') return;
        const tailNodeRange = nodeRange(tailNode);
        if (
          tailNodeRange &&
          POTENTIAL_BOUNDARY_RE.test(tail.slice(tailNodeRange.start, tailNodeRange.end))
        ) {
          mathTailStarts.push(recoveredTail.start);
        }
      });
      ranges.push(
        ...tailRanges.map((tailRange) => ({
          start: recoveredTail.start + tailRange.start,
          end: recoveredTail.start + tailRange.end,
        })),
      );
    }

    collectRecoveredTailSyntaxRanges(child, ranges, mathTailStarts, markdown);
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

function findUnprotectedDelimiter(
  markdown: string,
  delimiter: string,
  start: number,
  protectedRanges: OffsetRange[],
): number {
  let scan = start;

  while (scan < markdown.length) {
    const offset = markdown.indexOf(delimiter, scan);
    if (offset === -1) return -1;
    const rangeIndex = firstRangeEndingAfter(protectedRanges, offset);
    const protectedRange = protectedRanges[rangeIndex];
    if (!protectedRange || offset < protectedRange.start) return offset;
    scan = protectedRange.end;
  }

  return -1;
}

function collectPreservedTexDelimiterRanges(
  markdown: string,
  protectedRanges: OffsetRange[],
): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let scan = 0;
  let noParenCloser = false;
  let noBracketCloser = false;

  while (scan < markdown.length) {
    const open = findUnprotectedDelimiter(markdown, '\\', scan, protectedRanges);
    if (open === -1 || open + 1 >= markdown.length) break;
    const kind = markdown[open + 1];
    if (kind !== '(' && kind !== '[') {
      scan = open + 1;
      continue;
    }

    const isDisplay = kind === '[';
    if (isDisplay ? noBracketCloser : noParenCloser) {
      scan = open + 2;
      continue;
    }
    const closer = kind === '[' ? '\\]' : '\\)';
    const close = findUnprotectedDelimiter(markdown, closer, open + 2, protectedRanges);
    if (close === -1) {
      if (isDisplay) noBracketCloser = true;
      else noParenCloser = true;
      scan = open + 2;
      continue;
    }

    ranges.push({ start: open, end: close + 2 });
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
}> {
  const proseRanges: Array<{
    range: OffsetRange;
    protectedRanges: OffsetRange[];
    recoveredMathTailStarts: number[];
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
    collectProtectedRanges(node, protectedRanges, markdown);
    // remarkTruncateCjkUrls 会把被首个裸链接误吞的尾段重新拆成文本和链接，
    // 尾段的 Markdown 语法没有原始解析节点，需要重新解析后补回保护范围；
    // 插件新生成的链接没有源码位置，再按实际字符位置补回其范围。
    collectRecoveredTailSyntaxRanges(node, protectedRanges, recoveredMathTailStarts, markdown);
    collectRecoveredTailLinkRanges(node, protectedRanges, markdown);
    protectedRanges.push(...collectProjectDeepLinkRanges(markdown, range));
    protectedRanges.push(
      ...preservedTexDelimiterRanges.filter(
        (protectedRange) => protectedRange.start < range.end && protectedRange.end > range.start,
      ),
    );
    proseRanges.push({
      range,
      protectedRanges: mergeOffsetRanges(protectedRanges),
      recoveredMathTailStarts,
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
  return ranges;
}

function collectLooseMathDelimiterOffsets(
  tree: Root,
  markdown: string,
  boundaryRepairs: BoundaryRepair[],
): number[] {
  const offsets: number[] = [];
  visit(tree, 'inlineMath', (node) => {
    if (!isLooseInlineMath(node, markdown)) return;
    const range = nodeRange(node);
    if (
      !range ||
      !boundaryRepairs.some(
        (repair) =>
          repair.separatorOffset > range.start && repair.separatorOffset < range.end,
      )
    ) {
      return;
    }

    for (let cursor = range.start; cursor < range.end && markdown[cursor] === '$'; cursor += 1) {
      offsets.push(cursor);
    }
    for (let cursor = range.end - 1; cursor >= range.start && markdown[cursor] === '$'; cursor -= 1) {
      offsets.push(cursor);
    }
  });
  return offsets;
}

function collectBoundaryRepairs(
  markdown: string,
  range: OffsetRange,
  protectedRanges: OffsetRange[],
): BoundaryRepair[] {
  const repairs: BoundaryRepair[] = [];
  let cursor = range.start;
  const openStrongStarts: number[] = [];
  let protectedIndex = 0;

  while (cursor < range.end) {
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
  const boundaryRepairs = proseRanges.flatMap(({ range, protectedRanges }) =>
    collectBoundaryRepairs(markdown, range, protectedRanges),
  );
  const boundaryInsertions = boundaryRepairs.map((repair) => repair.separatorOffset);
  const recoveredMathTailStarts = proseRanges.flatMap(
    ({ recoveredMathTailStarts: starts }) => starts,
  );
  if (boundaryInsertions.length === 0 && recoveredMathTailStarts.length === 0) return markdown;

  // 后续 remark 插件会把裸链接误吞的中文尾段切回 text 节点，但此时 Markdown
  // 已经解析完成，尾段里的星号不会再次解析。在需要修复的尾段起点再插入同一个
  // 隐藏分隔符，让首次解析时链接先结束，尾段即可按正文解析。
  const recoveredTailStarts = collectRecoveredAutolinkTailRanges(tree, markdown)
    .filter((range) =>
      boundaryInsertions.some((insertion) => insertion >= range.start && insertion < range.end),
    )
    .map((range) => range.start);
  const insertions = [
    ...new Set([...boundaryInsertions, ...recoveredTailStarts, ...recoveredMathTailStarts]),
  ];
  const looseMathDelimiterOffsets = collectLooseMathDelimiterOffsets(
    tree,
    markdown,
    boundaryRepairs,
  );
  const imageDescriptionRanges = collectImageDescriptionRanges(tree, markdown);
  const imageRepairs = boundaryRepairs.filter((repair) =>
    imageDescriptionRanges.some(
      (range) =>
        repair.openerStart >= range.start && repair.separatorOffset <= range.end,
    ),
  );
  const imageRepairOffsets = new Set(imageRepairs.map((repair) => repair.separatorOffset));

  let output = markdown;
  const edits = [
    ...insertions
      .filter((offset) => !imageRepairOffsets.has(offset))
      .map((offset) => ({ offset, deleteCount: 0, value: HIDDEN_SEPARATOR })),
    ...looseMathDelimiterOffsets.map((offset) => ({ offset, deleteCount: 0, value: '\\' })),
    ...imageRepairs.flatMap((repair) => [
      { offset: repair.openerStart, deleteCount: 2, value: '' },
      { offset: repair.closerStart, deleteCount: 2, value: '' },
    ]),
  ];
  for (const edit of edits.sort((left, right) => right.offset - left.offset)) {
    output = `${output.slice(0, edit.offset)}${edit.value}${output.slice(
      edit.offset + edit.deleteCount,
    )}`;
  }
  return output;
}
