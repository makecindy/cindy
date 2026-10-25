import { and, eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import type { StoredMessage, MessageRole } from '@cindy/maker-shared/stored-message';
import type { DbClient } from './client/DbClient.js';
import type { DbLogger } from './logging.js';
import { messages, sessions } from './schema.js';
import { messageToCamel, messageCreateToRow } from './messageMapper.js';
type MessageRow = typeof messages.$inferSelect;

export interface MessageWriterHost<OwnerScope, AgentMeta> {
  getDbClient(): DbClient;
  logger: DbLogger;
  restoreTaskImageRows(client: DbClient, rows: MessageRow[]): Promise<MessageRow[]>;
  commitMessageMediaRefs(input: { sessionId: string; role: string; content: string }): Promise<unknown>;
  trackMessageMediaWrite(client: DbClient, rowId: string, write: Promise<void>): Promise<void>;
  broadcastMessageRow(sessionId: string, message: StoredMessage<AgentMeta>, owner?: OwnerScope | null): void;
  maybeBroadcastSessionListPreview(sessionId: string, row: MessageRow, owner?: OwnerScope | null): Promise<void>;
  onChatMessageCreatedForEmbedding(message: StoredMessage<AgentMeta>): Promise<unknown>;
  recordPrRefsForMessage(message: StoredMessage<AgentMeta>): Promise<void>;
  pendingPrRefWrites: WeakMap<DbClient, Map<string, Promise<void>>>;
}

/** The original guarded write and publication transaction, shared by both hosts. */
export function createMessageWriter<DataOwnerBroadcastScope, AgentMeta = Record<string, unknown>>(host: MessageWriterHost<DataOwnerBroadcastScope, AgentMeta>) {
type Message = StoredMessage<AgentMeta>;
const { getDbClient, restoreTaskImageRows, commitMessageMediaRefs, trackMessageMediaWrite,
  broadcastMessageRow, maybeBroadcastSessionListPreview, onChatMessageCreatedForEmbedding,
  recordPrRefsForMessage, pendingPrRefWrites } = host;
const log = host.logger;
async function createMessage(
  sessionId: string,
  body: {
    clientId: string;
    role: MessageRole;
    content: unknown;
    toolUseId?: string;
    agentMeta?: AgentMeta | null;
    /**
     * 产出本行的 agent 引擎('cc' / 'codex')。session-agent-switch 后按行解析
     * agentMeta 需要它;main 侧 SDK 事件落库路径必传,renderer pending echo 等
     * 无 SDK 元信息的行留空(null 回落 session.agentKind)。
     */
    agentKind?: 'cc' | 'codex' | 'pi' | null;
    createdAt?: number;
  },
  opts?: {
    /**
     * Main-side callers that race with /clear can persist an old row whose
     * createdAt is already behind the clear boundary. The row is harmless for
     * history queries, but broadcasting it would resurrect the cleared bubble in
     * every renderer window. Keep this guard next to the broadcast, where the
     * final "is this still current?" check is actually meaningful.
     */
    shouldBroadcast?: () => boolean;
    /** Host-only admission guard, checked before and after the publication transaction.
     * Must be repeatable. A failed final check rolls back this exact row before delivery hooks. */
    beforePublish?: () => Promise<void>;
    /** Host delivery owns its guarded attachment commit and compensation. */
    deferMediaRefs?: boolean;
    /**
     * Optional clear-boundary compare-and-set for optimistic user sends.  The
     * insert is accepted only while the session still has this exact
     * `clearedAt` value.  This closes the window where `/clear` wins the DB
     * update while an already-accepted `Session.send()` is still awaiting its
     * durable user row.
     */
    expectedClearBoundaryMs?: number | null;
    /** Skip a host-written opening if the user has already spoken, checked in the insert transaction. */
    requireNoUserMessage?: boolean;
    /**
     * Owner scope captured before an async main-side write.  A stale scope
     * must not broadcast a row into the next signed-in owner.
     */
    broadcastOwnerScope?: DataOwnerBroadcastScope | null;
  },
): Promise<Message> {
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const guarded =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs');
  const expected = guarded ? opts?.expectedClearBoundaryMs : undefined;
  if (
    guarded &&
    expected !== null &&
    (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0)
  ) {
    throw new Error('expectedClearBoundaryMs must be null or a non-negative finite number');
  }

  // The unguarded API keeps its historical fast idempotency read. Guarded
  // optimistic sends must skip it: a pre-clear row can otherwise be returned
  // before the compare-and-set boundary is checked.
  if (!guarded) {
    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (existing.length > 0) return messageToCamel<AgentMeta>(existing[0]);
  }

  if (guarded && opts?.beforePublish) throw new Error('Publication guard cannot be combined with optimistic input');
  const id = createId();
  const now = Date.now();
  const visibleCreatedAt =
    guarded && expected !== null && expected !== undefined
      ? Math.max(body.createdAt ?? now, expected + 1)
      : (body.createdAt ?? now);
  const insertRow = messageCreateToRow(id, sessionId, body, visibleCreatedAt);
  const insertArgs = {
    id: insertRow.id,
    clientId: insertRow.clientId,
    sessionId,
    role: insertRow.role,
    content: insertRow.content,
    toolUseId: insertRow.toolUseId ?? null,
    agentMeta: insertRow.agentMeta ?? null,
    agentKind: insertRow.agentKind ?? null,
    createdAt: insertRow.createdAt,
    guarded,
    expectedClearBoundaryMs: guarded ? (expected ?? null) : undefined,
    ...(opts?.requireNoUserMessage ? { requireNoUserMessage: true } : {}),
  };
  try {
    const inserted = await dbClient.tx('message.insert', { ...insertArgs,
      ...(opts?.beforePublish ? { publication: 'stage' as const } : {}),
    });
    if (opts?.beforePublish) {
      await opts.beforePublish();
      try {
        const published = await dbClient.tx('message.insert', { ...insertArgs, publication: 'publish' });
        if (published.changes !== 1) throw new Error('Message publication lost its pending row');
      } catch (error) {
        // The worker can commit before its receipt is lost. Recover only this
        // exact publication, then run the same delivery/indexing hooks below.
        const [committed] = await db.select().from(messages)
          .where(and(eq(messages.id, id), eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
          .limit(1);
        if (!committed || committed.role !== insertArgs.role || committed.content !== insertArgs.content
          || committed.toolUseId !== insertArgs.toolUseId || committed.agentMeta !== insertArgs.agentMeta
          || committed.agentKind !== insertArgs.agentKind || committed.createdAt !== insertArgs.createdAt
          || committed.rewindAt !== null) throw error;
      }
      // Keep this outside the lost-receipt recovery: a failed authorization
      // check must never be mistaken for a successful committed publication.
      try {
        await opts.beforePublish();
      } catch (error) {
        await dbClient.tx('message.insert', { ...insertArgs, publication: 'rollback' });
        throw error;
      }
    }
    if (guarded && inserted.changes === 0) {
      const [existingAfterGuard] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
        .limit(1);
      const [sessionAfterGuard] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const actual = sessionAfterGuard?.clearedAt ?? null;
      if (
        existingAfterGuard &&
        actual === expected &&
        existingAfterGuard.rewindAt === null &&
        (expected === null || existingAfterGuard.createdAt > expected)
      ) {
        return messageToCamel<AgentMeta>(existingAfterGuard);
      }
      if (actual !== expected) {
        throw Object.assign(
          new Error(
            `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
          ),
          { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
        );
      }
      throw new Error('Message insert skipped without a clear-boundary change');
    }
  } catch (err) {
    if (opts?.beforePublish) {
      await dbClient.tx('message.insert', { ...insertArgs, publication: 'discard' });
      throw err;
    }
    const after = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (guarded) {
      const [sessionAfterError] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const actual = sessionAfterError?.clearedAt ?? null;
      const existingAfterError = after[0];
      if (
        existingAfterError &&
        actual === expected &&
        existingAfterError.rewindAt === null &&
        (expected === null || existingAfterError.createdAt > expected)
      ) {
        return messageToCamel<AgentMeta>(existingAfterError);
      }
      if (actual !== expected) {
        throw Object.assign(
          new Error(
            `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
          ),
          { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
        );
      }
    } else if (after.length > 0) {
      return messageToCamel<AgentMeta>(after[0]);
    }
    throw err;
  }
  // 插入成功后不再整行回读:大 content(tool_result 全文)会经 DB worker 的
  // postMessage 再送回主进程一次。insertRow 就是刚写入的行(新行 rewind_at 恒
  // NULL);必须过 messageToCamel 走与回读完全相同的解析路径(JSON.parse 失败
  // 回退裸串、assistant 引文剥离),否则返回值/广播行的类型语义会漂移。幂等命中
  // 与 UNIQUE / guarded 回退路径仍保留各自的回读(上方),不受影响。
  const row: MessageRow = {
    id: insertRow.id,
    clientId: insertRow.clientId,
    sessionId: insertRow.sessionId,
    role: insertRow.role,
    content: insertRow.content,
    toolUseId: insertRow.toolUseId ?? null,
    agentMeta: insertRow.agentMeta ?? null,
    agentKind: insertRow.agentKind ?? null,
    createdAt: insertRow.createdAt,
    rewindAt: null,
  };
  const [restoredRow] = await restoreTaskImageRows(dbClient, [row]);
  const msg = messageToCamel<AgentMeta>(restoredRow);
  // 媒体总仓挂账钩子(规则 25):消息落库是"blob 归属本会话"的
  // 确定时点,覆盖所有落库来源(renderer IPC / hook / im / agent echo / 合成
  // tool_result)。生成产物(art/mivo/codex)入仓时零引用,在这里补挂
  // session-attachment 引用;用户附件已在发送链路 commit 过,hasRef 幂等跳过。
  // 传 insertRow.content(已序列化字符串)避免二次 stringify(review P2)。
  const commitMediaRefs = async (): Promise<void> => {
    try {
      await commitMessageMediaRefs({
        sessionId,
        role: body.role,
        content: insertRow.content,
      });
    } catch (err) {
      log.warn('message media ref commit failed', {
        sessionId,
        clientId: body.clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Optimistic user rows carry the clear token and are written through the
  // durable FIFO. Await their media commit so a later clear/rewind cannot be
  // overtaken by a fire-and-forget session-attachment ref. Other message roles
  // stay non-blocking on the hot event path.
  const shouldAwaitMediaRefs =
    body.role === 'user' &&
    opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs');
  if (!opts?.deferMediaRefs) {
    const mediaWrite = trackMessageMediaWrite(dbClient, row.id, commitMediaRefs());
    if (shouldAwaitMediaRefs) await mediaWrite;
  }
  // Broadcast 给所有 renderer window — 用于 main 端创建消息 (e.g. feishu /ctr
  // 接管路径下 persistUserMessage / persistAssistantMessage) 时让 renderer
  // 的 makerChatStore push 到 in-memory state, 让消息流实时刷新。
  // Renderer 自己调 createMessage IPC 时也会触发这个 broadcast, 但因为它已经
  // 主动 push 过, 监听端按 (sessionId, clientId) dedupe 就不会重复显示。
  if (opts?.shouldBroadcast?.() !== false) {
    broadcastMessageRow(sessionId, msg, opts?.broadcastOwnerScope);
    await maybeBroadcastSessionListPreview(sessionId, restoredRow, opts?.broadcastOwnerScope);
  }
  // chat-history-embedder hook (Phase 1.2) —— fire-and-forget, 不 await。
  // 内部已有 enabled / cutoff / role / size 守卫; 关闭状态下零成本直接 return。
  // 失败仅 log warn, 绝不传播错让 createMessage 返回值受影响。
  void onChatMessageCreatedForEmbedding(msg).catch(() => {
    // 双保险: chat-history-embedder.onMessageCreated 内部已 try/catch,
    // 此处 .catch 仅防御该函数将来被 refactor 时漏掉的异常路径。
  });
  // session-git-pr-context hook —— fire-and-forget。内部限定 user/assistant 角色,
  // 每条消息跑一次锚定正则线性扫描(开销可忽略);失败仅 log warn。
  const prRefsWrite = recordPrRefsForMessage(msg).catch(() => {
    // recordPrRefsForMessage 内部已 try/catch,此处兜底防御 refactor 漏网异常。
  });
  let pendingPrRefs = pendingPrRefWrites.get(dbClient);
  if (!pendingPrRefs) {
    pendingPrRefs = new Map();
    pendingPrRefWrites.set(dbClient, pendingPrRefs);
  }
  pendingPrRefs.set(msg.id, prRefsWrite);
  void prRefsWrite.then(() => {
    if (pendingPrRefs.get(msg.id) === prRefsWrite) pendingPrRefs.delete(msg.id);
  });
  return msg;
}

return { createMessage };
}
