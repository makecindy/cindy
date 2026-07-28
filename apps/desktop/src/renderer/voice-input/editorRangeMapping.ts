import type { Transaction } from '@tiptap/pm/state';

export type EditorTextRange = {
  from: number;
  to: number;
};

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
  return from > to ? { from, to: from } : { from, to };
}
