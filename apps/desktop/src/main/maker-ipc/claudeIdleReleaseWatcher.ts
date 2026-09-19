import type { Session } from '@cindy/maker-core';

/** Only live runtime capabilities; persistent task state is never modified here. */
export type IdleClaudeSession = Pick<Session, 'id' | 'agentKind' | 'remoteHostId' | 'sdkSessionId'
  | 'getStatus' | 'getTurnGeneration' | 'isTurnRunning' | 'listBackgroundTasks'
  | 'countPendingWakeContinuations' | 'onEvent' | 'closeIfIdle' | 'close'>;
export interface ClaudeIdleReleaseDeps {
  listSessions(): IdleClaudeSession[];
  getSession(id: string): IdleClaudeSession | undefined;
  readMinutes(): number;
  isOrdinaryTask(id: string, sdkSessionId: string): Promise<boolean>;
  hasPendingInput(id: string): Promise<boolean>;
  isHostBusy(id: string): boolean;
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  close(session: IdleClaudeSession, retryFailedClose: boolean): Promise<boolean>;
  now(): number;
  warn(message: string): void;
}

/** Scope query runs through the DB worker; source and ownership are host facts. */
export const ORDINARY_CLAUDE_TASK_SQL = `SELECT id FROM sessions s
WHERE s.id = ? AND s.status = 'active' AND s.source = 'desktop'
AND s.sdk_session_id = ? AND s.sdk_session_id != '<pending>'
AND s.agent_kind = 'claude-code' AND s.remote_host_id IS NULL AND s.orca_role IS NULL
AND NOT EXISTS (SELECT 1 FROM bot_session_links b WHERE b.session_id = s.id)
AND NOT EXISTS (SELECT 1 FROM orca_workers w WHERE w.session_id = s.id)
AND NOT EXISTS (SELECT 1 FROM orca_teams t WHERE t.lead_session_id = s.id AND t.status = 'active')
AND NOT EXISTS (SELECT 1 FROM session_goals g WHERE g.session_id = s.id AND g.status != 'complete')`;

/** Single-flight scans reuse the send lock and Session's atomic close-if-idle boundary. */
export function createClaudeIdleReleaseWatcher(deps: ClaudeIdleReleaseDeps) {
  const tracked = new Map<IdleClaudeSession, { since: number; generation: number; closeFailed: boolean; unsubscribe: () => void }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let epoch = 0;
  let scanning = false;
  const forget = (session: IdleClaudeSession) => {
    tracked.get(session)?.unsubscribe();
    tracked.delete(session);
  };
  const busy = (session: IdleClaudeSession, retryFailedClose = false) =>
    (session.getStatus() !== 'active' && !(retryFailedClose && session.getStatus() === 'error'))
    || !session.sdkSessionId || session.sdkSessionId === '<pending>' || session.isTurnRunning() || session.listBackgroundTasks().length > 0
    || session.countPendingWakeContinuations() > 0 || deps.isHostBusy(session.id);
  const scanNow = async () => {
    if (scanning) return;
    scanning = true;
    const scanEpoch = epoch;
    try {
      const minutes = deps.readMinutes();
      if (!Number.isFinite(minutes) || minutes <= 0) {
        for (const session of tracked.keys()) forget(session);
        return;
      }
      const sessions = deps.listSessions().filter(s => s.agentKind === 'claude-code' && !s.remoteHostId);
      const live = new Set(sessions);
      for (const session of tracked.keys()) if (!live.has(session)) forget(session);
      for (const session of sessions) {
        if (scanEpoch !== epoch) return;
        let state = tracked.get(session);
        if (!state) {
          state = { since: deps.now(), generation: session.getTurnGeneration(), closeFailed: false, unsubscribe: () => {} };
          const observed = state;
          // Includes short turns and background activity between scans; no event contents retained.
          state.unsubscribe = session.onEvent(() => { observed.since = deps.now(); });
          tracked.set(session, state);
        }
        try {
          await deps.withLock(session.id, async () => {
            if (scanEpoch !== epoch || deps.getSession(session.id) !== session) return;
            if (busy(session, state.closeFailed) || state.generation !== session.getTurnGeneration()) {
              state.since = deps.now();
              state.generation = session.getTurnGeneration();
              return;
            }
            if (deps.now() - state.since < minutes * 60_000) return;
            const sdkSessionId = session.sdkSessionId;
            if (!await deps.isOrdinaryTask(session.id, sdkSessionId) || await deps.hasPendingInput(session.id)) {
              state.since = deps.now();
              return;
            }
            // Queue restoration can yield to a Goal/Orca ownership transition.
            // Scope is the last asynchronous check; recheck live state below before closing.
            if (!await deps.isOrdinaryTask(session.id, sdkSessionId)) {
              state.since = deps.now();
              return;
            }
            // SQL/queue restoration can yield to a new turn, setting change, shutdown or replacement.
            const currentMinutes = deps.readMinutes();
            if (scanEpoch !== epoch || deps.getSession(session.id) !== session || busy(session, state.closeFailed)
              || session.getTurnGeneration() !== state.generation || session.sdkSessionId !== sdkSessionId
              || currentMinutes <= 0
              || !Number.isFinite(currentMinutes) || deps.now() - state.since < currentMinutes * 60_000) return;
            try {
              if (await deps.close(session, state.closeFailed)) forget(session);
            } catch (error) {
              // Session fences provider events and enters error after failed teardown.
              // Only our own failed close may be retried; unrelated error runtimes stay untouched.
              state.closeFailed = true;
              throw error;
            }
          });
        } catch {
          state.since = deps.now();
          deps.warn('Claude idle release skipped: runtime or task state unavailable');
        }
      }
    } catch {
      deps.warn('Claude idle release scan failed');
    } finally { scanning = false; }
  };
  return {
    scanNow,
    start() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => { void scanNow(); }, 60_000);
      timer.unref?.();
    },
    stop() {
      epoch += 1;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const session of tracked.keys()) forget(session);
    },
  };
}
