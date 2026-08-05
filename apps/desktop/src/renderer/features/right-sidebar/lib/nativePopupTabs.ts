/** Runtime-only relation between persisted RSB tab ids and main-owned popup surfaces. */

const byTabId = new Map<string, { surfaceId: string; sessionId: string }>();
const bySurfaceId = new Map<string, { tabId: string; sessionId: string }>();

export function registerNativePopupTab(tabId: string, sessionId: string, surfaceId: string): void {
  byTabId.set(tabId, { surfaceId, sessionId });
  bySurfaceId.set(surfaceId, { tabId, sessionId });
}

export function findNativePopupTabBySurface(
  surfaceId: string,
): { tabId: string; sessionId: string } | null {
  return bySurfaceId.get(surfaceId) ?? null;
}

/** Runtime lookup used after plugin hydration strips non-persistent fields. */
export function findNativePopupSurfaceForTab(
  tabId: string,
): { surfaceId: string; sessionId: string } | null {
  return byTabId.get(tabId) ?? null;
}

/** Called only after the store has definitively removed the tab. */
export function closeNativePopupForTab(tabId: string): void {
  const entry = byTabId.get(tabId);
  if (!entry) return;
  byTabId.delete(tabId);
  bySurfaceId.delete(entry.surfaceId);
  const api = typeof window !== 'undefined' ? window.electronAPI?.rsbNativePopup : undefined;
  if (!api) return;
  void api.close({ surfaceId: entry.surfaceId }).catch(() => {
    // Guest window.close may have destroyed the surface before store cleanup.
  });
}

/** Test-only reset. */
export function _resetNativePopupTabsForTests(): void {
  byTabId.clear();
  bySurfaceId.clear();
}
