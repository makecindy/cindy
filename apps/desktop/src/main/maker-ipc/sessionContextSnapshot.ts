/**
 * Which status events carry a context snapshot (tokens used, window) to write back to the task row,
 * and what that snapshot is. Moved out of prepareSessionEvent (sessionEventPreparation.ts) so the
 * Node Host decides from the same events with the same rules; its model-window gate reads the usage
 * these snapshots write.
 *
 * prepareSessionEvent calls isContextCompactionSnapshot where it computed isCompactionSnapshot, before
 * its foreground-turn bookkeeping (it reads the session's instance and turn generation), and
 * contextSnapshotForStatus where it assembled pendingContextSnapshot.
 */
import type { AgentEvent, Session } from '@cindy/maker-core';

/** The fields of a status event's data these decisions read. */
export interface ContextSnapshotStatusData {
  isRunning?: boolean;
  status?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextSnapshotAuthoritative?: boolean;
}

/** prepareSessionEvent's isCompactionSnapshot: an authoritative Pi compaction snapshot of the current turn. */
export function isContextCompactionSnapshot(
  session: Pick<Session, 'instanceId' | 'getTurnGeneration'>,
  event: AgentEvent,
  data: ContextSnapshotStatusData,
): boolean {
  return event.source === 'pi' && data.isRunning === true
    && data.contextSnapshotAuthoritative === true && event.turnScope !== 'background'
    && (event.sessionInstanceId === undefined || event.sessionInstanceId === session.instanceId)
    && (event.sessionTurnGeneration === undefined || event.sessionTurnGeneration === session.getTurnGeneration())
    && typeof data.contextTokens === 'number' && Number.isFinite(data.contextTokens) && data.contextTokens >= 0
    && typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow) && data.contextWindow > 0;
}

/**
 * The snapshot a status event carries: on an authoritative compaction snapshot, or when a turn ends
 * (isRunning false, Done) with its token count; otherwise none (prepareSessionEvent keeps no snapshot).
 */
export function contextSnapshotForStatus(
  isCompactionSnapshot: boolean,
  data: ContextSnapshotStatusData,
): { contextTokens: number; contextWindow: number } | null {
  if (
    (isCompactionSnapshot || (data.isRunning === false && data.status === 'Done')) &&
    typeof data.contextTokens === 'number'
  ) {
    return {
      contextTokens: data.contextTokens,
      contextWindow: data.contextWindow ?? 0,
    };
  }
  return null;
}
