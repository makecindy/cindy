import { ORCA_WORKER_READY_MESSAGE } from './orcaLifecycleService.js';

/** Recover a released Worker only from the host-stamped final turn, never report text. */
export function pluginWorkerCompletedAt(input: {
  status: string; working: boolean; queued: number; paused: boolean;
  startedAt: number | null; endedAt: number | null; clearedAt?: number | null;
  anchor?: {role: string; createdAt: number; agentMeta: string | null};
  taskInput?: {createdAt: number; content: string};
}): number | null {
  if (input.working || input.queued !== 0 || input.paused || !['idle', 'done'].includes(input.status)) return null;
  const {startedAt, endedAt, anchor} = input;
  if (!startedAt || !endedAt || endedAt < startedAt || !anchor || anchor.role !== 'assistant' || anchor.createdAt < startedAt || anchor.createdAt > endedAt || anchor.createdAt <= (input.clearedAt ?? 0)) return null;
  // A ready placeholder can finish a native turn without any persisted task input.
  // Imported ready inputs likewise cannot stand in for the Lead's real assignment.
  if (!input.taskInput || input.taskInput.createdAt <= (input.clearedAt ?? 0) || input.taskInput.createdAt > anchor.createdAt) return null;
  let content: unknown = input.taskInput.content;
  try { content = JSON.parse(input.taskInput.content); } catch { /* Plain imported text. */ }
  if (content === ORCA_WORKER_READY_MESSAGE || (typeof content === 'object' && content !== null && 'text' in content && content.text === ORCA_WORKER_READY_MESSAGE)) return null;
  try {
    const meta = JSON.parse(anchor.agentMeta ?? '{}');
    return meta?.turnCompleted === true && !meta.parentUuid ? endedAt : null;
  } catch { return null; }
}
