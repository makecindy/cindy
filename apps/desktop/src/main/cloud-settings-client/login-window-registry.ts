// IDs are never reused within an Electron process; retain them through crash/close races.
const ids = new Set<number>();
export const markCloudLoginWindow = (id: number): void => {
  ids.add(id);
};
export const isCloudLoginWindow = (id: number): boolean => ids.has(id);
