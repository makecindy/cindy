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
 * The matcher runs on the node's ORIGINAL source span, like the main-process
 * parser, so an escaped `\![x](/a b.png)` stays literal text in both places. The
 * text around a match is re-parsed when the span differs from the decoded value
 * (entities, escapes), so it keeps rendering exactly as before.
 *
 * Must run before remarkLocalPathLinks (which would otherwise cut the path into
 * link fragments) and before remarkPreserveRawLocalDestinations (which records
 * the raw local destination for the img renderer).
 */

import type { Plugin } from 'unified';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Image, PhrasingContent, Root, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';

import { findBareSpaceLocalImages } from '../../../shared/bareSpaceLocalImages';

const inlineParser = unified().use(remarkParse);

/** Render a source fragment the way the surrounding text node would have been. */
function decodeFragment(fragment: string): PhrasingContent[] {
  if (!fragment) return [];
  const lead = /^\s*/.exec(fragment)![0];
  const core = fragment.slice(lead.length).trimEnd();
  const trail = fragment.slice(lead.length + core.length);
  let inner: PhrasingContent[] = core ? [{ type: 'text', value: core }] : [];
  if (core) {
    const { children } = inlineParser.parse(core) as Root;
    if (children.length === 1 && children[0].type === 'paragraph') inner = children[0].children;
  }
  return [
    ...(lead ? [{ type: 'text', value: lead } as Text] : []),
    ...inner,
    ...(trail ? [{ type: 'text', value: trail } as Text] : []),
  ];
}

const remarkBareSpaceLocalImages: Plugin<[], Root> = () => {
  return (tree, file) => {
    const source = String(file);
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null || parent.type === 'link' || parent.type === 'linkReference') return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const span = source.slice(start, end);
      const matches = findBareSpaceLocalImages(span);
      if (matches.length === 0) return;
      const literal = span === node.value;
      const piece = (from: number, to: number): PhrasingContent[] =>
        literal ? (from < to ? [{ type: 'text', value: span.slice(from, to) }] : []) : decodeFragment(span.slice(from, to));
      const replacement: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        replacement.push(...piece(cursor, match.start));
        const image: Image = { type: 'image', url: match.url, alt: match.alt, title: match.title };
        replacement.push(image);
        cursor = match.end;
      }
      replacement.push(...piece(cursor, span.length));
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
};

export default remarkBareSpaceLocalImages;
