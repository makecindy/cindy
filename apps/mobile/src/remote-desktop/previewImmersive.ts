import { navigationChrome, spacing } from "@/theme/tokens";

/**
 * Immersive preview: on a phone with a camera cutout, the back button sits left
 * of the cutout and keyboard / settings right of it, so the picture can use the
 * whole screen below the top safe area and above the bottom one. Everything
 * else (phones without a cutout, landscape, an iPad side rail, Android, a whole
 * remote desktop) keeps the floating controls as they are.
 */

/** Notch and Dynamic Island phones report a top safe area of at least 44pt. */
export const IMMERSIVE_MIN_SAFE_TOP = 44;
/** Dynamic Island phones report 54pt or more; notch phones 50pt or less. */
const ISLAND_MIN_SAFE_TOP = 52;
const ISLAND_WIDTH = 126;
const NOTCH_WIDTH = 210;
/** Keyboard and settings buttons share one 2 x 44pt group. */
export const IMMERSIVE_ACTION_COUNT = 2;

/**
 * The cutout hides whatever is drawn under it, so the right group must fit in
 * the strip between the cutout and the screen edge. Cutout widths are not
 * reported, so they are estimated from the top inset (island vs. notch); a
 * narrow notch phone then keeps the old layout instead of losing a button.
 */
export function immersiveSideRoom(safeTop: number, windowWidth: number): number {
  const cutout = safeTop >= ISLAND_MIN_SAFE_TOP ? ISLAND_WIDTH : NOTCH_WIDTH;
  return (windowWidth - cutout) / 2;
}

export function previewImmersiveEnabled(input: {
  /** A plugin preview tab, not a whole remote desktop. */
  preview: boolean;
  ios: boolean;
  /** Landscape, including an iPad side rail. */
  landscape: boolean;
  /** Split-screen or foldable table region layouts. */
  split: boolean;
  safeTop: number;
  windowWidth: number;
}): boolean {
  if (!input.preview || !input.ios || input.landscape || input.split)
    return false;
  if (input.safeTop < IMMERSIVE_MIN_SAFE_TOP) return false;
  const needed =
    spacing.lg + navigationChrome.target * IMMERSIVE_ACTION_COUNT + spacing.sm;
  return immersiveSideRoom(input.safeTop, input.windowWidth) >= needed;
}

/** Top edge of a 44pt control centered in the top safe area. */
export function immersiveControlsTop(safeTop: number): number {
  return Math.max(0, (safeTop - navigationChrome.target) / 2);
}
