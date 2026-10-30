/**
 * Keep submitted ASR text visible while streaming refinement arrives.
 *
 * A refined prefix has no positional correspondence with the original text:
 * removing filler words shifts every subsequent character. Keep the current
 * text until the validated final result arrives instead of manufacturing a
 * hybrid by appending an arbitrary original suffix.
 */
export function buildRefinementPreviewText(baseText: string, previewText: string): string {
  return baseText || previewText;
}
