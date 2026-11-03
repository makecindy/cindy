/**
 * remarkBareSpaceLocalImages — turn `![alt](/abs/path with spaces/x.png)` left as
 * plain text by CommonMark into a real `image` node.
 *
 * Agents often write local images under folders such as `Application Support`
 * without the `<...>` form CommonMark requires. Main-process IM delivery recovers
 * the same construct with the same matcher (`shared/bareSpaceLocalImages.ts`),
 * and mobile already renders it, so the desktop chat must show what IM sends.
 *
 * Only `text` nodes are scanned, so code spans, code blocks and HTML stay literal.
 * Must run before remarkLocalPathLinks (which would otherwise cut the path into
 * link fragments) and before remarkPreserveRawLocalDestinations (which records
 * the raw local destination for the img renderer).
 */

import type { Plugin } from 'unified';
import type { Image, PhrasingContent, Root, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';

import { findBareSpaceLocalImages } from '../../../shared/bareSpaceLocalImages';

const remarkBareSpaceLocalImages: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null || parent.type === 'link' || parent.type === 'linkReference') return;
      const matches = findBareSpaceLocalImages(node.value);
      if (matches.length === 0) return;
      const replacement: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        if (match.start > cursor) replacement.push({ type: 'text', value: node.value.slice(cursor, match.start) });
        const image: Image = { type: 'image', url: match.url, alt: match.alt, title: match.title };
        replacement.push(image);
        cursor = match.end;
      }
      if (cursor < node.value.length) replacement.push({ type: 'text', value: node.value.slice(cursor) });
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
};

export default remarkBareSpaceLocalImages;
