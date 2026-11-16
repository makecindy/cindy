/** Matches LayoutRoot's CSS clamp and each visible panel's 1px divider. */
export function sidebarExpansionWidth(
  width: number,
  panels: { share: number; min: number; sidebar: boolean; preferredWidth?: number }[],
): number {
  const chatWidth = (available: number, open: boolean) => available - panels.reduce(
    (sum, panel) => sum + (!open && panel.sidebar ? 0 :
      1 + Math.max(panel.min, Math.min(panel.preferredWidth ?? panel.share * available, available - 400))), 0,
  );
  const target = chatWidth(width, false);
  let low = 0;
  let high = 16000;
  // Solve against the same clamped proportions, including other docked panels.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (chatWidth(width + middle, true) < target) low = middle + 1;
    else high = middle;
  }
  return high;
}
