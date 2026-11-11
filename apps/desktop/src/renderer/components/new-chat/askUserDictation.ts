/**
 * Plain-text edits for dictation landing in the question card's answer box.
 * The composer keeps its TipTap editor; this surface is a textarea, so ranges
 * are JavaScript string offsets (not ProseMirror positions).
 */

export type TextRange = { start: number; end: number };

export function clampTextRange(value: string, range: TextRange): TextRange {
  const start = Math.max(0, Math.min(range.start, value.length));
  const end = Math.max(start, Math.min(range.end, value.length));
  return { start, end };
}

export function spliceText(value: string, range: TextRange, insert: string): { value: string; range: TextRange } {
  const clamped = clampTextRange(value, range);
  const next = value.slice(0, clamped.start) + insert + value.slice(clamped.end);
  return {
    value: next,
    range: { start: clamped.start, end: clamped.start + insert.length },
  };
}

/**
 * Replace a previously submitted span only when the user has not edited it.
 * Returns null when the span no longer matches the text dictation committed
 * or the raw transcript refinement was based on.
 */
export function replaceUneditedSpan(
  value: string,
  range: TextRange,
  expected: readonly string[],
  insert: string,
): { value: string; range: TextRange } | null {
  const clamped = clampTextRange(value, range);
  const current = value.slice(clamped.start, clamped.end);
  if (!expected.some((candidate) => candidate === current)) return null;
  return spliceText(value, clamped, insert);
}
