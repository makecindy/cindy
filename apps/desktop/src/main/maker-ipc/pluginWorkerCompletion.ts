/** Recover a released Worker only from the host-stamped final turn, never report text. */
export function pluginWorkerCompletedAt(input: {
  status: string; working: boolean; queued: number; paused: boolean;
  startedAt: number | null; endedAt: number | null; clearedAt?: number | null;
  anchor?: {role: string; createdAt: number; agentMeta: string | null};
}): number | null {
  if (input.working || input.queued !== 0 || input.paused || !['idle', 'done'].includes(input.status)) return null;
  const {startedAt, endedAt, anchor} = input;
  if (!startedAt || !endedAt || endedAt < startedAt || !anchor || anchor.role !== 'assistant' || anchor.createdAt < startedAt || anchor.createdAt > endedAt || anchor.createdAt <= (input.clearedAt ?? 0)) return null;
  try {
    const meta = JSON.parse(anchor.agentMeta ?? '{}');
    return meta?.turnCompleted === true && !meta.parentUuid ? endedAt : null;
  } catch { return null; }
}
