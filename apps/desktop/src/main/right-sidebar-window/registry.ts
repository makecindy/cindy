/**
 * RSB window WebContents id registry.
 *
 * The RSB window is an independently recoverable auxiliary renderer; its crash
 * must not trigger the main app's fatal exit chain. WebContents ids never get
 * reused within one Electron process, so an add-only set covers the gone/closed
 * event race.
 */

const rsbWindowWebContentsIds = new Set<number>();

export function markRsbWindowWebContentsId(id: number): void {
  rsbWindowWebContentsIds.add(id);
}

export function isRsbWindowWebContentsId(id: number): boolean {
  return rsbWindowWebContentsIds.has(id);
}
