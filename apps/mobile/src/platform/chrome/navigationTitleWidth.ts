import { navigationChrome, spacing } from '@/theme/tokens';

/**
 * Widest a custom native-bar title may be. UIKit gives the title only the space
 * between the bar items (their chrome targets), the side margins and its own gap
 * on each side (measured: 204pt of 402 with one leading and two trailing items).
 * A wider title view is centered and clipped at both ends, cutting off trailing
 * glyphs such as a menu chevron. RN lays the title out before UIKit sizes it, so
 * callers cap it explicitly and let the text ellipsize instead.
 */
export function navigationTitleMaxWidth(windowWidth: number, { barItems = 3, max = 260 }: { barItems?: number; max?: number } = {}): number {
  return Math.max(0, Math.min(max, windowWidth - barItems * navigationChrome.target - 4 * spacing.lg));
}

/**
 * The task title fits between the leading controls and the trailing actions capsule,
 * accounting for their gaps and UIKit's side margins. UIKit cannot shrink a fixed-size React title, so the budget counts everything that takes room in
 * that row. On a shared status row (Duo portrait) the capsule sits left of the status area,
 * which widens and narrows with a Live Activity: pass that width as `statusRowReserve`
 * (sharedStatusRowTrailingReserve), or the title runs under the capsule.
 */
export function sessionNavigationTitleMaxWidth({ barWidth, additionalListButton, detailsOnly, statusRowReserve = 0 }: {
  barWidth: number;
  /** True only when Back and the task list share the leading edge. */
  additionalListButton: boolean;
  /** Only "more" remains in the trailing capsule (worker and side-chat tasks). */
  detailsOnly: boolean;
  statusRowReserve?: number;
}): number {
  const items = (additionalListButton ? 2 : 1) + (detailsOnly ? 1 : 3);
  return Math.max(0, Math.min(240,
    barWidth - Math.max(0, statusRowReserve) - (spacing.lg + spacing.xs) * 2
      - navigationChrome.target * items - (additionalListButton ? spacing.sm : 0) - spacing.sm * 2));
}
