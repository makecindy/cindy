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
