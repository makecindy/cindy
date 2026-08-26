/**
 * sessions:list 的投影回填：写路径把 preview / count 落到 sessions 可空列。
 * SQL 片段见 sessionListProjection.sql.ts。
 */
import { eq, sql } from 'drizzle-orm';

import { getDbClient } from './client/current.js';
import { sessions } from './schema.js';
import {
  SESSION_LIST_MESSAGE_COUNT_CAP,
  SESSION_LIST_PROJECTION_BACKFILL_SQL,
} from './sessionListProjection.sql.js';

export {
  LIST_PREVIEW_EXTRACT_CHARS,
  LIST_PREVIEW_EXTRACT_SQL,
  LATEST_VISIBLE_PREVIEW_FILTER_SQL,
  SESSION_LIST_MESSAGE_COUNT_CAP,
  SESSION_LIST_PROJECTION_BACKFILL_SQL,
} from './sessionListProjection.sql.js';

export type SessionListProjectionBackfillItem = {
  id: string;
  preview?: string | null;
  role?: string | null;
  count?: number;
};

export function serializeSessionListProjectionBackfill(
  items: readonly SessionListProjectionBackfillItem[],
): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      preview: item.preview ?? null,
      role: item.role ?? null,
      count:
        item.count === undefined
          ? null
          : Math.min(Math.max(0, Math.floor(item.count)), SESSION_LIST_MESSAGE_COUNT_CAP),
      hasPreview: item.preview !== undefined ? 1 : 0,
      hasCount: item.count !== undefined ? 1 : 0,
    })),
  );
}

export async function persistSessionListPreview(
  sessionId: string,
  preview: string | null,
  role: string | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ listPreview: preview, listPreviewRole: role })
    .where(eq(sessions.id, sessionId));
}

export async function incrementSessionListMessageCount(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      listMessageCount: sql`CASE
        WHEN ${sessions.listMessageCount} IS NULL THEN NULL
        WHEN ${sessions.listMessageCount} >= ${SESSION_LIST_MESSAGE_COUNT_CAP} THEN ${SESSION_LIST_MESSAGE_COUNT_CAP}
        ELSE ${sessions.listMessageCount} + 1
      END`,
    })
    .where(eq(sessions.id, sessionId));
}

export async function invalidateSessionListPreview(sessionId: string): Promise<void> {
  await persistSessionListPreview(sessionId, null, null);
}

export async function persistSessionListMessageCount(
  sessionId: string,
  count: number,
): Promise<void> {
  const db = getDbClient().drizzle;
  const capped = Math.min(Math.max(0, Math.floor(count)), SESSION_LIST_MESSAGE_COUNT_CAP);
  await db.update(sessions).set({ listMessageCount: capped }).where(eq(sessions.id, sessionId));
}

/** 一次 RPC 回填整页 list 投影。空数组是 no-op。 */
export async function persistSessionListProjectionBatch(
  items: readonly SessionListProjectionBackfillItem[],
): Promise<void> {
  if (items.length === 0) return;
  await getDbClient().exec(SESSION_LIST_PROJECTION_BACKFILL_SQL, [
    serializeSessionListProjectionBackfill(items),
  ]);
}
