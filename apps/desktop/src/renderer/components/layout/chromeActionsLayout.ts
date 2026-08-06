export function shouldReserveLeftChromeActions({
  isSidebarCollapsed,
  rightSidebarSide,
  isRightSidebarMaximized,
}: {
  isSidebarCollapsed: boolean;
  rightSidebarSide: 'left' | 'right';
  isRightSidebarMaximized: boolean;
}): boolean {
  return isSidebarCollapsed && (rightSidebarSide === 'left' || isRightSidebarMaximized);
}
