// Keep the close path independent of the lazily loaded xterm bundle.
const closingCallbacks = new Map<string, (closing: boolean) => void>();
const closingCounts = new Map<string, number>();

export function registerClosing(tabId: string, callback: (closing: boolean) => void): void {
  closingCallbacks.set(tabId, callback);
  if (closingCounts.has(tabId)) callback(true);
}

export function unregisterClosing(tabId: string): void {
  closingCallbacks.delete(tabId);
}

export function markClosing(tabId: string): void {
  closingCounts.set(tabId, (closingCounts.get(tabId) ?? 0) + 1);
  closingCallbacks.get(tabId)?.(true);
}

/** Called when the store finishes or rolls back the close mutation. */
export function finishClosing(tabId: string): void {
  const count = closingCounts.get(tabId);
  if (!count) return;
  if (count > 1) {
    closingCounts.set(tabId, count - 1);
    return;
  }
  closingCounts.delete(tabId);
  closingCallbacks.get(tabId)?.(false);
}
