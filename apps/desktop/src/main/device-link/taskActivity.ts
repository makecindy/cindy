import type { AgentIslandSessionSnapshot } from '../../shared/agentIsland.js';

/** Full execution-host projection, independent of Home pagination and island UI visibility. */
export function projectHostTaskActivity(snapshots: readonly AgentIslandSessionSnapshot[]) {
  const candidates = snapshots.filter(
    (row) =>
      !row.groupChat &&
      (row.phase === 'running' || row.phase === 'needs-interaction' || row.attention),
  );
  const rank = { 'needs-interaction': 0, completed: 1, error: 1, running: 2 };
  candidates.sort((a, b) => rank[a.phase] - rank[b.phase]);
  const first = candidates[0];
  return {
    schemaVersion: 1 as const,
    waitingCount: candidates.filter((row) => row.phase === 'needs-interaction').length,
    unreadCount: candidates.filter((row) => row.phase === 'completed' || row.phase === 'error')
      .length,
    runningCount: candidates.filter((row) => row.phase === 'running').length,
    selected: first
      ? {
          sessionId: first.sessionId,
          title: [...first.title].slice(0, 100).join(''),
          status: first.phase === 'needs-interaction' ? 'attention' : first.phase,
        }
      : null,
  };
}

/** One outstanding whole snapshot, with a bounded trailing flush for event bursts.
 * Heartbeats refresh server freshness; no per-task polling or notification fanout. */
export function createTaskActivityPublisher(send: (signal: AbortSignal) => Promise<void>) {
  let active = false;
  let disposed = false;
  let request: AbortController | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  const flush = async () => {
    timer = undefined;
    if (!active || disposed || request) return;
    pending = false;
    const captured = generation;
    const controller = new AbortController();
    request = controller;
    try {
      await send(controller.signal);
    } catch {
      /* best effort; next state/heartbeat re-sends the full snapshot */
    } finally {
      if (captured === generation) {
        request = undefined;
        if (pending && active) schedule();
      }
    }
  };
  const schedule = () => {
    if (!active || disposed) return;
    pending = true;
    if (!request && !timer)
      timer = setTimeout(() => {
        void flush();
      }, 1_000);
  };
  const setOnline = (online: boolean) => {
    generation += 1;
    request?.abort();
    request = undefined;
    clearTimeout(timer);
    timer = undefined;
    clearInterval(heartbeat);
    heartbeat = undefined;
    active = online;
    if (online && !disposed) {
      schedule();
      heartbeat = setInterval(schedule, 60_000);
      heartbeat.unref?.();
    }
  };
  return {
    changed: schedule,
    setOnline,
    dispose() {
      setOnline(false);
      disposed = true;
    },
  };
}
