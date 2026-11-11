/**
 * Router state that hands an Agent Island click to a route whose own ownership
 * gate disposes the card once it has actually shown the Session (history).
 */
export function islandEntryRouteState(islandEntryId: string): { islandEntryId: string } {
  return { islandEntryId };
}

export function readIslandEntryRouteState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as { islandEntryId?: unknown }).islandEntryId;
  return typeof value === 'string' && value ? value : null;
}

/** Main disposes the card only for its latest click and while that card is unchanged. */
export function requestIslandEntryAlertDisposal(sessionId: string, islandEntryId: string): void {
  void window.electronAPI.agentIsland?.consumeEntryAlert?.(sessionId, islandEntryId).catch(() => undefined);
}
