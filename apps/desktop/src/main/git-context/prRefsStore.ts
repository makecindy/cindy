import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import { sessionPrRefs, sessions } from '../localDb/schema';
import { extractPrRefs, type PrRef } from './prRefExtractor.js';
import type { SessionPrRefAction } from '@cindy/maker-shared';
import { throwIpcError } from '../utils/ipcValidate';

/** renderer 消费的 PR 引用行(camelCase,时间戳 unix ms)。 */
export interface SessionPrRef extends PrRef {
  id: string;
  sessionId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  pinned?: boolean;
  priority?: number;
  manuallyAdded?: boolean;
  removedAt?: number | null;
  associationSource?: string;
  associationOrigin?: string | null;
}

/** Explicit associations survive message imports, edits and rewind. */
let onRefsChanged: ((sessionId: string) => void) | null = null;
export function setPrRefsChangedListener(cb: (sessionId: string) => void): void {
  onRefsChanged = cb;
}

// All explicit mutations serialize per database and task. Other tasks are independent.
const pendingPrWrites = new WeakMap<DbClient, Map<string, Promise<void>>>();

async function acquirePrWrite(dbClient: DbClient, sessionId: string): Promise<() => void> {
  let sessions = pendingPrWrites.get(dbClient);
  if (!sessions) {
    sessions = new Map();
    pendingPrWrites.set(dbClient, sessions);
  }
  const previous = sessions.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Queue promises only represent lock release and never reject. Each caller
  // releases in finally, so a failed write cannot block subsequent publications.
  const pending = previous.then(() => held);
  sessions.set(sessionId, pending);
  const queue = sessions;
  void pending.then(() => {
    if (queue.get(sessionId) === pending) queue.delete(sessionId);
  });
  await previous;
  return release;
}

/**
 * 全量 PR 引用(sidebar hover tips 用):renderer 启动期一次拉全表建
 * sessionId → refs 缓存,之后靠 pr-refs-changed 推送增量刷新,避免 N 个
 * 列表项各发一次 IPC。仅返回明确关联，历史引用保留在管理入口;
 * cap 2000 行纯防御(单行 ~100B)。
 */
export async function listAllPrRefs(): Promise<SessionPrRef[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(sessionPrRefs)
    .where(and(isNull(sessionPrRefs.removedAt), eq(sessionPrRefs.associationSource, 'explicit')))
    .orderBy(
      desc(sessionPrRefs.pinned),
      desc(sessionPrRefs.priority),
      desc(sessionPrRefs.lastSeenAt),
    )
    .limit(2000);
  return rows.map(rowToSessionPrRef);
}

/** 列出任务可见的 PR 引用，固定与手动优先顺序在前。 */
export async function listPrRefs(sessionId: string): Promise<SessionPrRef[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(sessionPrRefs)
    .where(
      and(
        eq(sessionPrRefs.sessionId, sessionId),
        isNull(sessionPrRefs.removedAt),
        eq(sessionPrRefs.associationSource, 'explicit'),
      ),
    )
    .orderBy(
      desc(sessionPrRefs.pinned),
      desc(sessionPrRefs.priority),
      desc(sessionPrRefs.lastSeenAt),
    );
  return rows.map(rowToSessionPrRef);
}

/** drizzle 行 → IPC 出口形状(两个 list API 共用,字段变更只改这一处)。 */
function rowToSessionPrRef(r: typeof sessionPrRefs.$inferSelect): SessionPrRef {
  return {
    id: r.id,
    sessionId: r.sessionId,
    owner: r.owner,
    repo: r.repo,
    prNumber: r.prNumber,
    url: r.url,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    pinned: r.pinned,
    priority: r.priority,
    manuallyAdded: r.manuallyAdded,
    removedAt: r.removedAt,
    associationSource: r.associationSource,
    associationOrigin: r.associationOrigin,
  };
}

/** UI, agents and remote callers share one mutation queue and validation. */
export async function managePrRefs(
  sessionId: string,
  action: SessionPrRefAction | { action: 'list' },
  verifyPr: (ref: PrRef) => Promise<void>,
  origin = 'ui',
): Promise<SessionPrRef[]> {
  const dbClient = getDbClient();
  const release = await acquirePrWrite(dbClient, sessionId);
  try {
    const db = dbClient.drizzle;
    const [session] = await db
      .select({ source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) throwIpcError('NOT_FOUND', 'Session not found');
    if (session.source === 'review' && action.action !== 'list')
      throwIpcError('PERMISSION_DENIED', 'Review is read-only');
    const rows = await db
      .select()
      .from(sessionPrRefs)
      .where(eq(sessionPrRefs.sessionId, sessionId));
    const nextPriority = rows.reduce((value, row) => Math.max(value, row.priority + 1), Date.now());
    if (action.action === 'add') {
      if (action.url.length > 2048) throwIpcError('INVALID_PARAMS', 'PR URL too long');
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        throwIpcError('INVALID_PARAMS', 'Invalid GitHub PR URL');
      }
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        url.username ||
        url.password ||
        url.port ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?:\/(?:files|commits|checks))?\/?$/.test(
          url.pathname,
        )
      ) {
        throwIpcError('INVALID_PARAMS', 'Invalid GitHub PR URL');
      }
      const ref = extractPrRefs(url.href)[0];
      if (!ref) throwIpcError('INVALID_PARAMS', 'Invalid GitHub PR number');
      const existing = rows.find(
        (r) =>
          r.owner.toLowerCase() === ref.owner &&
          r.repo.toLowerCase() === ref.repo &&
          r.prNumber === ref.prNumber,
      );
      if (existing?.removedAt != null)
        throwIpcError('ALREADY_EXISTS', 'Restore the removed PR first');
      if (!existing || existing.associationSource === 'legacy') {
        await verifyPr(ref);
        if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
        const now = Date.now();
        if (existing) {
          await db
            .update(sessionPrRefs)
            .set({ associationSource: 'explicit', associationOrigin: origin, manuallyAdded: true })
            .where(eq(sessionPrRefs.id, existing.id));
        } else
          await db.insert(sessionPrRefs).values({
            id: createId(),
            sessionId,
            ...ref,
            firstSeenAt: now,
            lastSeenAt: now,
            manuallyAdded: true,
            associationSource: 'explicit',
            associationOrigin: origin,
            priority: nextPriority,
          });
      }
    } else if (action.action === 'reorder') {
      const ids = action.ids;
      const first = rows.find((row) => row.id === ids[0] && row.removedAt === null);
      const group = first
        ? rows.filter(
            (row) =>
              row.removedAt === null &&
              row.associationSource === 'explicit' &&
              row.pinned === first.pinned,
          )
        : [];
      if (
        !first ||
        new Set(ids).size !== ids.length ||
        ids.length !== group.length ||
        !group.every((row) => ids.includes(row.id))
      ) {
        throwIpcError('INVALID_PARAMS', 'Reorder requires every active PR in one pin group');
      }
      if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
      // One statement is atomic for both local SQLite and the async DB client.
      await db
        .update(sessionPrRefs)
        .set({
          priority: sql`case ${sessionPrRefs.id} ${sql.join(
            ids.map((id, index) => sql`when ${id} then ${ids.length - index}`),
            sql` `,
          )} end`,
          manuallyAdded: true,
          associationSource: 'explicit',
          associationOrigin: origin,
        })
        .where(and(eq(sessionPrRefs.sessionId, sessionId), inArray(sessionPrRefs.id, ids)));
    } else if (action.action !== 'list') {
      const row = rows.find((r) => r.id === action.id);
      if (!row) throwIpcError('NOT_FOUND', 'PR association not found');
      if (
        action.action === 'pin' &&
        !row.pinned &&
        rows.filter((r) => r.pinned && r.removedAt === null && r.associationSource === 'explicit')
          .length >= 3
      ) {
        throwIpcError('INVALID_PARAMS', 'At most three pinned PRs');
      }
      if (row.removedAt !== null && !['restore', 'remove'].includes(action.action))
        throwIpcError('INVALID_PARAMS', 'Restore the PR first');
      if (['restore', 'pin', 'unpin'].includes(action.action) && row.associationSource === 'legacy')
        await verifyPr(row);
      const patch =
        action.action === 'remove'
          ? { removedAt: row.removedAt ?? Date.now(), pinned: false }
          : action.action === 'restore'
            ? {
                removedAt: null,
                manuallyAdded: true,
                associationSource: 'explicit',
                associationOrigin: origin,
              }
            : {
                pinned: action.action === 'pin',
                manuallyAdded: true,
                associationSource: 'explicit',
                associationOrigin: origin,
              };
      if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
      await db.update(sessionPrRefs).set(patch).where(eq(sessionPrRefs.id, row.id));
    }
    const result = await db
      .select()
      .from(sessionPrRefs)
      .where(eq(sessionPrRefs.sessionId, sessionId))
      .orderBy(
        desc(sessionPrRefs.pinned),
        desc(sessionPrRefs.priority),
        desc(sessionPrRefs.lastSeenAt),
      );
    if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
    if (action.action !== 'list') onRefsChanged?.(sessionId);
    return result.map(rowToSessionPrRef);
  } finally {
    release();
  }
}
