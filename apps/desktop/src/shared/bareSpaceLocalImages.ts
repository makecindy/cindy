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
 * Callers pass the ORIGINAL source span of one Markdown `text` node (not its
 * decoded `value`), so code spans, code blocks and HTML are never scanned, offsets
 * map straight back into the reply, and an escaped `\![...](...)` stays literal. Recovery is deliberately narrow: only an absolute
 * local path (POSIX, Windows drive, or hostless `xdt-image:///`) that ends with
 * an image extension. Destinations are never percent-decoded, because raw local
 * paths are never URI-decoded anywhere else either.
 */

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

export function findBareSpaceLocalImages(text: string): BareSpaceLocalImage[] {
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
