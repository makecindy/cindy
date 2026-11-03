export type PdfZoom = { mode: 'width' | 'page' } | { mode: 'custom'; scale: number };
export type PdfDimensions = { width: number; height: number };

export function getPdfScale(zoom: PdfZoom, container: PdfDimensions, page: PdfDimensions) {
  if (zoom.mode === 'custom') return zoom.scale;
  const widthScale = Math.max(1, container.width - 32) / page.width;
  return zoom.mode === 'width'
    ? widthScale
    : Math.min(widthScale, Math.max(1, container.height - 48) / page.height);
}
