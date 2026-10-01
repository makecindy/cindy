import type { Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { htmlImgToImageNode } from './htmlImage';

const previewParser = unified().use(remarkParse).use(remarkGfm);

/** Extract readable text without HTML output or link destinations. */
export function markdownPreviewText(
  markdown: string,
  options: { includeImageAlt?: boolean } = {},
): string {
  // Marked's link regex can backtrack for minutes on short bracketed code spans.
  // These previews run on Main after DB replies, so use the existing remark parser.
  const stack: Array<Nodes | string> = [previewParser.parse(markdown)];
  const parts: string[] = [];
  const includeImageAlt = options.includeImageAlt !== false;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        parts.push(node.value);
        break;
      case 'code':
        parts.push(' ', node.value, ' ');
        break;
      case 'image':
      case 'imageReference':
        if (includeImageAlt) parts.push(node.alt ?? '');
        break;
      case 'html':
        if (includeImageAlt) parts.push(htmlImgToImageNode(node)?.alt ?? '', ' ');
        break;
      case 'definition':
        break;
      case 'break':
      case 'thematicBreak':
        parts.push(' ');
        break;
      default:
        if ('children' in node) {
          const block = node.type !== 'emphasis' && node.type !== 'strong'
            && node.type !== 'delete' && node.type !== 'link' && node.type !== 'linkReference';
          if (block) {
            parts.push(' ');
            stack.push(' ');
          }
          for (let index = node.children.length - 1; index >= 0; index--) {
            stack.push(node.children[index]);
          }
        }
    }
  }
  return parts.join('').replace(/\s+/gu, ' ').trim();
}
