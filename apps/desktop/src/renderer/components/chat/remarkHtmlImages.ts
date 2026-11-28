/**
 * Convert safe raw HTML <img> tags (and image-only <p><img .../></p> blocks)
 * into mdast image nodes.
 *
 * react-markdown intentionally runs with skipHtml, but model replies and
 * READMEs often use `<img src="..." width="150">` or `<p align="center"><img .../></p>`.
 * Transforming only single img tags and image-only paragraphs keeps arbitrary
 * HTML disabled while letting those images flow through the existing Markdown
 * image renderer.
 */

import type { Plugin } from 'unified';
import type { Root, Html, Paragraph } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

import { htmlNodeToImageNodes } from '../../../shared/htmlImage';

const BLOCK_CONTAINERS = new Set(['root', 'blockquote', 'listItem']);

const remarkHtmlImages: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'html', (node: Html, index, parent) => {
      if (!parent || index == null) return;

      const parsed = htmlNodeToImageNodes(node);
      if (!parsed) return;

      if (parsed.wrappedInParagraph && BLOCK_CONTAINERS.has(parent.type)) {
        const paragraph: Paragraph = {
          type: 'paragraph',
          children: parsed.images,
          position: node.position,
        };
        parent.children.splice(index, 1, paragraph);
        return [SKIP, index + 1];
      }

      parent.children.splice(index, 1, ...parsed.images);
      return [SKIP, index + parsed.images.length];
    });
  };
};

export default remarkHtmlImages;
