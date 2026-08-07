import type { JSONContent } from '@tiptap/core';

type ListKind = 'bullet' | 'ordered';
type OrderedMarker = '.' | ')' | '、';

interface ListMarker {
  kind: ListKind;
  prefixLength: number;
  marker: string;
  separator: string;
  start?: number;
}

interface ComposerLine {
  content: JSONContent[];
  text: string;
}

const BULLET_RE = /^([-+*•])([ \t]+)/;
const ORDERED_RE = /^([1-9]\d{0,8})([.)、])([ \t]*)/;

function inlineNodeText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return '\uFFFC';
}

function pushLine(lines: ComposerLine[], content: JSONContent[]): void {
  lines.push({
    content,
    text: content.map(inlineNodeText).join(''),
  });
}

function splitParagraphLines(paragraph: JSONContent): ComposerLine[] {
  const lines: ComposerLine[] = [];
  let current: JSONContent[] = [];

  const appendText = (text: string, node: JSONContent) => {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (part) current.push({ ...node, text: part });
      if (index < parts.length - 1) {
        pushLine(lines, current);
        current = [];
      }
    });
  };

  for (const node of paragraph.content ?? []) {
    if (node.type === 'hardBreak') {
      pushLine(lines, current);
      current = [];
      continue;
    }
    if (node.type === 'text' && (node.text ?? '').includes('\n')) {
      appendText(node.text ?? '', node);
      continue;
    }
    current.push(node);
  }
  pushLine(lines, current);
  return lines;
}

function parseListMarker(text: string): ListMarker | null {
  // Only unindented rows are promoted here. Indented rows may be nested
  // Markdown, and the visual fallback remains responsible for those until
  // their parent item is also represented structurally.
  if (/^[ \t]/.test(text)) return null;

  const bullet = text.match(BULLET_RE);
  if (bullet) {
    return {
      kind: 'bullet',
      prefixLength: bullet[0].length,
      marker: bullet[1],
      separator: bullet[2],
    };
  }

  const ordered = text.match(ORDERED_RE);
  if (ordered) {
    const marker = ordered[2] as OrderedMarker;
    if (marker !== '、' && ordered[3].length === 0) return null;
    return {
      kind: 'ordered',
      // CJK ordered markers are valid with or without a following space.
      // Keep that space in the item body so serialization preserves the
      // user's original form without adding another list attribute.
      prefixLength: marker === '、' ? ordered[1].length + marker.length : ordered[0].length,
      marker,
      separator: marker === '、' ? '' : ordered[3],
      start: Number(ordered[1]),
    };
  }
  return null;
}

function stripPrefix(content: JSONContent[], prefixLength: number): JSONContent[] | null {
  const first = content[0];
  if (!first || first.type !== 'text') return null;
  const text = first.text ?? '';
  if (text.length < prefixLength) return null;
  const remaining = text.slice(prefixLength);
  const rest = remaining ? [{ ...first, text: remaining }, ...content.slice(1)] : content.slice(1);
  return rest;
}

function paragraphFromLine(line: ComposerLine, attrs?: JSONContent['attrs']): JSONContent {
  return {
    type: 'paragraph',
    ...(attrs ? { attrs } : {}),
    ...(line.content.length > 0 ? { content: line.content } : {}),
  };
}

function listFromLines(
  lines: ComposerLine[],
  marker: ListMarker,
  paragraphAttrs?: JSONContent['attrs'],
): JSONContent {
  const items = lines.map((line) => {
    const lineMarker = parseListMarker(line.text);
    const content =
      stripPrefix(line.content, lineMarker?.prefixLength ?? marker.prefixLength) ?? line.content;
    return {
      type: 'listItem',
      content: [paragraphFromLine({ content, text: '' }, paragraphAttrs)],
    };
  });
  const attrs =
    marker.kind === 'ordered'
      ? marker.separator === ' ' && marker.marker !== '、'
        ? { start: marker.start ?? 1, marker: marker.marker }
        : { start: marker.start ?? 1, marker: marker.marker, separator: marker.separator }
      : marker.marker === '-' && marker.separator === ' '
        ? undefined
        : { marker: marker.marker, separator: marker.separator };
  return {
    type: marker.kind === 'ordered' ? 'orderedList' : 'bulletList',
    ...(attrs ? { attrs } : {}),
    content: items,
  };
}

function sameListMarker(left: ListMarker, right: ListMarker): boolean {
  return (
    left.kind === right.kind && left.marker === right.marker && left.separator === right.separator
  );
}

function canAppendListLine(
  current: ListMarker,
  currentLineCount: number,
  next: ListMarker,
): boolean {
  if (!sameListMarker(current, next)) return false;
  if (current.kind === 'bullet') return true;
  return next.start === (current.start ?? 1) + currentLineCount;
}

interface FenceState {
  char: '`' | '~';
  length: number;
}

function fenceOpening(text: string): FenceState | null {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { char: match[1][0] as FenceState['char'], length: match[1].length };
}

function isFenceClosing(text: string, state: FenceState): boolean {
  const escapedChar = state.char === '`' ? '`' : '~';
  const pattern = new RegExp(`^ {0,3}${escapedChar}{${state.length},}[ \\t]*$`);
  return pattern.test(text);
}

function paragraphToBlocks(
  paragraph: JSONContent,
  initialFence: FenceState | null,
): { blocks: JSONContent[]; fence: FenceState | null } {
  const lines = splitParagraphLines(paragraph);
  let scannedFence: FenceState | null = initialFence;
  let hasPromotableList = false;
  for (const line of lines) {
    if (scannedFence) {
      if (isFenceClosing(line.text, scannedFence)) scannedFence = null;
      continue;
    }
    if (parseListMarker(line.text)) hasPromotableList = true;
    const opening = fenceOpening(line.text);
    if (opening) scannedFence = opening;
  }
  if (!hasPromotableList) {
    return { blocks: [paragraph], fence: scannedFence };
  }

  const blocks: JSONContent[] = [];
  let plainLines: ComposerLine[] = [];
  let listLines: ComposerLine[] = [];
  let listMarker: ListMarker | null = null;
  let fence = initialFence;

  const flushPlain = () => {
    if (plainLines.length === 0) return;
    plainLines.forEach((line) => blocks.push(paragraphFromLine(line, paragraph.attrs)));
    plainLines = [];
  };
  const flushList = () => {
    if (listLines.length === 0 || !listMarker) return;
    blocks.push(listFromLines(listLines, listMarker, paragraph.attrs));
    listLines = [];
    listMarker = null;
  };

  for (const line of lines) {
    if (fence) {
      flushList();
      plainLines.push(line);
      if (isFenceClosing(line.text, fence)) fence = null;
      continue;
    }
    const opening = fenceOpening(line.text);
    if (opening) {
      flushList();
      plainLines.push(line);
      fence = opening;
      continue;
    }
    const marker = parseListMarker(line.text);
    if (!marker) {
      flushList();
      plainLines.push(line);
      continue;
    }
    const stripped = stripPrefix(line.content, marker.prefixLength);
    if (!stripped) {
      flushList();
      plainLines.push(line);
      continue;
    }
    if (listMarker && !canAppendListLine(listMarker, listLines.length, marker)) flushList();
    flushPlain();
    listMarker ??= marker;
    listLines.push(line);
  }
  flushList();
  flushPlain();
  return { blocks, fence };
}

function canMergeLists(left: JSONContent, right: JSONContent): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'bulletList') {
    return (
      (left.attrs?.marker ?? '-') === (right.attrs?.marker ?? '-') &&
      (left.attrs?.separator ?? ' ') === (right.attrs?.separator ?? ' ')
    );
  }
  const leftStart = Number(left.attrs?.start);
  const rightStart = Number(right.attrs?.start);
  return (
    left.attrs?.marker === right.attrs?.marker &&
    (left.attrs?.separator ?? (left.attrs?.marker === '、' ? '' : ' ')) ===
      (right.attrs?.separator ?? (right.attrs?.marker === '、' ? '' : ' ')) &&
    Number.isInteger(leftStart) &&
    Number.isInteger(rightStart) &&
    leftStart + (left.content?.length ?? 0) === rightStart
  );
}

function mergeLists(left: JSONContent, right: JSONContent): JSONContent {
  return {
    ...left,
    content: [...(left.content ?? []), ...(right.content ?? [])],
  };
}

/**
 * Promote plain Markdown list rows at composer document boundaries to the
 * structured list nodes used by the editor.
 *
 * This is deliberately a one-way normalization: malformed rows, indented
 * nested rows, and paragraphs containing inline atoms that obscure the marker
 * remain plain text and can still use the compatibility renderer.
 */
export function normalizeComposerDocumentJSON(document: JSONContent): JSONContent {
  if (document.type !== 'doc' || !Array.isArray(document.content)) return document;

  const normalized: JSONContent[] = [];
  let fence: FenceState | null = null;
  for (const node of document.content) {
    const result: { blocks: JSONContent[]; fence: FenceState | null } =
      node.type === 'paragraph' ? paragraphToBlocks(node, fence) : { blocks: [node], fence };
    fence = result.fence;
    for (const block of result.blocks) {
      const previous = normalized.at(-1);
      if (previous && canMergeLists(previous, block)) {
        normalized[normalized.length - 1] = mergeLists(previous, block);
      } else {
        normalized.push(block);
      }
    }
  }
  return { ...document, content: normalized };
}

export interface ComposerRestoreInsertion {
  document: JSONContent;
  insertedBlocks: JSONContent[];
  nextInsertAt: number;
}

function emptyComposerParagraph(): JSONContent {
  return { type: 'paragraph' };
}

/**
 * Insert one failed optimistic send at a stable top-level block cursor.
 *
 * Each failed document contributes a trailing empty paragraph. It is the
 * structural equivalent of Mobile's `\n\n` recovery separator and prevents a
 * later editor hydration/normalization pass from merging compatible lists
 * across FIFO message boundaries. When there is no newer draft, keep one extra
 * empty tail paragraph so the user can type without mutating that separator.
 */
export function insertComposerDocumentForRestore(
  failedSendDocument: JSONContent,
  currentDraftDocument: JSONContent,
  insertAt = 0,
): ComposerRestoreInsertion {
  const normalizedFailed = normalizeComposerDocumentJSON(failedSendDocument);
  const normalizedCurrent = normalizeComposerDocumentJSON(currentDraftDocument);
  const insertedBlocks =
    normalizedFailed.type === 'doc' && Array.isArray(normalizedFailed.content)
      ? [...normalizedFailed.content, emptyComposerParagraph()]
      : [];
  const normalizedCurrentBlocks =
    normalizedCurrent.type === 'doc' && Array.isArray(normalizedCurrent.content)
      ? normalizedCurrent.content
      : [];
  const currentBlocks =
    normalizedCurrentBlocks.length > 0 ? normalizedCurrentBlocks : [emptyComposerParagraph()];
  const boundedInsertAt = Math.max(0, Math.min(insertAt, currentBlocks.length));

  return {
    document: {
      type: 'doc',
      content: [
        ...currentBlocks.slice(0, boundedInsertAt),
        ...insertedBlocks,
        ...currentBlocks.slice(boundedInsertAt),
      ],
    },
    insertedBlocks,
    nextInsertAt: boundedInsertAt + insertedBlocks.length,
  };
}

/** Build a normalized composer document from plain clipboard/history text. */
export function plainTextToComposerDocument(text: string): JSONContent {
  const content = text
    .split('\n')
    .map((line) =>
      line.length > 0
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' },
    );
  return normalizeComposerDocumentJSON({ type: 'doc', content });
}

export function composerDocumentContainsList(document: JSONContent): boolean {
  return (
    document.type === 'doc' &&
    (document.content ?? []).some(
      (node) => node.type === 'bulletList' || node.type === 'orderedList',
    )
  );
}
