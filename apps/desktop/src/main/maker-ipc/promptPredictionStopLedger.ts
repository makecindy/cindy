/**
 * Main-owned explicit Stop ledger for prompt prediction.
 *
 * Every local/Device Link `maker:input:stop` passes through the same IPC handler, so this
 * set is the cross-window authority. A real next turn clears the marker at the central
 * maker-core turn-start boundary. Nothing is persisted across app restarts.
 */
const explicitlyStoppedSessions = new Set<string>();
const cancelledRevisions = new Map<string, { revision: number; ownerScope: string }>();

export function notePromptPredictionSessionStopped(sessionId: string): void {
  if (sessionId) explicitlyStoppedSessions.add(sessionId);
}

export function clearPromptPredictionSessionStopped(sessionId: string): void {
  explicitlyStoppedSessions.delete(sessionId);
}

export function wasPromptPredictionSessionStopped(sessionId: string): boolean {
  return explicitlyStoppedSessions.has(sessionId);
}

/** Preference changes cancel an in-flight prediction without pretending the user stopped a turn. */
export function notePromptPredictionSessionCancelled(
  sessionId: string, revision: number, ownerScope: string,
): void {
  const previous = cancelledRevisions.get(sessionId);
  if (previous?.ownerScope === ownerScope && previous.revision > revision) return;
  cancelledRevisions.set(sessionId, { revision, ownerScope });
}

export function wasPromptPredictionSessionCancelled(
  sessionId: string, revision: number, ownerScope: string,
): boolean {
  const cancelled = cancelledRevisions.get(sessionId);
  return cancelled?.ownerScope === ownerScope && revision <= cancelled.revision;
}

export function resetPromptPredictionStopLedgerForTests(): void {
  explicitlyStoppedSessions.clear();
  cancelledRevisions.clear();
}
