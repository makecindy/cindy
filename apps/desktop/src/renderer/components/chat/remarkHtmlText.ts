/**
 * Preserve HTML-block prose without enabling HTML rendering (#10888).
 * parse5 builds an inert tree: no DOM, resource loading, CSS or script execution.
 * Only text, paragraph boundaries and explicit line breaks survive; attributes
 * never become Markdown links/images or React properties. Run last, after image,
 * path and session-link transforms, so recovered prose stays inert.
 */
import type { Html, PhrasingContent, Root, RootContent } from 'mdast';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { Plugin } from 'unified';
import type { Point } from 'unist';
import { visit } from 'unist-util-visit';

const OMITTED = new Set('script style iframe object embed template noscript svg math head'.split(' '));
const BLOCKS = new Set(
  'address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody tfoot thead tr ul'.split(' '),
);

type HtmlNode = DefaultTreeAdapterTypes.Node;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** HTML values omit Markdown container prefixes (quotes/list indentation).
 * Match each value line to its original source line once, not per paragraph. */
function sourcePoints(node: Html, source: string, documentLines: number[]) {
  const lines = lineStarts(node.value);
  const origins = lines.map((start, index) => {
    const line = (node.position?.start.line ?? 1) + index;
    const originalStart = documentLines[line - 1];
    const originalEnd = documentLines[line] ?? source.length;
    const valueEnd = lines[index + 1] ?? node.value.length;
    const valueLine = node.value.slice(start, valueEnd).replace(/[\r\n]+$/, '');
    const originalLine = source.slice(originalStart, originalEnd).replace(/[\r\n]+$/, '');
    const firstColumn = index === 0 ? (node.position?.start.column ?? 1) - 1 : 0;
    let column = originalStart == null ? -1 : originalLine.indexOf(valueLine, firstColumn);
    // Some Markdown HTML values retain indentation before position.start.
    if (column < 0 && originalStart != null) column = originalLine.indexOf(valueLine);
    if (column < 0) column = firstColumn;
    return { line, column, offset: originalStart == null ? undefined : originalStart + column };
  });
  return (offset: number): Point => {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle] <= offset) low = middle;
      else high = middle;
    }
    const origin = origins[low];
    const delta = offset - lines[low];
    return {
      line: origin.line,
      column: origin.column + delta + 1,
      offset: origin.offset == null ? undefined : origin.offset + delta,
    };
  };
}

function htmlText(
  node: Html,
  inline: boolean,
  point?: (offset: number) => Point,
): RootContent[] | PhrasingContent[] {
  const blocks: RootContent[] = [];
  let children: PhrasingContent[] = [];
  let hasText = false;
  let boundaryStart: number | undefined;
  let start: number | undefined;
  let end: number | undefined;
  const flush = () => {
    if (hasText) {
      blocks.push({
        type: 'paragraph',
        children,
        position: point && start != null && end != null ? { start: point(start), end: point(end) } : undefined,
      });
    }
    children = [];
    hasText = false;
    boundaryStart = start = end = undefined;
  };
  // Iterative traversal also handles deeply nested untrusted containers without
  // growing the JavaScript call stack. Exit frames preserve block boundaries.
  const stack: { node: HtmlNode; exit?: boolean }[] = [
    { node: parseFragment(node.value, { sourceCodeLocationInfo: !inline }) },
  ];
  while (stack.length) {
    const frame = stack.pop()!;
    const current = frame.node;
    if ('tagName' in current) {
      if (OMITTED.has(current.tagName)) continue;
      const boundary = BLOCKS.has(current.tagName);
      if (frame.exit) {
        if (boundary && !inline) flush();
        continue;
      }
      if (boundary && !inline) {
        flush();
        boundaryStart = current.sourceCodeLocation?.startOffset;
      }
      if (current.tagName === 'br' || (boundary && inline)) {
        children.push({ type: 'break' });
      }
      if ((current.tagName === 'td' || current.tagName === 'th') && hasText) {
        children.push({ type: 'text', value: ' | ' });
      }
      if (boundary && !inline) stack.push({ node: current, exit: true });
    }
    if (current.nodeName === '#text' && 'value' in current) {
      children.push({ type: 'text', value: current.value });
      if (current.value.trim()) {
        hasText = true;
        const location = current.sourceCodeLocation;
        if (location) {
          const leading = node.value.slice(location.startOffset, location.endOffset).search(/\S/);
          start ??= boundaryStart ?? location.startOffset + Math.max(0, leading);
          end = Math.max(end ?? 0, location.endOffset);
        }
      }
    }
    if ('childNodes' in current) {
      for (let index = current.childNodes.length - 1; index >= 0; index--) {
        stack.push({ node: current.childNodes[index] });
      }
    }
  }
  if (inline) return children;
  flush();
  return blocks;
}

const remarkHtmlText: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  let documentLines: number[] | undefined;
  visit(tree, (parent) => {
    if (!('children' in parent)) return;
    let next: RootContent[] | undefined;
    const children = parent.children;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type !== 'html') {
        next?.push(child);
        continue;
      }
      next ??= children.slice(0, index);
      const inline = parent.type === 'paragraph' || parent.type === 'heading' ||
        parent.type === 'tableCell' || parent.type === 'emphasis' ||
        parent.type === 'strong' || parent.type === 'delete' ||
        parent.type === 'link' || parent.type === 'linkReference';
      const point = !inline && child.position
        ? sourcePoints(child, source, documentLines ??= lineStarts(source))
        : undefined;
      const replacement = htmlText(child, inline, point);
      for (const node of replacement) next.push(node);
    }
    // Rebuild each affected parent's array once: no variadic argument limit and
    // no repeated suffix copies when siblings contain multiple HTML nodes.
    if (next) parent.children = next as typeof parent.children;
  });
};

export default remarkHtmlText;
