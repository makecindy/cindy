/**
 * Main-owned explicit Stop ledger for prompt prediction.
 *
 * Every local/Device Link `maker:input:stop` passes through the same IPC handler, so this
 * set is the cross-window authority. A real next turn clears the marker at the central
 * maker-core turn-start boundary. Nothing is persisted across app restarts.
 */
const explicitlyStoppedSessions = new Set<string>();

export function notePromptPredictionSessionStopped(sessionId: string): void {
  if (sessionId) explicitlyStoppedSessions.add(sessionId);
}

export function clearPromptPredictionSessionStopped(sessionId: string): void {
  explicitlyStoppedSessions.delete(sessionId);
}

export function wasPromptPredictionSessionStopped(sessionId: string): boolean {
  return explicitlyStoppedSessions.has(sessionId);
}

export function resetPromptPredictionStopLedgerForTests(): void {
  explicitlyStoppedSessions.clear();
}
