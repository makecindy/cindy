import { navigationChrome, spacing } from "@/theme/tokens";

/**
 * Where a preview tab's picture may be drawn. A plain remote desktop runs under
 * the floating controls, which is fine for a screen you only watch; a preview is
 * an app page whose buttons you press, so nothing may cover its clickable area.
 * The picture is fitted (contain) and centered in what these insets leave over.
 */
export interface PreviewViewportInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function previewViewportInsets(input: {
  landscape: boolean;
  /** Back button and toolbar share one column on the right (iPad side rail). */
  systemSideRail: boolean;
  toolbarOnLeft: boolean;
  /** The inset the screen already reserves above the picture (status bar). */
  paddingTop: number;
  /** The inset it already reserves below it (toolbar or keyboard panel). */
  bottom: number;
  safeBottom: number;
  backHeight: number;
  /** Left edge of the back button in landscape. */
  backLeft: number;
  toolbar: { width: number; height: number };
  sideRailWidth: number;
}): PreviewViewportInsets {
  const gap = spacing.sm;
  if (input.systemSideRail)
    return {
      top: input.paddingTop,
      bottom: input.bottom,
      left: 0,
      right: input.sideRailWidth,
    };
  if (!input.landscape)
    return {
      // Below the back button, the way an open keyboard already lifts a desktop.
      top: input.paddingTop + spacing.xs + input.backHeight + gap,
      bottom: input.bottom,
      left: 0,
      right: 0,
    };
  // Landscape: the back button is a column on the left, the toolbar a rail on one side.
  const backRight = input.backLeft + navigationChrome.target + gap;
  return {
    top: input.paddingTop,
    bottom: Math.max(input.bottom, input.safeBottom),
    left: input.toolbarOnLeft
      ? Math.max(input.toolbar.width, backRight)
      : backRight,
    right: input.toolbarOnLeft ? 0 : input.toolbar.width,
  };
}
