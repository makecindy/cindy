import type { DbClient } from '../localDb/client/DbClient.js';
import { withSessionRouteLocks } from '../localDb/sessionRouteLock.js';

export interface ArchiveSessionRow {
  id: string;
  sdkSessionId: string;
  remoteHostId: string | null;
  status: 'active' | 'archived';
}

const SELECT = `SELECT id, sdk_session_id AS sdkSessionId, remote_host_id AS remoteHostId, status
  FROM sessions WHERE agent_kind = 'codex' AND sdk_session_id IS NOT NULL
  AND status IN ('active', 'archived')`;

const NATIVE_RECHECK_MS = 5 * 60_000;

/** Keep idle active handles available to their native writer; only archived
 * handles need closing before the native archive operation. Called under route locks. */
export async function prepareArchiveSessions(
  rows: ArchiveSessionRow[],
  getSession: (id: string) => {
    getStatus(): string; isTurnRunning(): boolean; closeIfIdle(): Promise<boolean>;
  } | undefined,
): Promise<boolean> {
  const live = rows.map(row => getSession(row.id))
    .filter((session): session is NonNullable<typeof session> => session !== undefined && session.getStatus() !== 'closed');
  if (live.some(session => session.isTurnRunning())) return false;
  if (rows.some(row => row.status === 'active')) return true;
  for (const session of live) if (!await session.closeIfIdle()) return false;
  return true;
}

/** Reconcile native storage without changing Cindy metadata or interrupting live work.
 * The database is the durable retry source; no second status store or schema is needed.
 */
export function createSessionArchiveSync(deps: {
  capture(): { client: Pick<DbClient, 'query'>; assertCurrent(): void };
  prepare(rows: ArchiveSessionRow[]): Promise<boolean>;
  canUseRemote(hostId: string): boolean;
  sync(input: { threadId: string; archived: boolean; remoteHostId?: string; assertCurrent(): void }): Promise<void>;
  release(): Promise<void>;
  warn(failures: number): void;
}) {
  const applied = new Map<string, { signature: string; checkedAt: number }>();
  let stopped = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function reconcile(): Promise<void> {
    const scope = deps.capture();
    const assertCurrent = () => {
      if (stopped) throw new Error('Archive sync stopped');
      scope.assertCurrent();
    };
    const rows = await scope.client.query<ArchiveSessionRow>(SELECT);
    assertCurrent();
    const groups = new Map<string, ArchiveSessionRow[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.remoteHostId, row.sdkSessionId]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const key of applied.keys()) if (!groups.has(key)) applied.delete(key);
    let failures = 0;
    for (const [key, group] of groups) {
      assertCurrent();
      const signature = JSON.stringify(group.map(row => [row.id, row.status]).sort());
      const previous = applied.get(key);
      // Native CLI actions can change storage without updating Cindy. Bound the
      // cache lifetime, while avoiding a full native scan on every UI mutation.
      if (previous?.signature === signature && Date.now() - previous.checkedAt < NATIVE_RECHECK_MS) continue;
      const first = group[0]!;
      if (first.remoteHostId && !deps.canUseRemote(first.remoteHostId)) continue;
      try {
        await withSessionRouteLocks(group.map(row => row.id), async () => {
          const current = await scope.client.query<ArchiveSessionRow>(
            `${SELECT} AND sdk_session_id = ? AND remote_host_id IS ?`,
            [first.sdkSessionId, first.remoteHostId],
          );
          assertCurrent();
          // A copied task can share a native ID. Active references win; a changed
          // group is retried under its complete set of locks on the next pass.
          const currentSignature = JSON.stringify(current.map(row => [row.id, row.status]).sort());
          if (currentSignature !== signature || !await deps.prepare(current)) return;
          assertCurrent();
          await deps.sync({
            threadId: first.sdkSessionId,
            archived: current.every(row => row.status === 'archived'),
            ...(first.remoteHostId ? { remoteHostId: first.remoteHostId } : {}),
            assertCurrent,
          });
          assertCurrent();
          applied.set(key, { signature, checkedAt: Date.now() });
        });
      } catch {
        assertCurrent();
        failures++;
      }
    }
    if (failures) deps.warn(failures);
  }

  function request(): Promise<void> {
    if (stopped) return Promise.resolve();
    pending = true;
    if (running) return running;
    if (timer) clearTimeout(timer);
    running = (async () => {
      do {
        pending = false;
        try { await reconcile(); } catch { if (!stopped) deps.warn(1); }
      } while (pending && !stopped);
      try { await deps.release(); } catch { if (!stopped) deps.warn(1); }
    })().finally(() => {
      running = undefined;
      if (!stopped) {
        // Also covers internal lifecycle writers and retries after a busy task,
        // offline SSH target, unavailable credentials or an interrupted backfill.
        timer = setTimeout(() => { void request(); }, pending ? 0 : 60_000);
        timer.unref?.();
      }
    });
    return running;
  }
  return {
    request,
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
