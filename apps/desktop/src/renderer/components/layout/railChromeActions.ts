export interface RailChromeActionsOwnerInput {
  hasRailChromeActions: boolean;
  rightSidebarSide: 'left' | 'right';
  rightSidebarAvailable: boolean;
  rightSidebarLoaded: boolean;
  isRightSidebarCollapsed: boolean;
  rsbDetached: boolean;
}

/**
 * The rail ChromeActions hit hole belongs to the leftmost rendered pane. A
 * saved left-side layout alone is not enough: the right sidebar can be absent
 * while its route capability is resolving, detached, or collapsed.
 */
export function rightSidebarOwnsRailChromeActions({
  hasRailChromeActions,
  rightSidebarSide,
  rightSidebarAvailable,
  rightSidebarLoaded,
  isRightSidebarCollapsed,
  rsbDetached,
}: RailChromeActionsOwnerInput): boolean {
  return (
    hasRailChromeActions &&
    rightSidebarSide === 'left' &&
    rightSidebarAvailable &&
    rightSidebarLoaded &&
    !isRightSidebarCollapsed &&
    !rsbDetached
  );
}
