import type { AgentEvent } from '@cindy/maker-core';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';

/** Read at each boundary: delivery/idle callbacks may change recovery ownership. */
export function isSessionErrorSuppressed(
  coordinator: Pick<AgentInputCoordinator, 'isAutoResumePending' | 'isAutoResumeDeferred'> | null,
  sessionId: string,
  event: AgentEvent,
): boolean {
  return (
    event.type === 'error' &&
    (coordinator?.isAutoResumePending(sessionId) === true ||
      coordinator?.isAutoResumeDeferred(sessionId) === true)
  );
}
