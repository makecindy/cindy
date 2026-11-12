export interface SelectableTextTypography {
  fontSize?: number;
  lineHeight?: number;
}

/**
 * Optical correction for the existing iOS UITextView renderer. Its fixed line
 * height leaves the extra leading above the glyphs. Move the view, not the
 * line boxes, so wrapping, list measurements and native selection stay intact.
 * iOS system fonts have a natural line height of approximately 1.2 × font size;
 * this is a JS layout correction, not an exact replacement for UIFont metrics.
 */
export function selectableTextVerticalOffset(
  typography: readonly SelectableTextTypography[],
  fontScale: number,
): number {
  let maximumFontSize = 0;
  let maximumLineHeight = 0;
  for (const style of typography) {
    if (Number.isFinite(style.fontSize) && (style.fontSize ?? 0) > 0) {
      maximumFontSize = Math.max(maximumFontSize, style.fontSize!);
    }
    if (Number.isFinite(style.lineHeight) && (style.lineHeight ?? 0) > 0) {
      maximumLineHeight = Math.max(maximumLineHeight, style.lineHeight!);
    }
  }
  if (!maximumFontSize || !maximumLineHeight) return 0;
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return -Math.max(0, maximumLineHeight - maximumFontSize * 1.2) * scale / 2;
}
