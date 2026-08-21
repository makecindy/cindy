/**
 * Local daily counters for accepted top-level Ghost tool calls.
 *
 * The table deliberately stores no tool names, arguments, results, sessions, or project data.
 * Production uses DbClient's async Drizzle proxy; tests inject an in-memory database and clock.
 */

import { and, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { getDbClient } from './client/current.js';
import { localDayKey } from './dailySpend.js';
import type * as schema from './schema.js';
import { ghostUsageDaily } from './schema.js';

export type GhostUsageDb = BetterSQLite3Database<typeof schema>;

const USAGE_WINDOW_DAYS = 7;
const RETENTION_DAYS = 90;
const DEFAULT_DRAIN_TIMEOUT_MS = 1_500;

interface TrackedWriteResult {
  ok: boolean;
}

export interface GhostUsageDrainResult {
  timedOut: boolean;
  failedCount: number;
  pendingCount: number;
}

interface CleanupState {
  localDay: string;
  promise: Promise<void>;
}

/** One low-frequency cleanup per local database and local day. */
const cleanupByDb = new WeakMap<object, CleanupState>();

/**
 * Only accepted Ghost-call counters are tracked here. The dispatcher never awaits these writes;
 * account/app shutdown drains them before DbClient transport teardown rejects queued RPCs.
 */
const pendingUsageWrites = new Set<Promise<TrackedWriteResult>>();
let activeDrain: Promise<GhostUsageDrainResult> | null = null;

function defaultDb(): GhostUsageDb {
  return getDbClient().drizzle;
}

/** Shift by local calendar days instead of fixed milliseconds so DST boundaries remain correct. */
export function shiftedLocalDayKey(ts: number, dayOffset: number): string {
  const date = new Date(ts);
  date.setDate(date.getDate() + dayOffset);
  return localDayKey(date.getTime());
}

async function cleanupExpiredUsage(db: GhostUsageDb, ts: number): Promise<void> {
  const dbKey = db as object;
  const today = localDayKey(ts);
  const current = cleanupByDb.get(dbKey);
  if (current?.localDay === today) {
    await current.promise;
    return;
  }

  // Today plus the previous 89 local calendar days remain queryable for diagnostics.
  const oldestRetainedDay = shiftedLocalDayKey(ts, -(RETENTION_DAYS - 1));
  const state: CleanupState = {
    localDay: today,
    promise: Promise.resolve(
      db.delete(ghostUsageDaily).where(lt(ghostUsageDaily.localDay, oldestRetainedDay)).run(),
    ).then(() => undefined),
  };
  cleanupByDb.set(dbKey, state);
  try {
    await state.promise;
  } catch (error) {
    // A transient failure may retry on the next accepted call instead of waiting until tomorrow.
    if (cleanupByDb.get(dbKey) === state) cleanupByDb.delete(dbKey);
    throw error;
  }
}

/** Atomically add one accepted top-level call to the plugin's local-day bucket. */
export async function recordGhostUsage(
  ghostId: string,
  db: GhostUsageDb = defaultDb(),
  ts: number = Date.now(),
): Promise<void> {
  const localDay = localDayKey(ts);
  await db
    .insert(ghostUsageDaily)
    .values({ ghostId, localDay, callCount: 1, updatedAt: ts })
    .onConflictDoUpdate({
      target: [ghostUsageDaily.ghostId, ghostUsageDaily.localDay],
      set: {
        callCount: sql`${ghostUsageDaily.callCount} + 1`,
        updatedAt: ts,
      },
    })
    .run();

  await cleanupExpiredUsage(db, ts);
}

/** Start and track one counter write without making the plugin call await database I/O. */
export function recordTrackedGhostUsage(
  ghostId: string,
  write: (ghostId: string) => Promise<void> = recordGhostUsage,
): Promise<void> {
  let writePromise: Promise<void>;
  try {
    writePromise = write(ghostId);
  } catch (error) {
    writePromise = Promise.reject(error);
  }
  let settled: Promise<TrackedWriteResult>;
  settled = writePromise
    .then<TrackedWriteResult>(() => ({ ok: true }))
    .catch<TrackedWriteResult>(() => ({ ok: false }))
    .finally(() => {
      pendingUsageWrites.delete(settled);
    });
  pendingUsageWrites.add(settled);
  return writePromise;
}

/**
 * Drain writes accepted before the DB lifecycle boundary. Concurrent callers share one bounded
 * wait, and timeout/failure is returned to the lifecycle owner instead of rejecting shutdown.
 */
export function drainGhostUsageWrites(
  timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<GhostUsageDrainResult> {
  if (activeDrain) return activeDrain;

  activeDrain = (async () => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let failedCount = 0;

    while (pendingUsageWrites.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { timedOut: true, failedCount, pendingCount: pendingUsageWrites.size };
      }

      const writes = [...pendingUsageWrites];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.all(writes).then((results) => ({ kind: 'settled' as const, results })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      if (outcome.kind === 'timeout') {
        return { timedOut: true, failedCount, pendingCount: pendingUsageWrites.size };
      }
      failedCount += outcome.results.filter((result) => !result.ok).length;
    }

    return { timedOut: false, failedCount, pendingCount: 0 };
  })().finally(() => {
    activeDrain = null;
  });
  return activeDrain;
}

/**
 * Return one batch-queried mapping for today and the preceding six local calendar days.
 * Plugins without a row in that window are omitted.
 */
export async function getGhostUsage7d(
  ghostIds: readonly string[],
  db: GhostUsageDb = defaultDb(),
  ts: number = Date.now(),
): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(ghostIds)];
  if (uniqueIds.length === 0) return {};

  const today = localDayKey(ts);
  const windowStartDay = shiftedLocalDayKey(ts, -(USAGE_WINDOW_DAYS - 1));
  const rows = await db
    .select({
      ghostId: ghostUsageDaily.ghostId,
      callCount: sql<number>`SUM(${ghostUsageDaily.callCount})`,
    })
    .from(ghostUsageDaily)
    .where(
      and(
        inArray(ghostUsageDaily.ghostId, uniqueIds),
        gte(ghostUsageDaily.localDay, windowStartDay),
        lte(ghostUsageDaily.localDay, today),
      ),
    )
    .groupBy(ghostUsageDaily.ghostId)
    .all();

  return Object.fromEntries(rows.map((row) => [row.ghostId, Number(row.callCount)]));
}
