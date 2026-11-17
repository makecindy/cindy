/**
 * Preserve HTML-block prose without enabling HTML rendering (#10888).
 * parse5 builds an inert tree: no DOM, resource loading, CSS or script execution.
 * Only text, paragraph boundaries and explicit line breaks survive; attributes
 * never become Markdown links/images or React properties. Run after
 * remarkHtmlImages so its existing safe single-image behavior stays unchanged.
 */
import type { Html, PhrasingContent, Root, RootContent } from 'mdast';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import type { Plugin } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

const OMITTED = new Set('script style iframe object embed template noscript svg math head'.split(' '));
const BLOCKS = new Set(
  'address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody tfoot thead tr ul'.split(' '),
);

type HtmlNode = DefaultTreeAdapterTypes.Node;

function htmlText(node: Html, inline: boolean): RootContent[] | PhrasingContent[] {
  const blocks: RootContent[] = [];
  let children: PhrasingContent[] = [];
  const flush = () => {
    if (children.some(child => child.type === 'text' && child.value.trim())) {
      blocks.push({ type: 'paragraph', children, position: node.position });
    }
    children = [];
  };
  // Iterative traversal also handles deeply nested untrusted containers without
  // growing the JavaScript call stack. Exit frames preserve block boundaries.
  const stack: { node: HtmlNode; exit?: boolean }[] = [
    { node: parseFragment(node.value) },
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
      if (boundary && !inline) flush();
      if (current.tagName === 'br' || (boundary && inline)) {
        children.push({ type: 'break' });
      }
      if ((current.tagName === 'td' || current.tagName === 'th') && children.some(child => child.type === 'text' && child.value.trim())) {
        children.push({ type: 'text', value: ' | ' });
      }
      if (boundary && !inline) stack.push({ node: current, exit: true });
    }
    if (current.nodeName === '#text' && 'value' in current) {
      children.push({ type: 'text', value: current.value });
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

const remarkHtmlText: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'html', (node: Html, index, parent) => {
    if (!parent || index == null) return;
    const inline = parent.type === 'paragraph' || parent.type === 'heading' ||
      parent.type === 'tableCell' || parent.type === 'emphasis' ||
      parent.type === 'strong' || parent.type === 'delete' || parent.type === 'link';
    const replacement = htmlText(node, inline);
    parent.children.splice(index, 1, ...replacement);
    return [SKIP, index + replacement.length];
  });
};

export default remarkHtmlText;
