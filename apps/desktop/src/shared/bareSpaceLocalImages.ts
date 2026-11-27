/**
 * Markdown images whose local destination contains bare spaces.
 *
 * CommonMark only accepts a destination with spaces inside `<...>`, but agents
 * routinely write `![alt](/Users/me/Library/Application Support/x.png)`. Parsers
 * then leave the whole construct as plain text: the desktop chat does not show
 * the image and IM delivery sends the raw path without an attachment or notice.
 * Mobile already renders this form (`apps/mobile/src/session/messageMarkdown.ts`
 * `parseLocalMarkdownDestination`); this is the desktop counterpart, shared by
 * the main-process delivery parser and the renderer.
 *
 * Recovery uses original Markdown source so offsets map back to the reply and
 * an escaped `\![...](...)` stays literal. Code, HTML and links stay outside
 * recovery. Paths must be absolute (POSIX, Windows drive, or hostless
 * `xdt-image:///`) and end with an image extension. The original destination is
 * preserved without percent-decoding.
 */

import type { PhrasingContent, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

export interface BareSpaceLocalImage {
  /** Offsets of the whole `![alt](...)` construct within the scanned text. */
  start: number;
  end: number;
  alt: string;
  url: string;
  title: string | null;
}

// One level of balanced parentheses, as in `shot (1).png`.
const IMAGE_RE = /!\[([^[\]\n]*)\]\(((?:[^()\n<>]|\([^()\n<>]*\))+)\)/g;
// The quoted class excludes backslashes so the two branches never overlap
// (the mobile parser documents the catastrophic backtracking this avoids).
const QUOTED_TITLE_RE = /^(.*\S)[ \t]+(["'])((?:[^\n\\]|\\.)*)\2$/;
const LOCAL_PREFIX_RE = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|xdt-image:\/\/\/)/i;
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i;

/** An odd run of backslashes before `index` escapes the character there. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function findBareSpaceLocalImages(text: string): BareSpaceLocalImage[] {
  if (!text.includes('![')) return [];
  const found: BareSpaceLocalImage[] = [];
  for (const match of text.matchAll(IMAGE_RE)) {
    if (isEscaped(text, match.index)) continue;
    let destination = match[2].trim();
    let title: string | null = null;
    const quoted = destination.match(QUOTED_TITLE_RE);
    if (quoted) {
      destination = quoted[1];
      title = quoted[3];
    }
    if (
      !/[ \t]/.test(destination) ||
      !LOCAL_PREFIX_RE.test(destination) ||
      !IMAGE_EXTENSION_RE.test(destination)
    )
      continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      url: destination,
      title,
    });
  }
  return found;
}

type PositionedInline = { node: PhrasingContent; start: number; end: number };

const inlineParser = unified().use(remarkParse);

function canRecoverAcross(node: PhrasingContent): boolean {
  return (
    node.type === 'text' ||
    ((node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') &&
      node.children.every(canRecoverAcross))
  );
}

/** Preserve CommonMark's decoding of any text left on either side of an image. */
function textFragment(
  source: string,
  { node, start, end }: PositionedInline,
  from: number,
  to: number,
): PhrasingContent[] {
  if (from === start && to === end) return [node];
  if (from === to) return [];
  const fragment = source.slice(from, to);
  if (node.type === 'text' && node.value === source.slice(start, end))
    return [{ type: 'text', value: fragment }];

  const lead = /^\s*/.exec(fragment)![0];
  const core = fragment.slice(lead.length).trimEnd();
  const trail = fragment.slice(lead.length + core.length);
  const children = core ? inlineParser.parse(core).children : [];
  const first = children[0];
  let inner: PhrasingContent[] = core ? [{ type: 'text', value: core }] : [];
  if (children.length === 1 && first?.type === 'paragraph') inner = first.children;
  // These fragments were parsed out of context. Their local offsets must never
  // be mistaken for offsets in the full Markdown during the tree walk.
  for (const child of inner)
    visit(child, (descendant) => {
      delete descendant.position;
    });
  return [
    ...(lead ? [{ type: 'text', value: lead } as const] : []),
    ...inner,
    ...(trail ? [{ type: 'text', value: trail } as const] : []),
  ];
}

function recoverRun(
  run: PositionedInline[],
  source: string,
  found: BareSpaceLocalImage[],
): PhrasingContent[] {
  const start = run[0]!.start;
  const matches = findBareSpaceLocalImages(source.slice(start, run.at(-1)!.end));
  if (!matches.length) return run.map(({ node }) => node);

  const replacement: PhrasingContent[] = [];
  let scanStart = 0;
  let scanEnd = 0;
  let childIndex = 0;
  let cursor = start;
  for (const match of matches) {
    const imageStart = start + match.start;
    const imageEnd = start + match.end;
    while (run[scanStart]!.end <= imageStart) scanStart++;
    scanEnd = Math.max(scanStart, scanEnd);
    while (run[scanEnd]!.end < imageEnd) scanEnd++;
    // Whole intervening emphasis nodes may be part of the image, but never
    // cut through markup that belongs to surrounding prose.
    if (run[scanStart]!.node.type !== 'text' || run[scanEnd]!.node.type !== 'text') continue;
    while (childIndex < scanStart) {
      const child = run[childIndex++]!;
      replacement.push(...textFragment(source, child, cursor, child.end));
      cursor = run[childIndex]!.start;
    }
    replacement.push(...textFragment(source, run[scanStart]!, cursor, imageStart));
    const { url, alt, title } = match;
    replacement.push({ type: 'image', url, alt, title });
    found.push({ start: imageStart, end: imageEnd, url, alt, title });
    childIndex = scanEnd;
    cursor = imageEnd;
  }
  for (const child of run.slice(childIndex)) {
    replacement.push(...textFragment(source, child, cursor, child.end));
    cursor = child.end;
  }
  return replacement;
}

/** Recover the same images for display and delivery, without opening any path. */
export function recoverBareSpaceLocalImages(tree: Root, source: string): BareSpaceLocalImage[] {
  if (!source.includes('![')) return [];

  const found: BareSpaceLocalImage[] = [];
  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'linkReference') return SKIP;
    if (
      node.type !== 'paragraph' &&
      node.type !== 'heading' &&
      node.type !== 'tableCell' &&
      node.type !== 'emphasis' &&
      node.type !== 'strong' &&
      node.type !== 'delete'
    )
      return;
    const previousMatchCount = found.length;
    let run: PositionedInline[] = [];
    const children: PhrasingContent[] = [];
    const flush = () => {
      if (!run.length) return;
      children.push(...recoverRun(run, source, found));
      run = [];
    };
    for (const child of node.children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined || !canRecoverAcross(child)) {
        flush();
        children.push(child);
      } else {
        if (run.length && run.at(-1)!.end !== start) flush();
        run.push({ node: child, start, end });
      }
    }
    flush();
    if (found.length !== previousMatchCount) node.children = children;
  });
  return found;
}
