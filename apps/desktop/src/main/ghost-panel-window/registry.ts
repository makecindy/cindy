/**
 * Ghost panel windows are independently recoverable auxiliary renderers.
 * Keep their WebContents ids registered so a crash cannot take down the app.
 */

const ghostPanelWebContentsIds = new Set<number>();

export function markGhostPanelWebContentsId(id: number): void {
  ghostPanelWebContentsIds.add(id);
}

export function isGhostPanelWebContentsId(id: number): boolean {
  return ghostPanelWebContentsIds.has(id);
}
