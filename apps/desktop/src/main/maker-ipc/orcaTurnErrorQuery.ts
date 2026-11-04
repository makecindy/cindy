/**
 * read_worker 的 turnError 数据源:Worker **本轮** turn 的 terminal error 摘要。
 *
 * 「本轮」的判定口径沿用 ../localDb/sessionActiveTurn.ts 的 listErrorTailPendingRows:
 * error 行必须仍是会话未被 rewind 的**尾行**。turn 一旦重新跑起来就会插入新的 user 行
 * (进而产生 assistant / tool 行),旧 error 行不再是尾行,查询自然不再命中 —— 这正是
 * 「不能把上一轮的失败跨轮当成这一轮的结果报给 Lead」这条边界。
 *
 * 照搬 listErrorTailPendingRows 的三条硬约束:
 *  1. 必须带 /clear 可见性边界(created_at > COALESCE(sessions.cleared_at, 0)):
 *     /clear 不删行,只推进 cleared_at;漏掉会让已不可见的旧 error 行被当成告警。
 *  2. 「尾行」用 (created_at, rowid) 双键严格大于,两侧都要 rewind_at IS NULL:
 *     同毫秒靠插入序区分,漏掉 rewind 会把被截断的历史行当成尾行。
 *  3. 必须走 builder 形态的 select().from():生产 worker 模式的 drizzleProxy 只路由
 *     带 toSQL 的 builder,裸 .all(sql) 会被静默吞掉。
 *
 * 与 listErrorTailPendingRows 的唯一差异:不过滤 dismissed(用户点过「忽略」)。红点派生
 * 关心的是「要不要再提醒」,而这里关心的是「这一轮为什么终止」—— 诊断出口不应把用户的
 * UI 忽略动作变成信息缺失。该差异由 orcaTurnErrorQuery.test.ts 专门钉住。
 *
 * 改动这三条约束时,同步改 ../localDb/sessionActiveTurn.ts 的红点口径与注释。
 *
 * 单独成文件的原因:它原本是 register.ts 的闭包私有函数,测试无法触及,跨轮边界因此
 * 零覆盖。抽出来后测试放在本目录的 __tests__/ 下,落在 desktop 的 required unit tier
 * 门禁里(放进 localDb/** 会落到 manual 的 db tier,PR 门禁根本不跑)。
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { projectOrcaTurnErrorSummary, type OrcaTurnErrorSummary } from './orcaDiagnostics.js';

/**
 * @param workerSessionId Worker 会话 id。
 * @returns 本轮 terminal error 摘要;error 行不是尾行 / 不存在 / content 非法 JSON
 *          时返回 null。
 */
export async function readLatestWorkerTurnError(
  workerSessionId: string,
): Promise<OrcaTurnErrorSummary | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(
      and(
        eq(messages.sessionId, workerSessionId),
        eq(messages.role, 'error'),
        isNull(messages.rewindAt),
        gt(messages.createdAt, sql`COALESCE(${sessions.clearedAt}, 0)`),
        sql`NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.session_id = ${messages.sessionId}
            AND m2.rewind_at IS NULL
            AND (m2.created_at > ${messages.createdAt}
              OR (m2.created_at = ${messages.createdAt}
                AND m2.rowid > ${sql.raw('"messages"."rowid"')}))
        )`,
      ),
    )
    .limit(1);
  if (!row) return null;
  // content 是 TEXT 列,可能是非法 JSON;projectOrcaTurnErrorSummary 内部做窄取与脱敏。
  let content: unknown = null;
  try {
    content = JSON.parse(row.content);
  } catch {
    return null;
  }
  return projectOrcaTurnErrorSummary(content, row.createdAt);
}
