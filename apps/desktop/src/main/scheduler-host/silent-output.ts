import type { AgentEvent } from '@cindy/maker-core';

/** Run-scoped presentation gate. Raw provider events still reach the scheduler and usage ledger. */
const quietRuns = new Map<string, string>();

export function beginQuietScheduledOutput(scheduleId: string, runId: string): () => void {
  quietRuns.set(runId, scheduleId);
  return () => { if (quietRuns.get(runId) === scheduleId) quietRuns.delete(runId); };
}

export function isQuietScheduledOutput(event: AgentEvent): boolean {
  const origin = event.turnOrigin;
  return origin?.kind === 'scheduler' && typeof origin.runId === 'string'
    && quietRuns.get(origin.runId) === origin.scheduleId;
}

/** Do not replay a preamble when attention is requested: the runner publishes one final result. */
export function projectQuietScheduledOutput(event: AgentEvent): AgentEvent | null {
  if (!isQuietScheduledOutput(event)) return event;
  switch (event.type) {
    case 'text': case 'thinking': case 'tool_use': case 'tool_result': case 'tool_result_full':
    case 'image': case 'agent_task_update':
      return null;
    case 'done': {
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      return { ...event, data: { ...data, result: '', finalText: '' } };
    }
    default:
      // Permission requests, errors, usage and lifecycle events must stay visible/functional.
      return event;
  }
}
