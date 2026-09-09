/**
 * sessions:list 的投影回填：写路径把 preview / count 落到 sessions 可空列。
 * SQL 片段见 sessionListProjection.sql.ts。
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { getDbClient } from './client/current.js';
import { sessions } from './schema.js';
import {
  LATEST_VISIBLE_PREVIEW_FILTER_SQL,
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
  visibleCreatedAt?: number | null,
  visibleClientId?: string | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  if (preview == null) {
    await db
      .update(sessions)
      .set({ listPreview: null, listPreviewRole: null })
      .where(eq(sessions.id, sessionId));
    return;
  }
  const createdAt =
    typeof visibleCreatedAt === 'number' && Number.isFinite(visibleCreatedAt)
      ? Math.floor(visibleCreatedAt)
      : null;
  const clientId =
    typeof visibleClientId === 'string' && visibleClientId.length > 0 ? visibleClientId : null;
  const conds = [
    eq(sessions.id, sessionId),
    createdAt == null
      ? isNull(sessions.clearedAt)
      : or(isNull(sessions.clearedAt), sql`${sessions.clearedAt} < ${createdAt}`),
  ];
  if (createdAt != null && clientId != null) {
    conds.push(
      sql`NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.session_id = ${sessions.id}
          AND ${sql.raw(LATEST_VISIBLE_PREVIEW_FILTER_SQL)}
          AND (${sessions.clearedAt} IS NULL OR m.created_at > ${sessions.clearedAt})
          AND (
            m.created_at > ${createdAt}
            OR (
              m.created_at = ${createdAt}
              AND m.rowid > (
                SELECT m2.rowid FROM messages m2
                WHERE m2.session_id = ${sessions.id} AND m2.client_id = ${clientId}
                LIMIT 1
              )
            )
          )
      )`,
    );
  }
  await db
    .update(sessions)
    .set({ listPreview: preview, listPreviewRole: role })
    .where(and(...conds));
}

export async function invalidateSessionListMessageCount(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db.update(sessions).set({ listMessageCount: null }).where(eq(sessions.id, sessionId));
}

export async function invalidateSessionListPreview(sessionId: string): Promise<void> {
  await persistSessionListPreview(sessionId, null, null);
}

export async function persistSessionListMessageCount(
  sessionId: string,
  count: number,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ listMessageCount: Math.max(0, Math.floor(count)) })
    .where(eq(sessions.id, sessionId));
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
