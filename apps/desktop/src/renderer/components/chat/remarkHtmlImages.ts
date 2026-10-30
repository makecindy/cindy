/**
 * Convert safe raw HTML <img> tags into mdast image nodes.
 *
 * react-markdown intentionally runs with skipHtml, but model replies often use
 * `<img src="..." width="150">` when they want small thumbnails in tables.
 * Transforming only single img tags keeps arbitrary HTML disabled while letting
 * those thumbnails flow through the existing Markdown image renderer.
 */

import type { Plugin } from 'unified';
import type { Root, Html } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

import { htmlImgToImageNode } from '../../../shared/htmlImage';

const remarkHtmlImages: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'html', (node: Html, index, parent) => {
      if (!parent || index == null) return;

      const image = htmlImgToImageNode(node);
      if (!image) return;

      parent.children.splice(index, 1, image);
      return [SKIP, index + 1];
    });
  };
};

export default remarkHtmlImages;
