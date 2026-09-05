/** Symbols that wrap a non-empty text selection when their opening key is typed. */
const SELECTION_PAIRS = {
  '"': '"',
  "'": "'",
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
} as const;

export interface PairedSelectionEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Return the closing symbol for a supported single-character opening input. */
export function closingSymbolFor(input: string): string | null {
  return Object.prototype.hasOwnProperty.call(SELECTION_PAIRS, input)
    ? SELECTION_PAIRS[input as keyof typeof SELECTION_PAIRS]
    : null;
}

/**
 * Compute a selection-preserving edit for native text controls. The selected
 * text remains selected inside the new pair, matching VS Code's interaction.
 */
export function computePairedSelectionEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  input: string,
): PairedSelectionEdit | null {
  const close = closingSymbolFor(input);
  if (close === null || selectionStart === selectionEnd) return null;

  return {
    value:
      value.slice(0, selectionStart) +
      input +
      value.slice(selectionStart, selectionEnd) +
      close +
      value.slice(selectionEnd),
    selectionStart: selectionStart + input.length,
    selectionEnd: selectionEnd + input.length,
  };
}
