import { and, desc, eq, gt, gte, isNull, or, sql } from 'drizzle-orm';
import type { DataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { getDbClient } from './client/current.js';
import { safeStringify } from './mapper.js';
import { messages, sessions } from './schema.js';

/**
 * The pending handoff reads and the consumed write behind the pending handoff registry
 * (maker-ipc/agentHandoffPending.ts), moved unchanged from ipc/messages.ts (which keeps exporting
 * them) so the Node Host can load them without Electron. The one change: showing a rewritten engine
 * switch boundary to the renderer is a port of the consumed write, which ipc/messages.ts binds.
 */

const messageRowid = sql<number>`rowid`;

export interface AgentHandoffConsumedPorts {
  /** Called first, before any read: the owner the rewritten boundary is shown to. */
  captureOwnerBroadcastScope(): DataOwnerBroadcastScope | null;
  /** Rewrites an engine switch boundary and shows it again (ipc/messages.ts); its result is not read. */
  updateAgentSwitchBoundaryContent(
    sessionId: string,
    clientId: string,
    content: unknown,
    ownerScope: DataOwnerBroadcastScope | null,
  ): Promise<unknown>;
}

/**
 * 查是否有尚未随首条 user 消息发送的内部 handoff。
 * 判定规则(确定性,重启后可从 DB 重建 pending 状态):
 *   - agent_switch:未 rewind 的边界行；
 *   - context_rebuild:消息删除事务写入、刻意用 rewind_at 隐藏的内部行。
 * 两类取晚于 /clear 的最新一条，以 content.consumed 为真源。只有缺 consumed
 * 字段的 v1 agent_switch 老行才回落“边界后是否已有 user 行”的启发式。
 * 同毫秒并列用 rowid 决序(与 messages list 的 tie-break 口径一致)。
 */
export async function findPendingAgentHandoff(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [boundary] = await db
    .select({
      rowid: messageRowid,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        ),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!boundary) return null;
  let parsed: { handoff?: unknown; consumed?: unknown };
  try {
    parsed = JSON.parse(boundary.content) as typeof parsed;
  } catch {
    return null;
  }
  const handoff =
    typeof parsed.handoff === 'string' && parsed.handoff.length > 0 ? parsed.handoff : null;
  if (!handoff || parsed.consumed === true) return null;
  // v2 边界以持久消费位为真源:失败首发可能已先落 user 行；只要 vendor 尚未
  // accepted,重启后仍必须恢复交接。缺字段的 v1 老行才走 user-row 启发式。
  if (parsed.consumed === false) return handoff;
  if (boundary.role === 'context_rebuild') return handoff;
  const [userAfter] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'user'),
        isNull(messages.rewindAt),
        or(
          gt(messages.createdAt, boundary.createdAt),
          and(eq(messages.createdAt, boundary.createdAt), gt(messageRowid, boundary.rowid)),
        ),
      ),
    )
    .limit(1);
  if (userAfter) return null;
  return handoff;
}

/**
 * 查 fork 出的子会话是否还欠一条「来源标记」——返回父会话 id,不欠则 null。
 *
 * 判定"子会话是否已经自己跑过一轮",两个信号取**或**——单用任一个都有整条引擎
 * 线失效。按代码里的判定顺序:
 *  1. 存在未 rewind 的 assistant 行(`createdAt >= session.createdAt`):引擎无关的
 *     主信号,带 rewind_at 过滤,所以回滚掉首个 post-fork turn 后会自动失效;
 *  2. `total_token_usage > 0` **且**存在未 rewind 的 user 行:Codex 补充——Claude
 *     完成路径不累加该列(recordSessionTurnTokens 的唯一调用点在 register.ts 的
 *     `event.source === 'codex'` done 分支),而 token 计数不随 rewind 回退,所以必须
 *     搭配一条仍存活的 user 行才作数。
 *
 * 精度边界(都落在信号一的时间戳比较上,方向不同):
 *  - **漏注入一次**:外部导入的会话里 createdAt 是**合成**的,importer 故意写
 *    `createdAt + sequence`(claude-local-sessions.ts)与 `timestamp + lineNo`
 *    (codex-local-sessions.ts)来强制行序,长 transcript 的末尾行能超出真实墙钟
 *    好几秒;fork 这类会话时,复制来的 assistant 可能被算成子会话自己的回应。
 *    同毫秒边界(复制行与 fork 操作同一毫秒)同理。
 *  - **多注入一次**:一轮跑完但 usage 上报失败、或 turn 中途重启。
 *
 * 为什么不看 user 行:goal 路径的 setGoal 先 persistUserMessage 再 fireTurn→peek
 * (goal-host/controller.ts),dispatch 前就落了 user 行,会把 fork 后首个动作是
 * /goal 的会话误判成已发送。assistant 只在模型确实回应后才出现,没这个问题。
 *
 * 为什么不加持久消费位:写 messages 隐藏边界行会让该会话之后再也不能被 fork
 * (resolveForkNativeSource 见到 context_rebuild 即判 UNSUPPORTED_HISTORY);
 * 加 schema 列则是为一个元信息付一次 migration。两者的代价都高于上述边角。
 */
export async function findPendingForkOrigin(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({
      parentSessionId: sessions.parentSessionId,
      createdAt: sessions.createdAt,
      clearedAt: sessions.clearedAt,
      totalTokenUsage: sessions.totalTokenUsage,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!sessRow?.parentSessionId) return null;
  // fork 之后 /clear 过:渲染历史与原生上下文都被显式重置成新对话,再把来源标记
  // 灌进去等于往用户主动清空的上下文里塞旧元信息。
  if (sessRow.clearedAt !== null && sessRow.clearedAt >= sessRow.createdAt) return null;
  // 信号一(引擎无关):子会话自己产生过 assistant 行。带 rewindAt 过滤,所以回滚掉
  // 首个 post-fork turn 之后该信号会自动失效——标记重新 arm,正是期望行为。
  const [assistantAfterFork] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        gte(messages.createdAt, sessRow.createdAt),
      ),
    )
    .limit(1);
  if (assistantAfterFork) return null;
  // 信号二(Codex 补充):Claude 完成路径不累加 total_token_usage(唯一调用点在
  // register.ts 的 codex done 分支),所以只有 Codex 会走到这里。**必须搭配一条仍
  // 存活的 user 行**才作数:token 计数不随 rewind 回退,单看它会让"回滚掉首个
  // post-fork turn 再重发"的 Codex 会话永远拿不回来源标记。
  if ((sessRow.totalTokenUsage ?? 0) > 0) {
    const [userAfterFork] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'user'),
          isNull(messages.rewindAt),
          gte(messages.createdAt, sessRow.createdAt),
        ),
      )
      .limit(1);
    if (userAfterFork) return null;
  }
  return sessRow.parentSessionId;
}

/**
 * 只看 fork 血缘,不看首发消费态——给"重建原生上下文"用。
 *
 * 与 findPendingForkOrigin 的区别在语义:后者管的是"首发那一次性的来源标记",
 * 跑过一轮就该消费掉;而 fork 这个**事实**是会话的永久属性。引擎切换与消息删除
 * 会从持久消息重新拼出一份交接、创建新的原生上下文,那份交接是纯粹按 messages
 * 重建的,不含任何 fork 信息——若这里也跟着"已消费"一起沉默,新原生上下文就再也
 * 不知道自己是分叉出来的。
 *
 * /clear 之后同样抑制:那时历史已被用户显式重置,血缘不该再进新上下文。
 */
export async function findForkParentSessionId(sessionId: string): Promise<string | null> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({
      parentSessionId: sessions.parentSessionId,
      createdAt: sessions.createdAt,
      clearedAt: sessions.clearedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!sessRow?.parentSessionId) return null;
  if (sessRow.clearedAt !== null && sessRow.clearedAt >= sessRow.createdAt) return null;
  return sessRow.parentSessionId;
}

/** vendor accepted 后持久化最新 handoff 消费位；内存 registry 不等待这笔辅助写。 */
export async function markLatestAgentHandoffConsumedWithPorts(
  ports: AgentHandoffConsumedPorts,
  sessionId: string,
): Promise<void> {
  const ownerScope = ports.captureOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const [boundary] = await db
    .select({ clientId: messages.clientId, role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          and(eq(messages.role, 'agent_switch'), isNull(messages.rewindAt)),
          eq(messages.role, 'context_rebuild'),
        ),
        afterClear,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (!boundary) return;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(boundary.content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    parsed = value as Record<string, unknown>;
  } catch {
    return;
  }
  if (parsed.consumed === true) return;
  const nextContent = { ...parsed, consumed: true };
  if (boundary.role === 'agent_switch') {
    await ports.updateAgentSwitchBoundaryContent(sessionId, boundary.clientId, nextContent, ownerScope);
    return;
  }
  await getDbClient()
    .drizzle.update(messages)
    .set({ content: safeStringify(nextContent) })
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, boundary.clientId),
        eq(messages.role, 'context_rebuild'),
      ),
    );
}
