function hasOpaqueBackground(color: string): boolean {
  const normalized = color.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') return false;
  const legacyAlpha = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  if (legacyAlpha) return Number(legacyAlpha[1]) > 0;
  const modernAlpha = normalized.match(/\/\s*([0-9.]+%?)\s*\)$/);
  if (modernAlpha) {
    const alpha = modernAlpha[1].endsWith('%')
      ? Number.parseFloat(modernAlpha[1]) / 100
      : Number.parseFloat(modernAlpha[1]);
    return alpha > 0;
  }
  return true;
}

/** Find the first painted card background that can cover a missing child frame. */
export function findMcpAppBackdropColor(element: Element): string {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = getComputedStyle(current).backgroundColor;
    if (hasOpaqueBackground(color)) return color;
  }
  return 'transparent';
}
