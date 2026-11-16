/** Task PR associations are created only by explicit UI, agent or plugin actions.
 * Message creation, imports and history edits never infer task ownership from URLs.
 * Existing associations remain until explicitly removed.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import { sessionPrRefs, sessions } from '../localDb/schema';
import { extractPrRefs, type PrRef } from './prRefExtractor.js';
import { prStatusKey, type SessionPrRefAction } from '@cindy/maker-shared';
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

/**
 * Reorder writes small positive ordinals; older add paths wrote Unix milliseconds.
 * Those automatic timestamps must not outrank later explicit additions. Interpret
 * them as the default priority on read so existing records recover without a
 * data migration. A trillion entries is outside any supported reorder group.
 */
function manualPrPriority() {
  return sql<number>`case when ${sessionPrRefs.priority} >= 1000000000000 then 0 else ${sessionPrRefs.priority} end`;
}

/** Export the same effective priority used by SQL ordering for clients that re-sort. */
function prRefColumns() {
  return { ...getTableColumns(sessionPrRefs), priority: manualPrPriority().as('priority') };
}

/** PR 引用有变化时广播 renderer 的回调,由 ipc.ts 注入(解耦 Electron)。 */
let onRefsChanged: ((sessionId: string) => void) | null = null;

export function setPrRefsChangedListener(cb: (sessionId: string) => void): void {
  onRefsChanged = cb;
}

// Serialize explicit association changes per database and task.
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
 * 列表项各发一次 IPC。返回有效关联，包含历史关联及显式管理记录;
 * cap 2000 行纯防御(单行 ~100B)。
 */
export async function listAllPrRefs(): Promise<SessionPrRef[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select(prRefColumns())
    .from(sessionPrRefs)
    .where(and(isNull(sessionPrRefs.removedAt), eq(sessionPrRefs.associationSource, 'explicit')))
    .orderBy(
      desc(sessionPrRefs.pinned),
      desc(manualPrPriority()),
      desc(sessionPrRefs.lastSeenAt),
    )
    .limit(2000);
  return rows.map(rowToSessionPrRef);
}

/** 列出任务可见的 PR 引用，固定与手动优先顺序在前。 */
export async function listPrRefs(sessionId: string): Promise<SessionPrRef[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select(prRefColumns())
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
      desc(manualPrPriority()),
      desc(sessionPrRefs.lastSeenAt),
    );
  return rows.map(rowToSessionPrRef);
}

/** drizzle 行 → IPC 出口形状(两个 list API 共用,字段变更只改这一处)。 */
function rowToSessionPrRef(r: typeof sessionPrRefs.$inferSelect): SessionPrRef {
  return {
    id: r.id,
    sessionId: r.sessionId,
    provider: r.provider,
    host: r.host,
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

/** UI, agents and remote callers share commit validation, without locking on network I/O. */
export async function managePrRefs(
  sessionId: string,
  action: SessionPrRefAction | { action: 'list' },
  verifyPr: (ref: PrRef) => Promise<void>,
  origin = 'ui',
): Promise<SessionPrRef[]> {
  const dbClient = getDbClient();
  let verified: PrRef | undefined;
  for (;;) {
    const release = await acquirePrWrite(dbClient, sessionId);
    let result: SessionPrRef[] | { verify: PrRef };
    try {
      if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
      // Re-read every row and validate the action on each pass. A concurrent
      // removal or publication during verification must not be overwritten.
      result = await managePrRefsWithinWrite(dbClient, sessionId, action, origin, verified);
    } finally {
      release();
    }
    if (Array.isArray(result)) return result;
    // GitHub can take seconds. Keep the task write lock available to other actions.
    if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
    await verifyPr(result.verify);
    if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
    verified = result.verify;
  }
}

/** Caller holds the task PR write queue; only local reads and writes belong here. */
async function managePrRefsWithinWrite(
  dbClient: DbClient,
  sessionId: string,
  action: SessionPrRefAction | { action: 'list' },
  origin: string,
  verified: PrRef | undefined,
): Promise<SessionPrRef[] | { verify: PrRef }> {
  const isVerified = (ref: PrRef) =>
    verified !== undefined && prStatusKey(verified) === prStatusKey(ref);
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
      url.username ||
      url.password ||
      url.port ||
      !(
        (url.hostname === 'github.com' &&
          /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?:\/(?:files|commits|checks))?\/?$/.test(
            url.pathname,
          )) ||
        /^(?:\/[A-Za-z0-9_.-]+){2,}\/-\/merge_requests\/[1-9]\d*\/?$/.test(url.pathname)
      )
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid GitHub PR URL');
    }
    const ref = extractPrRefs(url.href)[0];
    if (!ref) throwIpcError('INVALID_PARAMS', 'Invalid GitHub PR number');
    const existing = rows.find((r) => prStatusKey(r) === prStatusKey(ref));
    if (existing?.removedAt != null)
      throwIpcError('ALREADY_EXISTS', 'Restore the removed PR first');
    if (!existing || existing.associationSource === 'legacy' || !existing.manuallyAdded) {
      if (!isVerified(ref)) return { verify: ref };
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
          priority: 0,
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
    if (['restore', 'pin', 'unpin'].includes(action.action) && row.associationSource === 'legacy' && !isVerified(row))
      return { verify: row };
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
    .select(prRefColumns())
    .from(sessionPrRefs)
    .where(eq(sessionPrRefs.sessionId, sessionId))
    .orderBy(
      desc(sessionPrRefs.pinned),
      desc(manualPrPriority()),
      desc(sessionPrRefs.lastSeenAt),
    );
  if (getDbClient() !== dbClient) throwIpcError('PERMISSION_DENIED', 'Account changed');
  if (action.action !== 'list') onRefsChanged?.(sessionId);
  return result.map(rowToSessionPrRef);
}
