export const DEFAULT_BROWSER_ZOOM_FACTOR = 1;

export const BROWSER_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

export function normalizeBrowserZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BROWSER_ZOOM_FACTOR;
  }
  return BROWSER_ZOOM_FACTORS.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
  );
}

export function previousBrowserZoomFactor(value: number): number | null {
  const normalized = normalizeBrowserZoomFactor(value);
  const index = BROWSER_ZOOM_FACTORS.indexOf(normalized as (typeof BROWSER_ZOOM_FACTORS)[number]);
  return index > 0 ? BROWSER_ZOOM_FACTORS[index - 1] : null;
}

export function nextBrowserZoomFactor(value: number): number | null {
  const normalized = normalizeBrowserZoomFactor(value);
  const index = BROWSER_ZOOM_FACTORS.indexOf(normalized as (typeof BROWSER_ZOOM_FACTORS)[number]);
  return index < BROWSER_ZOOM_FACTORS.length - 1 ? BROWSER_ZOOM_FACTORS[index + 1] : null;
}

export function formatBrowserZoomFactor(value: number): string {
  return `${Math.round(normalizeBrowserZoomFactor(value) * 100)}%`;
}
