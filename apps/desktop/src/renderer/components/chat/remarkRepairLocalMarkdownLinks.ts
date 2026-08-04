/**
 * Repair assistant-generated local Markdown links whose destination contains
 * spaces but is not wrapped in angle brackets.
 *
 * CommonMark treats `[label](/path with spaces/file.png)` as plain text. The
 * assistant commonly emits that form for generated files, so the renderer
 * never gets an `<a>` node and cannot open the existing local-file lightbox.
 * Only whitespace-containing local file targets are repaired; valid Markdown,
 * external URLs, and directory targets are left untouched.
 */

import type { Image, Link, PhrasingContent, Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

import { classifyMarkdownHref } from '@/lib/localPathResolver';

const MALFORMED_LOCAL_LINK_START_RE = /\[((?:\\.|[^\]\n])*)\]\(/g;
export const RAW_LOCAL_LINK_HREF_PROP = 'data-cindy-raw-local-link-href';

function findMalformedLocalLinkMatches(value: string, rawSource?: string) {
  const matches: Array<{
    start: number;
    end: number;
    label: string;
    href: string;
    image: boolean;
  }> = [];
  MALFORMED_LOCAL_LINK_START_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MALFORMED_LOCAL_LINK_START_RE.exec(value)) !== null) {
    // The parser may remove a single escape or collapse an entity before the
    // opener. Inspect a small source window around that opener without trying
    // to rebuild a full decoded-to-raw offset table.
    const rawPrefix = rawSource?.slice(0, match.index + 2);
    if (rawPrefix?.includes('\\') || rawPrefix?.includes('&')) continue;
    const image = match.index > 0 && value[match.index - 1] === '!';
    const hrefStart = MALFORMED_LOCAL_LINK_START_RE.lastIndex;
    const hrefSource = value.slice(hrefStart);
    // A relative Windows path has no drive/UNC anchor, but a separator before
    // a parenthesized filename is still a path separator, not a Markdown escape.
    const windowsPath =
      /^(?:[A-Za-z]:[\\/]|\\\\)/.test(hrefSource) || /\\\(/.test(hrefSource);
    let depth = 0;
    let escaped = false;
    let hrefEnd = -1;

    for (let index = hrefStart; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && !windowsPath) {
        escaped = true;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        if (depth === 0) {
          hrefEnd = index;
          break;
        }
        depth -= 1;
      }
      if (char === '\n') break;
    }

    if (hrefEnd < 0) continue;
    const href = value.slice(hrefStart, hrefEnd).trim();
    const kind = classifyMarkdownHref(href);
    if (/\s/.test(href) && kind !== 'external' && kind !== 'directory') {
      matches.push({
        start: image ? match.index - 1 : match.index,
        end: hrefEnd + 1,
        label: match[1],
        href,
        image,
      });
    }
    // Do not let a nested `](` inside the destination start another match.
    MALFORMED_LOCAL_LINK_START_RE.lastIndex = hrefEnd + 1;
  }
  return matches;
}

function splitMalformedLocalLinks(node: Text, rawSource?: string): PhrasingContent[] | null {
  const matches = findMalformedLocalLinkMatches(node.value, rawSource);

  if (matches.length === 0) return null;

  const out: PhrasingContent[] = [];
  let cursor = 0;
  for (const item of matches) {
    if (item.start > cursor) out.push({ type: 'text', value: node.value.slice(cursor, item.start) });
    if (item.image) {
      const image: Image = { type: 'image', url: item.href, alt: item.label };
      out.push(image);
    } else {
      const link: Link = {
        type: 'link',
        url: item.href,
        children: [{ type: 'text', value: item.label }],
        data: { hProperties: { [RAW_LOCAL_LINK_HREF_PROP]: item.href } },
      };
      out.push(link);
    }
    cursor = item.end;
  }
  if (cursor < node.value.length) out.push({ type: 'text', value: node.value.slice(cursor) });
  return out;
}

const remarkRepairLocalMarkdownLinks: Plugin<[], Root> = () => {
  return (tree, file) => {
    visit(tree, (node, index, parent) => {
      if (node.type === 'link' || node.type === 'linkReference') return SKIP;
      if (node.type !== 'text' || !parent || index == null || !node.value.includes('](')) return;
      const rawSource =
        node.position?.start.offset !== undefined && node.position.end.offset !== undefined
          ? file.toString().slice(node.position.start.offset, node.position.end.offset)
          : undefined;
      const replacement = splitMalformedLocalLinks(node, rawSource);
      if (!replacement) return;
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
};

export default remarkRepairLocalMarkdownLinks;
