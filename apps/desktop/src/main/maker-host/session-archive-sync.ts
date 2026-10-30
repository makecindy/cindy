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

// Native CLI actions can change storage without updating Cindy. Every group is
// re-verified in one batched pass at this interval; each pass spawns a native
// control process, so it stays far apart from the 60s tick.
const NATIVE_RECHECK_MS = 60 * 60_000;
const TICK_MS = 60_000;

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
  const applied = new Map<string, string>();
  // Busy or failed groups back off per signature. A Cindy status write changes
  // the signature, so it is synced on the request that follows it.
  const deferred = new Map<string, { signature: string; attempts: number; retryAt: number }>();
  let nativeCheckedAt = Number.NEGATIVE_INFINITY;
  let stopped = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function reconcile(): Promise<void> {
    const startedAt = Date.now();
    const recheckNative = startedAt - nativeCheckedAt >= NATIVE_RECHECK_MS;
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
    for (const key of deferred.keys()) if (!groups.has(key)) deferred.delete(key);
    let failures = 0;
    const defer = (key: string, signature: string) => {
      const previous = deferred.get(key);
      const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
      const delay = Math.min(TICK_MS * 2 ** (attempts - 1), NATIVE_RECHECK_MS);
      applied.delete(key);
      deferred.set(key, { signature, attempts, retryAt: Date.now() + delay });
    };
    for (const [key, group] of groups) {
      assertCurrent();
      const signature = JSON.stringify(group.map(row => [row.id, row.status]).sort());
      if (!recheckNative) {
        if (applied.get(key) === signature) continue;
        const backoff = deferred.get(key);
        if (backoff?.signature === signature && Date.now() < backoff.retryAt) continue;
      }
      const first = group[0]!;
      if (first.remoteHostId && !deps.canUseRemote(first.remoteHostId)) {
        // 这一轮没能核验: 不让整点复核的标记掩盖它, 远端恢复后下一次 tick 就补做。
        applied.delete(key);
        continue;
      }
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
          if (currentSignature !== signature) return;
          if (!await deps.prepare(current)) { defer(key, signature); return; }
          assertCurrent();
          await deps.sync({
            threadId: first.sdkSessionId,
            archived: current.every(row => row.status === 'archived'),
            ...(first.remoteHostId ? { remoteHostId: first.remoteHostId } : {}),
            assertCurrent,
          });
          assertCurrent();
          applied.set(key, signature);
          deferred.delete(key);
        });
      } catch {
        assertCurrent();
        defer(key, signature);
        failures++;
      }
    }
    if (recheckNative) nativeCheckedAt = startedAt;
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
        // The tick itself only reads the database; native work happens only for
        // changed, backed-off-and-due, or hourly re-verified groups.
        timer = setTimeout(() => { void request(); }, pending ? 0 : TICK_MS);
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
