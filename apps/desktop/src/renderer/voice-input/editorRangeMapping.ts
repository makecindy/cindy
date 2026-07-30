import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

export type EditorTextRange = {
  from: number;
  to: number;
};

/**
 * Snap a position onto the nearest place that can hold inline content.
 *
 * Dictation positions must always address inline content: the transcript is
 * inserted with `tr.insertText`, and the live draft/caret decorations are inline
 * widgets. A position whose parent is NOT a textblock (0, or a boundary between
 * two blocks) makes ProseMirror wrap the inserted text in a NEW paragraph — the
 * transcript then lands one line below, leaving an empty paragraph in front of
 * it — and renders the widgets at doc level, where the browser gives them their
 * own line. Both read as "dictation added a stray blank line".
 *
 * Anchors reach such a position whenever the composer document is rebuilt
 * wholesale while dictation is live (an external draft restore replaces the full
 * document), because mapping an anchor across a full replacement pushes it out
 * to the block boundary. Clamping to `doc.content.size` alone does not help:
 * that upper bound is itself a block boundary.
 */
export function clampToInlinePosition(doc: PMNode, position: number): number {
  const clamped = Math.max(0, Math.min(position, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.parent.isTextblock) return clamped;
  return TextSelection.near($pos, 1).from;
}

/**
 * Clamp a stored range into valid, ordered positions of `doc`.
 *
 * Only a COLLAPSED anchor is snapped onto an inline position. A non-collapsed
 * range carries replacement semantics that the endpoints are part of: dictation
 * started over `AllSelection` (Ctrl/Cmd+A) spans `0..doc.content.size`, and
 * snapping those endpoints inward would leave the outer nodes — a bullet/ordered
 * list wrapper, say — outside the replacement, so the transcript would land
 * inside the first list item instead of replacing the whole composer. Such a
 * range is only bounds-checked.
 */
export function clampEditorTextRangeToDoc(range: EditorTextRange, doc: PMNode): EditorTextRange {
  const lower = Math.max(0, Math.min(Math.min(range.from, range.to), doc.content.size));
  const upper = Math.max(0, Math.min(Math.max(range.from, range.to), doc.content.size));
  if (lower !== upper) return { from: lower, to: upper };
  const snapped = clampToInlinePosition(doc, lower);
  return { from: snapped, to: snapped };
}

/**
 * Where the text an `insertText(text, from, to)` transaction just wrote ended up.
 *
 * The pre-insertion `from` is NOT that place. A replacement range may legally
 * start at a block boundary (dictation over `AllSelection` spans
 * `0..doc.content.size`), and ProseMirror then fits the inline text INTO a
 * textblock — the glyphs land one position after that boundary. Recording the
 * pre-insertion endpoint would offset everything keyed to this range:
 * `applyRefinedText` would read a truncated `currentText` and drop the
 * refinement, and refinement previews plus dictionary-learning watches would
 * point at the wrong span.
 *
 * Mapping the range's START with association `-1` keeps it in front of the
 * inserted slice; snapping that onto an inline position lands exactly on the
 * first inserted character, however the slice was fitted.
 */
export function resolveInsertedTextRange(
  transaction: Transaction,
  replacedFrom: number,
  textLength: number,
): { start: number; end: number } {
  const start = clampToInlinePosition(
    transaction.doc,
    transaction.mapping.map(replacedFrom, -1),
  );
  return { start, end: Math.min(start + textLength, transaction.doc.content.size) };
}

/**
 * Move a stored range through a document change, so offsets captured earlier
 * keep pointing at the same content.
 *
 * The association arguments are what keep text inserted exactly at a boundary
 * OUTSIDE the range: `1` pushes `from` past such an insertion, `-1` holds `to`
 * in front of it. (The opposite pair — the intuitive-looking "bias outward" —
 * grows the range around the new text, which the next replacement would then
 * overwrite.) A collapsed cursor gets pushed both ways at once and ends up
 * inverted; keep it collapsed after the insertion rather than letting a
 * downstream min/max clamp swap it back into a range spanning that text.
 *
 * A mapped COLLAPSED anchor is snapped back onto an inline position: a
 * full-document replacement maps it out to a block boundary, which is not a
 * place dictation may insert at (see `clampToInlinePosition`). Non-collapsed
 * ranges keep their endpoints — see `clampEditorTextRangeToDoc`.
 *
 * Lives in its own module so it can be tested without pulling in the voice
 * input hook and its Electron bridge.
 */
export function mapEditorTextRange(
  range: EditorTextRange | null,
  transaction: Transaction,
): EditorTextRange | null {
  if (!range) return null;
  const from = transaction.mapping.map(range.from, 1);
  const to = transaction.mapping.map(range.to, -1);
  return clampEditorTextRangeToDoc(from > to ? { from, to: from } : { from, to }, transaction.doc);
}
