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
  'image',
  'imageReference',
  'inlineCode',
  'inlineMath',
  'math',
]);
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkTruncateCjkUrls);

interface OffsetRange {
  start: number;
  end: number;
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

  const tailStart = range.start + onlyChild.value.length;
  return tailStart < range.end ? { start: tailStart, end: range.end } : null;
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

function collectPreservedTexDelimiterRanges(markdown: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let scan = 0;
  let noParenCloser = false;
  let noBracketCloser = false;

  while (scan < markdown.length) {
    const open = markdown.indexOf('\\', scan);
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
    const close = markdown.indexOf(closer, open + 2);
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
    protectedRanges.sort((left, right) => left.start - right.start);
    proseRanges.push({ range, protectedRanges, recoveredMathTailStarts });
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

function collectBoundaryInsertions(
  markdown: string,
  range: OffsetRange,
  protectedRanges: OffsetRange[],
): number[] {
  const insertions: number[] = [];
  let cursor = range.start;
  let openStrongCount = 0;
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
      openStrongCount = 0;
      cursor = runEnd;
      continue;
    }

    const before = classifyCharacter(characterBefore(markdown, cursor));
    const after = classifyCharacter(characterAfter(markdown, runEnd));
    const canOpen = after !== 'whitespace' && (after !== 'punctuation' || before !== 'other');
    const canClose = before !== 'whitespace' && (before !== 'punctuation' || after !== 'other');

    if (canClose && openStrongCount > 0) {
      openStrongCount -= 1;
    } else if (before === 'punctuation' && after === 'other' && openStrongCount > 0) {
      openStrongCount -= 1;
      insertions.push(runEnd);
    } else if (canOpen) {
      openStrongCount += 1;
    }

    cursor = runEnd;
  }

  return insertions;
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
  const preservedTexDelimiterRanges = options.preserveTexDelimiters
    ? collectPreservedTexDelimiterRanges(markdown)
    : [];
  const proseRanges = collectProseRanges(tree, markdown, preservedTexDelimiterRanges);
  const boundaryInsertions = proseRanges.flatMap(({ range, protectedRanges }) =>
    collectBoundaryInsertions(markdown, range, protectedRanges),
  );
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

  let output = markdown;
  for (const offset of insertions.sort((left, right) => right - left)) {
    output = `${output.slice(0, offset)}${HIDDEN_SEPARATOR}${output.slice(offset)}`;
  }
  return output;
}
