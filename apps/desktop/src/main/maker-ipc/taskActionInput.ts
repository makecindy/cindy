import type { Session } from '@cindy/maker-core';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import { resolveGhostFsSessionSnapshot } from './ghostFsSessionSnapshot.js';

/** Read the shared input coordinator's live authority, never DB preferences or
 * text supplied by a plugin/client. Both execution hosts use this snapshot. */
export function readTaskActionInput(sessionId: string,
  getSession: (id: string) => Session | undefined, coordinator: AgentInputCoordinator | null, rewindLocked?: boolean) {
  const session = getSession(sessionId);
  const accepted = coordinator?.getAcceptedInputProvenance(sessionId) ?? null;
  const input = { input: accepted, executing: !!accepted || (session?.isTurnRunning() ?? false) };
  const ownerInput = coordinator?.isActiveInputOwnerAuthored(sessionId) ?? false;
  return {
    key: JSON.stringify(input),
    permission: resolveGhostFsSessionSnapshot(getSession, sessionId, session?.instanceId),
    ownerInput,
    automatic: !!input.input && !ownerInput,
    orcaSenderSessionId: input.input?.orcaSenderSessionId,
    boundary: `${session?.instanceId ?? ''}:${coordinator?.getGeneration(sessionId) ?? -1}`,
    clearBoundaryMs: coordinator?.getClearBoundaryMs(sessionId) ?? null,
    ...(rewindLocked !== undefined && coordinator ? { rewind: {
      generation: coordinator.getGeneration(sessionId),
      signal: coordinator.getInputAbortSignal(sessionId),
      locked: rewindLocked,
      idle: !input.executing,
    } } : {}),
  };
}
