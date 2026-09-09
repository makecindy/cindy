/**
 * remarkTruncateCjkUrls — 把 GFM autolink literal 误吞的 CJK / 全角字符 /
 * 引号 / 未配对括号说明从 url 里切回去。
 *
 * 背景：remark-gfm 的 autolink literal 走 GFM spec，规则在 domain 段会按
 * Unicode punctuation 截断，但进入 path 段后就只判 EOL/EOF/whitespace，导致
 * 中文场景下「裸 URL + 中文标点」会把后面的中文一起当成 URL 路径吃进去：
 *
 *   `https://x.com/foo/93（含说明）` → href: `https://x.com/foo/93（含说明）`
 *
 * 用户点击 → 404。Spec 是 GFM 故意的（GitHub 行为），上游不会改，所以我们
 * 在 ast 层后处理一刀：扫描 link 节点，url 命中 CJK / 全角范围就在那里切断，
 * 把切掉的尾巴作为 text 节点放回 link 后面，保持 visible text 与 href 一致。
 *
 * 切边规则在 `@cindy/maker-shared/url-text-boundary`：本插件只负责认出
 * GFM autolink literal、把尾巴拆回 text，并在 query 后补回被拆开的括号。
 *
 * 仅处理「children 只有一个 text 且 value === url」这种 autolink literal 形态；
 * 显式 `[text](url)` / `<https://...>` 因为 parser 自带闭合括号/尖括号边界，
 * 本身没有这个 bug，不动。
 */

import type { Plugin } from 'unified';
import type { Root, Link, Text, PhrasingContent } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

import {
  clipBareHttpAutolink,
  markdownWrapMarkerFromPrefix,
} from '@cindy/maker-shared/url-text-boundary';
import { findLinkifyMatches } from './userMessageLinkify';

function hasSamePosition(a: Link, b: Text): boolean {
  return (
    a.position?.start.offset != null &&
    a.position?.end.offset != null &&
    b.position?.start.offset === a.position.start.offset &&
    b.position?.end.offset === a.position.end.offset
  );
}

function textFromPhrasingContent(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if ('children' in node) {
    return node.children.map((child) => textFromPhrasingContent(child)).join('');
  }
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  return '';
}

function textBeforeAutolink(siblings: PhrasingContent[], index: number): string {
  return siblings.slice(0, index).map((node) => textFromPhrasingContent(node)).join('');
}

const remarkTruncateCjkUrls: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'link', (node: Link, index, parent) => {
      if (!parent || index == null) return;

      const onlyChild = node.children.length === 1 ? node.children[0] : null;
      if (!onlyChild || onlyChild.type !== 'text' || onlyChild.value !== node.url) {
        return;
      }
      const isAutolinkLiteral = hasSamePosition(node, onlyChild);
      if (!isAutolinkLiteral) {
        return;
      }

      mergeBalancedQueryBracketTail(
        node,
        onlyChild,
        parent.children as PhrasingContent[],
        index,
      );
      const prev = parent.children[index - 1];
      const prevText = prev?.type === 'text' ? (prev as Text).value : null;
      const prefixText = textBeforeAutolink(parent.children as PhrasingContent[], index);
      const cut = clipBareHttpAutolink(node.url, {
        prefix: prefixText,
        markdownWrapMarker: markdownWrapMarkerFromPrefix(prevText),
        stripMarkdownFormattingPunct: 'auto',
      });
      if (cut === node.url.length) return;
      if (cut === 0) return;
      const head = node.url.slice(0, cut);
      const tail = node.url.slice(cut);

      node.url = head;
      (onlyChild as Text).value = head;

      const tailNodes = linkifyTailUrls(tail);
      parent.children.splice(index + 1, 0, ...tailNodes);

      return [SKIP, index + 1 + tailNodes.length];
    });
  };
};

export default remarkTruncateCjkUrls;

function linkifyTailUrls(tail: string): PhrasingContent[] {
  const matches = findLinkifyMatches(tail).filter((match) => match.kind === 'url');
  if (matches.length === 0) {
    return [{ type: 'text', value: tail }];
  }

  const nodes: PhrasingContent[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      nodes.push({ type: 'text', value: tail.slice(cursor, match.index) });
    }
    const text: Text = { type: 'text', value: match.text };
    nodes.push({ type: 'link', url: match.text, children: [text] });
    cursor = match.index + match.length;
  }
  if (cursor < tail.length) {
    nodes.push({ type: 'text', value: tail.slice(cursor) });
  }
  return nodes;
}

function mergeBalancedQueryBracketTail(
  node: Link,
  onlyChild: Text,
  siblings: PhrasingContent[],
  index: number,
): void {
  const next = siblings[index + 1];
  if (!next || next.type !== 'text') return;

  const queryOrHashIndex = node.url.search(/[?#]/);
  if (queryOrHashIndex < 0) return;

  let expectedCloser = expectedQueryBracketCloser(node.url.slice(queryOrHashIndex));
  if (!expectedCloser) return;

  let consumed = '';
  while (expectedCloser && next.value.startsWith(expectedCloser)) {
    consumed += expectedCloser;
    next.value = next.value.slice(expectedCloser.length);
    expectedCloser = expectedQueryBracketCloser(`${node.url.slice(queryOrHashIndex)}${consumed}`);
  }
  if (!consumed) return;

  node.url += consumed;
  onlyChild.value += consumed;
  if (next.value.length === 0) {
    siblings.splice(index + 1, 1);
  }
}

function expectedQueryBracketCloser(queryText: string): ']' | '}' | null {
  const stack: Array<']' | '}'> = [];
  for (const ch of queryText) {
    if (ch === '[') {
      stack.push(']');
      continue;
    }
    if (ch === '{') {
      stack.push('}');
      continue;
    }
    if (ch !== ']' && ch !== '}') continue;
    if (stack[stack.length - 1] === ch) {
      stack.pop();
    }
  }
  return stack.at(-1) ?? null;
}
