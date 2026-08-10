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

interface CleanupState {
  localDay: string;
  promise: Promise<void>;
}

/** One low-frequency cleanup per local database and local day. */
const cleanupByDb = new WeakMap<object, CleanupState>();

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
