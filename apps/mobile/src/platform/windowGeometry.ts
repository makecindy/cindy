import { navigationChrome, spacing } from '@/theme/tokens';

/** Geometry is local to the observed window container, in points, never pixels. */
export interface LayoutRect { x: number; y: number; width: number; height: number }
export interface ReservedRegion extends LayoutRect { kind: 'division' | 'occlusion' }
export interface WindowGeometry {
  width: number;
  height: number;
  insets: { top: number; right: number; bottom: number; left: number };
  regularWidth: boolean;
  regularHeight: boolean;
  barEdge: 'none' | 'left' | 'right';
  regions: ReservedRegion[];
  reservedRegionsSupported: boolean;
}

export function safeWindowRect(g: WindowGeometry): LayoutRect {
  return { x: g.insets.left, y: g.insets.top,
    width: Math.max(0, g.width - g.insets.left - g.insets.right),
    height: Math.max(0, g.height - g.insets.top - g.insets.bottom) };
}

/** Accept only divisions spanning the container; a clipped/offscreen fold is not a split. */
export function windowDivision(g: WindowGeometry): { axis: 'vertical' | 'horizontal'; first: LayoutRect; second: LayoutRect } | null {
  const safe = safeWindowRect(g);
  for (const r of g.regions) {
    if (r.kind !== 'division' || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    if (r.height >= safe.height * 0.8 && r.width > 0 && r.x > safe.x && r.x + r.width < safe.x + safe.width) {
      return { axis: 'vertical', first: { ...safe, width: r.x - safe.x },
        second: { ...safe, x: r.x + r.width, width: safe.x + safe.width - r.x - r.width } };
    }
    if (r.width >= safe.width * 0.8 && r.height > 0 && r.y > safe.y && r.y + r.height < safe.y + safe.height) {
      return { axis: 'horizontal', first: { ...safe, height: r.y - safe.y },
        second: { ...safe, y: r.y + r.height, height: safe.y + safe.height - r.y - r.height } };
    }
  }
  return null;
}

/** Keep a floating control group together, in the trailing/bottom region, clear of camera occlusions. */
export function controlRegion(g: WindowGeometry): LayoutRect {
  return avoidReservedRegions(windowDivision(g)?.second ?? safeWindowRect(g), g.regions.filter(r => r.kind === 'occlusion'));
}

/** Fit a complete control group into one remaining rectangle, never across a reservation. */
export function avoidReservedRegions(initial: LayoutRect, regions: LayoutRect[]): LayoutRect {
  let area = initial;
  for (const r of regions) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) continue;
    const right = area.x + area.width, bottom = area.y + area.height;
    if (r.x >= right || r.y >= bottom || r.x + r.width <= area.x || r.y + r.height <= area.y) continue;
    const candidates: LayoutRect[] = [
      { ...area, height: Math.max(0, r.y - area.y) },
      { ...area, y: r.y + r.height, height: Math.max(0, bottom - r.y - r.height) },
      { ...area, width: Math.max(0, r.x - area.x) },
      { ...area, x: r.x + r.width, width: Math.max(0, right - r.x - r.width) },
    ];
    area = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  }
  return area;
}


/** A docked keyboard can cover the lower fold region completely. Prefer a usable
 * upper region then; callers using this rect must not apply keyboard padding twice. */
export function keyboardControlRegion(g: WindowGeometry, keyboardBottom: number): LayoutRect {
  const bottom = g.height - Math.max(0, keyboardBottom);
  const clip = (r: LayoutRect) => ({ ...r, height: Math.max(0, Math.min(r.height, bottom - r.y)) });
  const controls = clip(controlRegion(g));
  const split = windowDivision(g);
  if (controls.height >= 140 || split?.axis !== 'horizontal') return controls;
  const upper = controlRegion({ ...g, insets: { ...g.insets, bottom: g.height - split.first.y - split.first.height },
    regions: g.regions.filter(r => r.kind !== 'division') });
  const alternative = clip(upper);
  return alternative.height > controls.height ? alternative : controls;
}

/**
 * Edges of a page's own floating top row (close, title, menu) where no native bar hosts it.
 * Duo portrait reports its status area as a trailing-corner reservation; like the native bar,
 * the row then shares that status row, its controls `spacing.md` above the row's bottom and
 * ending before the reservation. A vertical system bar (Duo landscape) leaves no top inset,
 * so the row keeps its own margin from the screen edge.
 */
export function floatingTopRow(g: WindowGeometry, rowHeight: number): {
  top: number; left: number; right: number; sharedStatusRow: boolean;
} {
  const left = g.insets.left + spacing.md, right = g.insets.right + spacing.md;
  if (g.barEdge !== 'none') return { top: Math.max(g.insets.top, spacing.md), left, right, sharedStatusRow: false };
  const ordinary = { top: g.insets.top, left, right, sharedStatusRow: false };
  const status = g.regions.filter(r => r.kind === 'occlusion' && r.y === 0 && r.x + r.width >= g.width);
  const top = g.insets.top - rowHeight - spacing.md;
  if (!g.reservedRegionsSupported || !g.regularWidth || !status.length || top < spacing.md) return ordinary;
  const sharedRight = Math.max(right, g.width - Math.min(...status.map(r => r.x)) + spacing.sm);
  const row = { x: left, y: top, width: g.width - left - sharedRight, height: rowHeight };
  // Close, title and menu must all fit beside the status area, clear of any other reservation.
  if (row.width < rowHeight * 5 || avoidReservedRegions(row, g.regions.filter(r => !status.includes(r))) !== row) return ordinary;
  return { top, left, right: sharedRight, sharedStatusRow: true };
}

/**
 * Top padding for the temporary task-list drawer when the native top bar shares the status row
 * (Duo portrait), so the drawer header lands where the hidden bar's buttons were. Duo (iOS 27.1)
 * centers toolbar items `spacing.md` above the row's bottom; the drawer header adds `spacing.lg`
 * itself. Undefined keeps the safe-area top for ordinary bars below the status area.
 */
export function sharedStatusRowDrawerTop(nativeHeaderHeight: number, safeAreaTop: number): number | undefined {
  if (!(nativeHeaderHeight > 0) || nativeHeaderHeight >= safeAreaTop + navigationChrome.target) return undefined;
  return Math.max(0, nativeHeaderHeight - navigationChrome.target - spacing.md - spacing.lg);
}
