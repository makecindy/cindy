import { and, gte, inArray, ne, sql } from 'drizzle-orm';

import { dailySessionUsage, sessions } from './schema.js';
import { localDayKey } from './dailySpend.js';
import { getDbClient } from './client/current.js';

/** 每日 × 任务的 token 行 (daily_session_usage)。 */
export interface DailySessionUsageRow {
  day: string;
  sessionId: string;
  tokens: number;
}

/** 用量历史展示任务所需的元数据 (取任务当前值, 不是每轮事实)。 */
export interface UsageTaskMeta {
  sessionId: string;
  title: string;
  model: string;
  providerId: string | null;
  contextTokens: number;
  contextWindow: number;
  /** userSendAt 与 updatedAt 中较新者 (unix ms)。 */
  lastActiveAt: number;
}

/** 给某任务当天累加一笔 turn token(与 daily_model_usage 同一处调用)。 */
export async function incrementDailySessionUsage(
  sessionId: string,
  tokens: number,
  ts: number = Date.now(),
): Promise<void> {
  const delta = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  if (!sessionId || delta === 0) return;
  await getDbClient()
    .drizzle.insert(dailySessionUsage)
    .values({ day: localDayKey(ts), sessionId, tokens: delta, updatedAt: ts })
    .onConflictDoUpdate({
      target: [dailySessionUsage.day, dailySessionUsage.sessionId],
      set: { tokens: sql`${dailySessionUsage.tokens} + ${delta}`, updatedAt: ts },
    })
    .run();
}

/**
 * 所有记过用量、且仍存在(未删除)的任务的当前元数据。
 * 这是任务元数据的完整集合:调用方据此覆盖旧元数据,不在集合里的任务视为已删除。
 */
export async function getUsageTaskMeta(): Promise<UsageTaskMeta[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      sessionId: sessions.id,
      title: sessions.title,
      model: sessions.model,
      providerId: sessions.providerId,
      contextTokens: sessions.contextTokens,
      contextWindow: sessions.contextWindow,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        ne(sessions.status, 'deleted'),
        inArray(
          sessions.id,
          db.selectDistinct({ id: dailySessionUsage.sessionId }).from(dailySessionUsage),
        ),
      ),
    )
    .all();
  return rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.title,
    model: row.model,
    providerId: row.providerId ?? null,
    contextTokens: row.contextTokens ?? 0,
    contextWindow: row.contextWindow ?? 0,
    lastActiveAt: Math.max(row.userSendAt ?? 0, row.updatedAt),
  }));
}

/**
 * 读取 sinceDay(含)之后的每日 × 任务行,并附上全部任务的当前元数据(getUsageTaskMeta)。
 * 已删除任务的行不返回 —— 与侧栏一致, 删掉的任务不再出现在排行里。
 */
export async function getSessionUsageSince(
  sinceDay: string,
): Promise<{ rows: DailySessionUsageRow[]; tasks: UsageTaskMeta[] }> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      day: dailySessionUsage.day,
      sessionId: dailySessionUsage.sessionId,
      tokens: dailySessionUsage.tokens,
    })
    .from(dailySessionUsage)
    .innerJoin(sessions, sql`${sessions.id} = ${dailySessionUsage.sessionId}`)
    .where(and(gte(dailySessionUsage.day, sinceDay), ne(sessions.status, 'deleted')))
    .all();
  return {
    rows: rows.filter((row) => row.tokens > 0),
    tasks: await getUsageTaskMeta(),
  };
}
