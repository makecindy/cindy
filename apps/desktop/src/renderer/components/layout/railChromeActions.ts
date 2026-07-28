export interface RailChromeActionsOwnerInput {
  hasRailChromeActions: boolean;
  rightSidebarSide: 'left' | 'right';
  rightSidebarAvailable: boolean;
  rightSidebarLoaded: boolean;
  isRightSidebarCollapsed: boolean;
  isRightSidebarMaximized: boolean;
  rsbDetached: boolean;
}

/**
 * The rail ChromeActions hit hole belongs to the leftmost rendered pane. A
 * saved left-side layout alone is not enough: the right sidebar can be absent
 * while its route capability is resolving, detached, or collapsed. Maximized
 * right sidebars also own the hole because they become the only rendered pane.
 */
export function rightSidebarOwnsRailChromeActions({
  hasRailChromeActions,
  rightSidebarSide,
  rightSidebarAvailable,
  rightSidebarLoaded,
  isRightSidebarCollapsed,
  isRightSidebarMaximized,
  rsbDetached,
}: RailChromeActionsOwnerInput): boolean {
  const isRendered = rightSidebarAvailable && rightSidebarLoaded && !isRightSidebarCollapsed && !rsbDetached;

  return (
    hasRailChromeActions &&
    isRendered &&
    (rightSidebarSide === 'left' || isRightSidebarMaximized)
  );
}
