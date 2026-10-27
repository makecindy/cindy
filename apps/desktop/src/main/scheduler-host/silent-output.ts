import type { AgentEvent, SendOrigin } from '@cindy/maker-core';
import type { Schedule } from '@cindy/maker-scheduler';

/** Live scheduler policy, registered by the scheduler host; IM relays read it without loading the host. */
let silencedRunProbe: ((runId: string) => boolean) | null = null;

export function setSilencedRunProbe(probe: ((runId: string) => boolean) | null): void {
  silencedRunProbe = probe;
}

/**
 * Whether this scheduler turn's run is currently silenced. Read it synchronously at the turn's
 * terminal event: the run is still in flight then, and the agent's notify/silence call is final.
 * Unknown runs (restart, hook origins without runId) are not silenced, matching completion alerts.
 */
export function isSilencedSchedulerTurn(origin: SendOrigin | undefined): boolean {
  return (
    origin?.kind === 'scheduler' &&
    typeof origin.runId === 'string' &&
    silencedRunProbe?.(origin.runId) === true
  );
}

/** Ordinary tasks keep their transcript even when completion notifications are silent. */
export function hidesScheduledTranscript(
  schedule: Pick<Schedule, 'source' | 'silentWhenIdle'> & Partial<Pick<Schedule, 'id'>>,
): boolean {
  // Routine backing schedules now run in independent lanes: keep their full inspectable transcript.
  // Legacy non-routine Bot schedules may still target the main timeline.
  return schedule.source === 'bot' && schedule.silentWhenIdle === true && !schedule.id?.startsWith('routine-');
}

/** Run-scoped presentation gate. Raw provider events still reach the scheduler and usage ledger. */
const quietRuns = new Map<string, string>();
const visibleRuns = new Set<string>();

export function beginQuietScheduledOutput(scheduleId: string, runId: string): () => void {
  quietRuns.set(runId, scheduleId);
  return () => {
    if (quietRuns.get(runId) === scheduleId) quietRuns.delete(runId);
    visibleRuns.delete(runId);
  };
}

/** Presentation only: keep the scheduler origin and its execution authority intact. */
export function revealScheduledOutput(origin: SendOrigin | undefined): void {
  if (origin?.kind === 'scheduler' && origin.runId
    && quietRuns.get(origin.runId) === origin.scheduleId) visibleRuns.add(origin.runId);
}

export function hasVisibleScheduledOutput(runId: string): boolean {
  return visibleRuns.has(runId);
}

export function isQuietScheduledOutput(event: AgentEvent): boolean {
  const origin = event.turnOrigin;
  return (
    origin?.kind === 'scheduler' &&
    typeof origin.runId === 'string' &&
    !visibleRuns.has(origin.runId) &&
    quietRuns.get(origin.runId) === origin.scheduleId
  );
}

/** Do not replay a preamble when attention is requested: the runner publishes one final result. */
export function projectQuietScheduledOutput(event: AgentEvent): AgentEvent | null {
  if (!isQuietScheduledOutput(event)) return event;
  switch (event.type) {
    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
    case 'tool_result_full':
    case 'image':
    case 'agent_task_update':
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
