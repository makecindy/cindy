import type { Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { richAnswerText } from '@cindy/maker-shared/rich-answer';

import { htmlImgToImageNode } from './htmlImage';

const previewParser = unified().use(remarkParse).use(remarkGfm);

/** Extract readable text without HTML output or link destinations. */
export function markdownPreviewText(
  markdown: string,
  options: { includeImageAlt?: boolean; imageFallback?: string } = {},
): string {
  return markdownTextPreview(richAnswerText(markdown), options);
}

/** Project already-extracted Markdown; fenced examples are literal code. */
export function markdownTextPreview(
  markdown: string,
  options: { includeImageAlt?: boolean; imageFallback?: string } = {},
): string {
  return projectMarkdownPreview(markdown, options).text;
}

/** Streaming already-extracted Markdown: recognize an unfinished destination.
 * Synthetic closers never enter the source or final projection, and code nodes
 * remain code. The flag lets a stream skip parsing ordinary URL characters. */
export function streamingMarkdownPreviewText(markdown: string): { text: string; pendingLink: boolean } {
  return projectMarkdownPreview(markdown, {}, true);
}

function projectMarkdownPreview(
  markdown: string,
  options: { includeImageAlt?: boolean; imageFallback?: string },
  streaming = false,
): { text: string; pendingLink: boolean } {
  // Marked's link regex can backtrack for minutes on short bracketed code spans.
  // These previews run on Main after DB replies, so use the existing remark parser.
  const source = markdown;
  let root = previewParser.parse(source);
  let pendingLink = false;
  if (streaming && source.includes('](')) {
    // Parenthesized/angle destinations and optional quoted titles use the same
    // parser, rather than a second Markdown grammar in the stream accumulator.
    for (const closing of [')'.repeat(32), '>)', '")', "')"]) {
      const continued = previewParser.parse(source + closing);
      const candidates: Nodes[] = [continued];
      while (candidates.length > 0) {
        const node = candidates.pop()!;
        if ((node.type === 'link' || node.type === 'image')
          && (node.position?.start.offset ?? source.length) < source.length
          && (node.position?.end.offset ?? 0) > source.length) {
          root = continued;
          pendingLink = true;
          break;
        }
        if ('children' in node) {
          for (const child of node.children) candidates.push(child);
        }
      }
      if (pendingLink) break;
    }
  }
  const stack: Array<Nodes | string> = [root];
  const parts: string[] = [];
  const includeImageAlt = options.includeImageAlt !== false;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    // Ignore the unused synthetic closing characters after the recovered link.
    if (pendingLink && (node.position?.start.offset ?? 0) >= source.length) continue;
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
        if (includeImageAlt) parts.push(node.alt?.trim() || options.imageFallback || '');
        break;
      case 'html':
        if (includeImageAlt) {
          const image = htmlImgToImageNode(node);
          if (image) parts.push(image.alt?.trim() || options.imageFallback || '', ' ');
        }
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
  return { text: parts.join('').replace(/\s+/gu, ' ').trim(), pendingLink };
}
