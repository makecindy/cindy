/** Crash isolation registration survives destroyed/gone event ordering. */
const ids = new Set<number>();
export const markRemoteDesktopViewer = (id: number): void => {
  ids.add(id);
};
export const isRemoteDesktopViewer = (id: number): boolean => ids.has(id);
