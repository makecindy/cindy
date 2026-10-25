/** Runtime services used by both native Desktop and the Node host. */
export interface SessionGitSnapshots {
  hasPendingTurnStart(sessionId: string): boolean;
  onTurnStart(sessionId: string): Promise<void>;
  onTurnEnd(sessionId: string): Promise<void>;
  onTurnAbort(sessionId: string): void;
}

export interface SessionTurnLeaseReader {
  turnLeaseIdForEvent(event: object): string | undefined;
}

/** Terminal receipt captured before another queued turn can begin. */
export interface SessionDelegationSettler {
  settleSession(params: {
    childSessionId: string;
    outcome: 'done' | 'error';
    execution?: { instanceId: string; generation: number } | null;
    expectedRunSequence?: number;
    resultMessageClientId?: string;
    pendingInputClientIds?: string[];
    resultText?: string;
    error?: string;
    hadPendingInputAtTerminal?: boolean;
  }): Promise<void>;
}
