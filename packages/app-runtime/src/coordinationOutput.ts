import type { AgentEvent } from '@cindy/maker-core';

/** Preserve tool actions, errors, interactions and usage; only internal prose is omitted. */
export function projectCoordinationOutput(event: AgentEvent, coordination: boolean): AgentEvent | null {
  if (!coordination || event.runtimeRecovery) return event;
  if (event.type === 'text' || event.type === 'thinking') return null;
  if (event.type === 'done') {
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    return { ...event, data: { ...data, result: '', finalText: '' } };
  }
  return event;
}
