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
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Plugin } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

import { classifyMarkdownHref } from '@/lib/localPathResolver';

const MALFORMED_LOCAL_LINK_START_RE = /\[((?:\\.|[^\]\n])*)\]\(/g;
export const RAW_LOCAL_LINK_HREF_PROP = 'data-cindy-raw-local-link-href';

function decodedOffsetMap(raw: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < raw.length; ) {
    if (raw[index] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw[index + 1] ?? '')) {
      offsets.push(index + 1);
      index += 2;
      continue;
    }

    if (raw[index] === '&') {
      const semicolon = raw.indexOf(';', index + 1);
      if (semicolon >= 0) {
        const reference = raw.slice(index + 1, semicolon);
        const decoded = decodeCharacterReference(reference);
        if (decoded !== false) {
          for (let offset = 0; offset < decoded.length; offset += 1) offsets.push(index);
          index = semicolon + 1;
          continue;
        }
      }
    }

    offsets.push(index);
    index += 1;
  }
  return offsets;
}

function decodeCharacterReference(reference: string): string | false {
  const named = decodeNamedCharacterReference(reference);
  if (named !== false) return named;

  const numeric = /^(?:#([0-9]+)|#x([0-9a-f]+))$/i.exec(reference);
  if (!numeric) return false;

  const codePoint = Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 10 : 16);
  if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return '\uFFFD';
  if (
    codePoint < 0x9 ||
    codePoint === 0xb ||
    (codePoint > 0x1f && codePoint < 0xa0) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) >= 0xfffe
  ) {
    return '\uFFFD';
  }
  return String.fromCodePoint(codePoint);
}

function isRawEscaped(decodedIndex: number, rawSource: string | undefined, rawOffsets: number[] | null) {
  if (decodedIndex < 0 || !rawSource || !rawOffsets) return false;
  const rawIndex = rawOffsets[decodedIndex];
  if (rawIndex === undefined || rawIndex === 0) return false;
  let slashCount = 0;
  for (let index = rawIndex - 1; index >= 0 && rawSource[index] === '\\'; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isRawCharacter(
  decodedIndex: number,
  expected: string,
  rawSource: string | undefined,
  rawOffsets: number[] | null,
) {
  if (decodedIndex < 0 || !rawSource || !rawOffsets) return true;
  const rawIndex = rawOffsets[decodedIndex];
  return rawIndex !== undefined && rawSource[rawIndex] === expected;
}

function isEscaped(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function splitDestinationAndTitle(value: string): { href: string; title?: string } {
  const trimmed = value.trim();

  for (const quote of ['"', "'"]) {
    if (!trimmed.endsWith(quote)) continue;
    for (let index = trimmed.length - 2; index > 0; index -= 1) {
      if (
        trimmed[index] === quote &&
        !isEscaped(trimmed, index) &&
        /\s/.test(trimmed[index - 1] ?? '')
      ) {
        const href = trimmed.slice(0, index).trimEnd();
        if (href) return { href, title: trimmed.slice(index + 1, -1) };
      }
    }
  }

  if (trimmed.endsWith(')')) {
    let depth = 0;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      if (isEscaped(trimmed, index)) continue;
      if (trimmed[index] === ')') {
        depth += 1;
      } else if (trimmed[index] === '(') {
        depth -= 1;
        if (depth === 0 && index > 0 && /\s/.test(trimmed[index - 1] ?? '')) {
          const href = trimmed.slice(0, index).trimEnd();
          if (href) return { href, title: trimmed.slice(index + 1, -1) };
        }
      }
    }
  }

  return { href: trimmed };
}

function findMalformedLocalLinkMatches(value: string, rawSource?: string) {
  const matches: Array<{
    start: number;
    end: number;
    label: string;
    href: string;
    title?: string;
    image: boolean;
  }> = [];
  MALFORMED_LOCAL_LINK_START_RE.lastIndex = 0;
  const rawOffsets = rawSource == null ? null : decodedOffsetMap(rawSource);

  let match: RegExpExecArray | null;
  while ((match = MALFORMED_LOCAL_LINK_START_RE.exec(value)) !== null) {
    if (isRawEscaped(match.index, rawSource, rawOffsets)) continue;
    if (!isRawCharacter(match.index, '[', rawSource, rawOffsets)) continue;
    const image = match.index > 0 && value[match.index - 1] === '!';
    if (image && isRawEscaped(match.index - 1, rawSource, rawOffsets)) continue;
    if (image && !isRawCharacter(match.index - 1, '!', rawSource, rawOffsets)) continue;
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
    const { href, title } = splitDestinationAndTitle(value.slice(hrefStart, hrefEnd));
    const kind = classifyMarkdownHref(href);
    if (/\s/.test(href) && kind !== 'external' && kind !== 'directory') {
      matches.push({
        start: image ? match.index - 1 : match.index,
        end: hrefEnd + 1,
        label: match[1],
        href,
        title,
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
      const image: Image = {
        type: 'image',
        url: item.href,
        alt: item.label,
        ...(item.title === undefined ? {} : { title: item.title }),
      };
      out.push(image);
    } else {
      const link: Link = {
        type: 'link',
        url: item.href,
        ...(item.title === undefined ? {} : { title: item.title }),
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
