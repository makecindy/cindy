import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { messages } from './schema.js';

export const messageRowid = sql<number>`rowid`;

/** The owner fence and the deletion broadcast the caller supersedes through (the desktop: localDb/ipc/messages.ts). */
export interface RetriedUserTurnSupersedePorts<OwnerScope> {
  captureOwnerBroadcastScope(): OwnerScope | null;
  isOwnerBroadcastScopeCurrent(scope: OwnerScope | null | undefined): boolean;
  broadcastMessageDeleted(
    payload: { sessionId: string; clientId: string; clientIds?: string[] },
    ownerScope?: OwnerScope | null,
  ): void;
}

/**
 * retry-supersede:零产出失败 turn 被「重试」克隆重发后,软删被取代的旧 user 行
 * 与其后的 role='error' 行(coordinator 在克隆行落库且 vendor 派发成功之后调用,见
 * AgentInputQueuedMessage.supersedesUserClientId)。
 *
 * 语义与守卫:
 *  - 软删 = 置 rewind_at。普通历史读取、fork 复制、外部 transcript 导入、错误
 *    尾行告警全部按 rewind_at IS NULL 过滤,行本体保留可审计——与 context_rebuild
 *    借该列隐藏的既有先例同口径,不是 rewind-session 的回滚语义。
 *  - error 行按 (created_at, rowid) 双键窗口定位:严格晚于旧 user 行、严格早于
 *    克隆行。零产出失败的窗口内只可能有本次失败的 error 行;role 过滤兜底,
 *    绝不触碰任何产出行。
 *  - 旧行必须仍是可见的 user 行、克隆行必须已落库,任一缺失即整体 no-op(防御
 *    误传参与 deferred error 补落竞态);UPDATE 带 rewind_at IS NULL,重复调用幂等。
 *  - 单条 UPDATE 原子置位后经 messages:deleted 广播(本机各窗口 + device-link
 *    转发),desktop / mobile 的移除处理复用消息删除的既有消费端。
 *  - **刻意不广播 sessions:patched**(review 追问过):会话列表 `_count.messages` 的
 *    权威口径是「该会话全部 messages 行数,不过滤 role / rewind_at / cleared_at」
 *    (见 sessions.ts 的 SESSION_MESSAGE_COUNT_SQL),而软删只置 rewind_at 不删行,
 *    总行数不变;preview 口径虽过滤 rewind_at,但克隆行 created_at 更大、始终是最新
 *    可见行,也不变。两个值都没变,广播是多余的;拿「可见 user/assistant 数」去覆盖
 *    _count 更会把侧栏与被控端的计数打成偏小值(消费端只 shallow merge,错到下次
 *    reseed 才收敛)。
 *
 * @returns 实际软删的 clientIds(空数组 = no-op),仅供调用方与测试观察。
 */
export async function supersedeRetriedUserTurnWithPorts<OwnerScope>(
  sessionId: string,
  args: { supersededUserClientId: string; retryUserClientId: string },
  { captureOwnerBroadcastScope, isOwnerBroadcastScopeCurrent, broadcastMessageDeleted }: RetriedUserTurnSupersedePorts<OwnerScope>,
): Promise<string[]> {
  const ownerScope = captureOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const [oldRow] = await db
    .select({
      clientId: messages.clientId,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, args.supersededUserClientId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  const [retryRow] = await db
    .select({ createdAt: messages.createdAt, rowid: messageRowid })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, args.retryUserClientId)))
    .limit(1);
  if (!oldRow || !retryRow) return [];
  // 窗口两端都用 (created_at, rowid) 双键:error 行的 createdAt 取"本轮最后行 + 1",
  // 但历史数据与时钟边缘仍可能与相邻 user 行同毫秒。口径与 rewind / fork 的边界
  // 比较一致(messageRowid + gt/lt 组合),orderBy 让返回顺序确定,不依赖执行计划。
  const errorRows = await db
    .select({ clientId: messages.clientId })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'error'),
        isNull(messages.rewindAt),
        or(
          gt(messages.createdAt, oldRow.createdAt),
          and(eq(messages.createdAt, oldRow.createdAt), gt(messageRowid, oldRow.rowid)),
        ),
        or(
          lt(messages.createdAt, retryRow.createdAt),
          and(eq(messages.createdAt, retryRow.createdAt), lt(messageRowid, retryRow.rowid)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  const clientIds = [oldRow.clientId, ...errorRows.map((r) => r.clientId)];
  if (!isOwnerBroadcastScopeCurrent(ownerScope)) return [];
  await db
    .update(messages)
    .set({ rewindAt: Date.now() })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.clientId, clientIds),
        isNull(messages.rewindAt),
      ),
    );
  if (isOwnerBroadcastScopeCurrent(ownerScope)) {
    broadcastMessageDeleted({ sessionId, clientId: oldRow.clientId, clientIds }, ownerScope);
  }
  return clientIds;
}
