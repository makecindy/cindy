/**
 * prRefsStore — session ↔ PR 引用的落库与查询(session_pr_refs 表)。
 *
 * 写路径:localDb/ipc/messages.ts 的 createMessage 在消息落库后 fire-and-forget
 * 调 recordPrRefsForMessage(只扫 user / assistant 角色)。提取到新 PR 引用时
 * upsert 并通过注入的 broadcast 通知所有 renderer 窗口刷新。
 *
 * 读路径:git-context IPC 的 listPrRefs(sessionId)，排除手动移除的关联，
 * 按固定、手动优先顺序、最近提及排序，renderer 按此顺序展示。
 */

import { createId } from '@paralleldrive/cuid2';
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';

import { getDbClient, getCurrentDbClientUserId } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import { messages, migrationMeta, sessionPrRefs, sessions } from '../localDb/schema';
import { messageToCamel } from '../localDb/mapper';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn';
import { createLogger } from '../logger.js';
import { extractPrRefs, messageContentToText, type PrRef } from './prRefExtractor.js';
import { prStatusKey, type SessionPrRefAction } from '@cindy/maker-shared';
import { throwIpcError } from '../utils/ipcValidate';

const log = createLogger('git-context/pr-refs');

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

/** 只有这两类角色的文本参与提取——tool_result 里的 PR 列表是噪音(详见 prRefExtractor)。 */
const SCANNED_ROLES = new Set(['user', 'assistant']);

/**
 * Reorder writes small positive ordinals; older add paths wrote Unix milliseconds.
 * Those automatic timestamps must not outrank later message mentions. Interpret
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

/** Publish only the current persisted public message, under the task's PR write queue. */
export async function recordPrRefsForMessage(msg: {
  id: string;
  sessionId: string;
  role: string;
  content: unknown;
  createdAt: string | number;
}): Promise<void> {
  if (
    !SCANNED_ROLES.has(msg.role) ||
    !/(?:\/pull\/|\/-\/merge_requests\/)/.test(messageContentToText(msg.content))
  )
    return;
  try {
    const dbClient = getDbClient();
    await reconcilePrRefsForSession(msg.sessionId,
      { dbClient, isCurrent: () => getDbClient() === dbClient }, false, msg.id);
  } catch (err) {
    log.warn('record pr refs failed', {
      sessionId: msg.sessionId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Import transactions may skip tombstones/rewound rows; never publish adapter candidates. */
export async function recordPrRefsForImportedMessages(sessionId: string): Promise<void> {
  try {
    const dbClient = getDbClient();
    await reconcilePrRefsForSession(sessionId,
      { dbClient, isCurrent: () => getDbClient() === dbClient }, false);
  } catch (err) {
    log.warn('record imported pr refs failed', {
      sessionId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * upsert:(sessionId, owner, repo, prNumber) 已存在则 bump lastSeenAt,否则插入。
 * atMs 缺省用当前时刻(实时消息路径);回填/重算路径传消息原始 createdAt。
 * lastSeenAt 默认用 max() 守卫(回填老消息绝不把更新的时间戳拉回去);
 * authoritative=true(重算路径,按 createdAt 升序处理)则直接覆盖——
 * 被 rewind/clear 掉的"更晚提及"残留的时间戳必须被纠正回存活集的真实值。
 */
interface PrRefsRecomputeScope {
  dbClient: DbClient;
  isCurrent: () => boolean;
}

// Recompute and publication share a per-DB/session queue so an old history
// snapshot cannot prune a concurrently published PR. Other sessions are independent.
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

/** Caller holds the session's PR write queue, including during recomputation. */
async function upsertPrRefsWithinWrite(
  dbClient: DbClient,
  sessionId: string,
  refs: PrRef[],
  atMs?: number,
  opts?: { authoritative?: boolean; scope?: PrRefsRecomputeScope },
): Promise<void> {
  const db = dbClient.drizzle;
  const ts = atMs ?? Date.now();
  for (const ref of refs) {
    if (opts?.scope && !opts.scope.isCurrent()) return;
    await db
      .insert(sessionPrRefs)
      .values({
        id: createId(),
        sessionId,
        provider: ref.provider ?? 'github',
        host: ref.host ?? 'github.com',
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        url: ref.url,
        firstSeenAt: ts,
        lastSeenAt: ts,
        associationSource: 'explicit',
        associationOrigin: 'message',
      })
      .onConflictDoUpdate({
        target: [
          sessionPrRefs.sessionId,
          sessionPrRefs.provider,
          sessionPrRefs.host,
          sessionPrRefs.owner,
          sessionPrRefs.repo,
          sessionPrRefs.prNumber,
        ],
        set: {
          lastSeenAt: opts?.authoritative ? ts : sql`max(${sessionPrRefs.lastSeenAt}, ${ts})`,
          firstSeenAt: sql`min(${sessionPrRefs.firstSeenAt}, ${ts})`,
          // Preserve removal tombstones and manual provenance during historical repair.
          associationSource: sql`case when ${sessionPrRefs.removedAt} is null then 'explicit' else ${sessionPrRefs.associationSource} end`,
          associationOrigin: sql`coalesce(${sessionPrRefs.associationOrigin}, 'message')`,
        },
      });
  }
}

/** 回填完成标记(migrationMeta kv,先例:codex_history_has_product_prompt_initialized_v1)。 */
const BACKFILL_META_KEY = 'git_context_pr_refs_backfill_v3';

/**
 * 进程内防重入,按 DbClient 实例记账:同进程登出再登入另一账号时
 * db 是另一份,模块级布尔 flag 会把新账号的回填短路掉(Codex review P1)。
 * 失败时复位让下次调用重试。
 */
const backfilledClients = new WeakSet<DbClient>();

/**
 * 一次性历史回填:把存量 user/assistant 消息里的 PR 链接补进 session_pr_refs。
 * 没有它,功能上线前的老会话要等新消息才能绑上 PR(用户实测反馈的体验缺口)。
 *
 * - 触发:首次 PR_REFS_LIST IPC 时 fire-and-forget(此时 db 必然 ready);
 *   完成后对受影响 session 广播 pr-refs-changed,已打开的会话头自动刷新。
 * - SQL 端用 LIKE '%github.com%/pull/%' 预筛,只捞出极少量候选行再跑正则;
 *   时间戳用消息原始 createdAt,保持"最近提到的排前面"的语义。
 * - 幂等:完成后写 migrationMeta 标记,下次启动直接跳过;中途失败不写标记,
 *   下次触发重试(upsert 本身幂等,重复处理无副作用)。
 */
export async function ensurePrRefsBackfill(): Promise<void> {
  const uid = getCurrentDbClientUserId();
  if (uid === null) return; // db 未就绪:下次触发再试
  const dbClient = getDbClient();
  if (backfilledClients.has(dbClient)) return;
  backfilledClients.add(dbClient);
  const scope = { dbClient, isCurrent: () => getDbClient() === dbClient };
  try {
    const db = dbClient.drizzle;
    const done = await db
      .select()
      .from(migrationMeta)
      .where(eq(migrationMeta.key, BACKFILL_META_KEY))
      .limit(1);
    if (done.length > 0) return;

    // 只扫"对用户可见"的消息:跳过 rewind 软删行,以及 /clear 边界之前的行
    // (与 messages:list 的可见性语义对齐;Codex review P2 ×2)。
    const rows = await db
      .select({
        sessionId: messages.sessionId,
      })
      .from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId))
      .where(
        and(
          inArray(messages.role, ['user', 'assistant']),
          isNull(messages.rewindAt),
          or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
          or(
            like(messages.content, '%github.com%/pull/%'),
            like(messages.content, '%/-/merge_requests/%'),
          ),
        ),
      )
      .orderBy(asc(messages.createdAt));

    const touched = new Set(rows.map(row => row.sessionId));
    for (const sessionId of touched) {
      if (!scope.isCurrent()) { backfilledClients.delete(dbClient); return; }
      // Discovery is only a task hint. Re-read persisted visibility and public
      // content after acquiring its queue, rather than publishing an old snapshot.
      await reconcilePrRefsForSession(sessionId, scope, false);
    }

    if (!scope.isCurrent()) { backfilledClients.delete(dbClient); return; }
    await db
      .insert(migrationMeta)
      .values({ key: BACKFILL_META_KEY, value: 'done' })
      .onConflictDoUpdate({ target: migrationMeta.key, set: { value: 'done' } });

    log.info('pr refs backfill complete', { candidates: rows.length, sessions: touched.size });
  } catch (err) {
    backfilledClients.delete(dbClient); // 失败复位,下次触发时重试
    log.warn('pr refs backfill failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 重算某 session 的 PR 引用,只统计"对用户可见"的消息——rewind(rewind_at
 * 置位软删)与 /clear(clearedAt 边界之前隐藏)之后调用,只出现在被回滚/被
 * clear 段里的 PR 不该再挂在会话上(Codex review P2 ×2)。
 * 按存活消息 upsert 后剪除过期引用,时间戳用消息原始 createdAt;完成广播刷新。
 * 与同任务的 PR 写入串行,避免迟到全文校准用旧快照剪除并发新消息的引用。
 */
export async function recomputePrRefsForSession(
  sessionId: string,
  scope?: PrRefsRecomputeScope,
): Promise<void> {
  try {
    await reconcilePrRefsForSession(sessionId, scope, true);
  } catch (err) {
    log.warn('recompute pr refs failed', {
      sessionId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reconcilePrRefsForSession(
  sessionId: string,
  scope: PrRefsRecomputeScope | undefined,
  prune: boolean,
  messageId?: string,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    if (scope && !scope.isCurrent()) return;
    const dbClient = scope?.dbClient ?? getDbClient();
    release = await acquirePrWrite(dbClient, sessionId);
    if (scope && !scope.isCurrent()) return;
    const db = dbClient.drizzle;
    const [sessionRow] = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (scope && !scope.isCurrent()) return;
    if (!sessionRow) return;
    const clearedAt = sessionRow.clearedAt;

    const conds = [
      eq(messages.sessionId, sessionId),
      isNull(messages.rewindAt),
      inArray(messages.role, ['user', 'assistant']),
      or(like(messages.content, '%/pull/%'), like(messages.content, '%/-/merge_requests/%')),
    ];
    if (clearedAt !== null) conds.push(gt(messages.createdAt, clearedAt));
    if (messageId !== undefined) conds.push(eq(messages.id, messageId));

    const rows = await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(asc(messages.createdAt));

    // 崩溃安全:不做"先删全量再重插"——中途进程被杀会永久丢引用,且回填标记
    // 已写不会自愈(Greptile review P1)。改为先 upsert 存活集(authoritative
    // 时间戳,升序处理保证 lastSeenAt 终值正确),最后再删不在存活集里的旧行:
    // 任何中断点都只会"多"不会"少",下次重算自然收敛,无需事务。
    if (scope && !scope.isCurrent()) return;
    const keep = new Set<string>();
    for (const row of rows) {
      if (scope && !scope.isCurrent()) return;
      const message = messageToCamel(row);
      // Recovery checkpoint summaries are hidden user instructions, not visible
      // mentions. Match the renderer for plain text and { text } envelopes.
      if (message.role === 'user') {
        const text = typeof message.content === 'string' ? message.content
          : (message.content as { text?: unknown } | null)?.text;
        if (message.agentMeta?.autoResume === true ||
            (typeof text === 'string' && isSyntheticTriggerText(text))) continue;
      }
      const refs = extractPrRefs(messageContentToText(message.content));
      if (refs.length === 0) continue;
      for (const ref of refs) keep.add(prStatusKey(ref));
      await upsertPrRefsWithinWrite(dbClient, sessionId, refs, row.createdAt, {
        authoritative: prune,
        scope,
      });
    }

    if (scope && !scope.isCurrent()) return;
    if (!prune) {
      if (!scope || scope.isCurrent()) onRefsChanged?.(sessionId);
      return;
    }
    const existing = await db
      .select({
        id: sessionPrRefs.id,
        provider: sessionPrRefs.provider,
        host: sessionPrRefs.host,
        owner: sessionPrRefs.owner,
        repo: sessionPrRefs.repo,
        prNumber: sessionPrRefs.prNumber,
        manuallyAdded: sessionPrRefs.manuallyAdded,
        removedAt: sessionPrRefs.removedAt,
      })
      .from(sessionPrRefs)
      .where(eq(sessionPrRefs.sessionId, sessionId));
    if (scope && !scope.isCurrent()) return;
    const staleIds = existing
      .filter((r) => !r.manuallyAdded && r.removedAt === null && !keep.has(prStatusKey(r)))
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await db.delete(sessionPrRefs).where(inArray(sessionPrRefs.id, staleIds));
    }
    if (!scope || scope.isCurrent()) onRefsChanged?.(sessionId);
  } finally {
    release?.();
  }
}

/**
 * 全量 PR 引用(sidebar hover tips 用):renderer 启动期一次拉全表建
 * sessionId → refs 缓存,之后靠 pr-refs-changed 推送增量刷新,避免 N 个
 * 列表项各发一次 IPC。返回有效关联，包含消息提取及手动管理记录;
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
    // GitHub can take seconds. The shared PR lock must stay available to
    // message reconciliation running inside the global persistence FIFO.
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
