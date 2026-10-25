import { randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mediaBlobs, mediaRefs } from './schema.js';
export type LedgerDb = BetterSQLite3Database<typeof schema>;
export async function getIntegrationCacheHash(cacheKey: string, db: LedgerDb): Promise<string | null> {
  const rows = await db.select({ hash: mediaRefs.hash }).from(mediaRefs)
    .where(and(eq(mediaRefs.refKind, 'integration-cache'), eq(mediaRefs.refId, cacheKey)))
    .orderBy(desc(mediaRefs.createdAt)).limit(1).all();
  return rows[0]?.hash ?? null;
}

export async function touchBlob(hash: string, db: LedgerDb): Promise<void> {
  try { await db.update(mediaBlobs).set({ lastAccessAt: Date.now() }).where(eq(mediaBlobs.hash, hash)).run(); }
  catch { /* A temporarily unavailable ledger must not fail a media read. */ }
}
export type MediaRefKind =
  | 'message'
  | 'session-attachment'
  | 'im-inbox'
  | 'ghost-gallery'
  | 'ghost-grant'
  | 'ghost-tool-grant'
  | 'ghost-deposit'
  | 'import'
  | 'integration-cache'
  | 'profile-avatar'
  | 'bot-avatar'
  | 'bot-group-attachment';
/** 出生来源类型。 */
export type MediaOriginKind = 'ghost' | 'tool' | 'user' | 'integration';

export interface RecordBlobParams {
  hash: string;
  ext: string;
  mimeType: string;
  bytes: number;
  /** 性质=可再生缓存(容量上限可清);附件/作品传 false。 */
  isCache?: boolean;
}

export interface AddRefParams {
  /** Stable row id supplied by staged writers so a lost commit acknowledgement can be rolled back. */
  id?: string;
  hash: string;
  refKind: MediaRefKind;
  refId: string;
  originSessionId?: string;
  originKind?: MediaOriginKind;
  originId?: string;
  /** 人类可读备注(画廊 caption 等);可空。 */
  label?: string;
}

export async function recordBlob(
  params: RecordBlobParams,
  db: LedgerDb,
): Promise<void> {
  const now = Date.now();
  const isCache = params.isCache ?? false;
  await db
    .insert(mediaBlobs)
    .values({
      hash: params.hash,
      ext: params.ext,
      mimeType: params.mimeType,
      bytes: params.bytes,
      isCache,
      createdAt: now,
      lastAccessAt: now,
    })
    .onConflictDoUpdate({
      target: mediaBlobs.hash,
      set: isCache ? { lastAccessAt: now } : { lastAccessAt: now, isCache: false },
    })
    .run();
}

export async function pinBlob(hash: string, db: LedgerDb): Promise<void> {
  await db
    .update(mediaBlobs)
    .set({ isCache: false })
    .where(and(eq(mediaBlobs.hash, hash), eq(mediaBlobs.isCache, true)))
    .run();
}

export async function addRef(params: AddRefParams, db: LedgerDb): Promise<string> {
  // message ref 的生命周期靠 removeSessionRefs 按出生会话连坐清理,漏传
  // originSessionId 的引用将永远无人回收——契约升级为代码级断言(规则 9)。
  if (params.refKind === 'message' && !params.originSessionId) {
    throw new Error('cindy-media: message ref requires originSessionId');
  }
  const id = params.id ?? randomUUID();
  await db
    .insert(mediaRefs)
    .values({
      id,
      hash: params.hash,
      refKind: params.refKind,
      refId: params.refId,
      originSessionId: params.originSessionId ?? null,
      originKind: params.originKind ?? null,
      originId: params.originId ?? null,
      label: params.label ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export async function removeRefById(id: string, db: LedgerDb): Promise<number> {
  const result = await db.delete(mediaRefs).where(eq(mediaRefs.id, id)).run();
  return result.changes;
}

export async function hasRef(
  params: {
    hash: string;
    refKind: MediaRefKind;
    refId: string;
    /** Optional provenance filter; omit to preserve the historical any-origin query. */
    originKind?: MediaOriginKind;
  },
  db: LedgerDb,
): Promise<boolean> {
  const predicates = [
    eq(mediaRefs.hash, params.hash),
    eq(mediaRefs.refKind, params.refKind),
    eq(mediaRefs.refId, params.refId),
  ];
  if (params.originKind !== undefined) {
    predicates.push(eq(mediaRefs.originKind, params.originKind));
  }
  const rows = await db
    .select({ one: sql`1` })
    .from(mediaRefs)
    .where(and(...predicates))
    .limit(1)
    .all();
  return rows.length > 0;
}

export async function removeRefs(
  params: { refKind: MediaRefKind; refId: string },
  db: LedgerDb,
): Promise<number> {
  const result = await db
    .delete(mediaRefs)
    .where(and(eq(mediaRefs.refKind, params.refKind), eq(mediaRefs.refId, params.refId)))
    .run();
  return result.changes;
}

export async function getBlobInfo(
  hash: string,
  db: LedgerDb,
): Promise<{ ext: string; mimeType: string; bytes: number } | null> {
  const rows = await db
    .select({ ext: mediaBlobs.ext, mimeType: mediaBlobs.mimeType, bytes: mediaBlobs.bytes })
    .from(mediaBlobs)
    .where(eq(mediaBlobs.hash, hash))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export async function sessionCanRead(hash: string, sessionId: string, db: LedgerDb): Promise<boolean> {
  const rows = await db.select({ one: sql`1` }).from(mediaRefs).where(and(
    eq(mediaRefs.hash, hash),
    or(eq(mediaRefs.originSessionId, sessionId),
      and(eq(mediaRefs.refKind, 'session-attachment'), eq(mediaRefs.refId, sessionId))),
  )).limit(1).all();
  return rows.length > 0;
}

export async function ghostCanRead(
  hash: string,
  ghostId: string,
  db: LedgerDb,
): Promise<boolean> {
  const row = await db
    .select({ one: sql`1` })
    .from(mediaRefs)
    .where(
      and(
        eq(mediaRefs.hash, hash),
        or(
          and(eq(mediaRefs.originKind, 'ghost'), eq(mediaRefs.originId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-gallery'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-grant'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-tool-grant'), eq(mediaRefs.refId, ghostId)),
          and(eq(mediaRefs.refKind, 'ghost-deposit'), eq(mediaRefs.refId, ghostId)),
        ),
      ),
    )
    .limit(1)
    .all();
  return row.length > 0;
}
