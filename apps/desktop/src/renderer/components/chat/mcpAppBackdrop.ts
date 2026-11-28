import { isHostCanvasImageBacked } from '@/cindy-brain/ghostPanelTheme';

/** Alpha of a computed background color: 0 for transparent, 1 for fully opaque. */
function backgroundAlpha(color: string): number {
  const normalized = color.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') return 0;
  const legacyAlpha = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  if (legacyAlpha) return Number(legacyAlpha[1]);
  const modernAlpha = normalized.match(/\/\s*([0-9.]+%?)\s*\)$/);
  if (modernAlpha) {
    return modernAlpha[1].endsWith('%')
      ? Number.parseFloat(modernAlpha[1]) / 100
      : Number.parseFloat(modernAlpha[1]);
  }
  return 1;
}

/**
 * The color that reproduces what is visible behind the card, or transparent.
 * Painting is only invisible over a fully opaque, image-free ancestor: a
 * translucent layer would be doubled, and an image-backed canvas (wallpaper or
 * desktop background) would be hidden for the App's whole lifetime.
 */
export function findMcpAppBackdropColor(element: Element): string {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if ((current === document.body || current === document.documentElement) && isHostCanvasImageBacked())
      return 'transparent';
    const style = getComputedStyle(current);
    if (style.backgroundImage && style.backgroundImage !== 'none') return 'transparent';
    const alpha = backgroundAlpha(style.backgroundColor);
    if (!(alpha > 0)) continue;
    return alpha >= 1 ? style.backgroundColor : 'transparent';
  }
  return 'transparent';
}
