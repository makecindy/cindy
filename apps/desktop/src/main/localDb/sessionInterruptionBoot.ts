import { hasPendingSessionInterruption, type SessionInterruptionState } from '@cindy/maker-shared/session-activity';
import { DESKTOP_VISIBLE_SESSION_SOURCES, type SessionSource } from '../../shared/sessionSource.js';

/** One host boot boundary for the pending-alert query and session serialization. */
let bootAtMs = Date.now();

export function getSessionInterruptionBootAt(): number {
  return bootAtMs;
}

/** Only the record owner can identify a still-pending interruption from a prior process. */
export function getHostInterruptedTurnStartedAt(source: SessionSource | null, session: SessionInterruptionState): number | null {
  const started = session.activeTurnStartedAt;
  if (started == null || started >= bootAtMs || !source || !DESKTOP_VISIBLE_SESSION_SOURCES.includes(source)) return null;
  return hasPendingSessionInterruption({ ...session, interruptedTurnStartedAt: started }) ? started : null;
}

/** Test-only: keep query and serialized interruption evidence on the same clock. */
export function setSessionInterruptionBootAtForTests(value: number): void {
  bootAtMs = value;
}
