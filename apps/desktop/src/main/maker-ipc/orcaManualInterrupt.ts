export type OrcaManualInterruptReason = 'input_stop' | 'abort_session' | 'lead_interrupt';

export interface OrcaManualInterruptMark {
  markedAt: number;
  reason: OrcaManualInterruptReason;
}

export const ORCA_MANUAL_INTERRUPT_TTL_MS = 10 * 60 * 1000;

const manualInterrupts = new Map<string, OrcaManualInterruptMark>();
const knownOrcaWorkerSessionIds = new Set<string>();

/**
 * Tracks user-initiated stops for Orca worker sessions.
 *
 * The mark is intentionally non-destructive: both the desktop global turn-end
 * fallback and the package-level orca-workflow capture path must be able to
 * observe the same stop. The normal cleanup boundary is the next accepted worker
 * dispatch; the TTL only prevents stale marks from surviving abnormal paths.
 */
export function markManualInterrupt(
  sessionId: string,
  reason: OrcaManualInterruptReason,
  now = Date.now(),
): void {
  clearExpiredManualInterrupts(now);
  // A Lead interrupt reserves the next input before it reaches the ordinary
  // coordinator Stop path. Do not let that path overwrite the stronger reason;
  // terminal handling must suppress auto-bridge for the interrupted turn.
  if (manualInterrupts.get(sessionId)?.reason === 'lead_interrupt' && reason !== 'lead_interrupt') {
    return;
  }
  manualInterrupts.set(sessionId, { markedAt: now, reason });
}

export function getManualInterrupt(
  sessionId: string,
  now = Date.now(),
): OrcaManualInterruptMark | null {
  clearExpiredManualInterrupts(now);
  return manualInterrupts.get(sessionId) ?? null;
}

export function clearManualInterrupt(sessionId: string): void {
  manualInterrupts.delete(sessionId);
}

/** Restore the exact mark object captured before a provisional dispatch accepted. */
export function restoreManualInterrupt(
  sessionId: string,
  mark: OrcaManualInterruptMark,
): void {
  manualInterrupts.set(sessionId, mark);
}

export function clearExpiredManualInterrupts(now = Date.now()): number {
  let cleared = 0;
  for (const [sessionId, mark] of manualInterrupts) {
    if (now - mark.markedAt <= ORCA_MANUAL_INTERRUPT_TTL_MS) continue;
    manualInterrupts.delete(sessionId);
    cleared += 1;
  }
  return cleared;
}

export function markKnownOrcaWorkerSession(sessionId: string): void {
  knownOrcaWorkerSessionIds.add(sessionId);
}

export function forgetKnownOrcaWorkerSession(sessionId: string): void {
  knownOrcaWorkerSessionIds.delete(sessionId);
  clearManualInterrupt(sessionId);
}

export function isKnownOrcaWorkerSession(sessionId: string): boolean {
  return knownOrcaWorkerSessionIds.has(sessionId);
}

export function clearOrcaManualInterruptTestingState(): void {
  manualInterrupts.clear();
  knownOrcaWorkerSessionIds.clear();
}
