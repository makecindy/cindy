/**
 * relaunchTurnFacts.ts — 把正在跑的 turn 收成「伙伴 / 对话」，只为更新重启确认的摘要。
 *
 * 不改变 busy 判定。查不到、超限或数据库失败都返回 null，确认句退回通用警告。
 * 查询列只有来源、链接角色和伙伴显示名，不读标题、路径、欢迎语或会话正文。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  classifyRelaunchTurnRows,
  type RelaunchTurnFacts,
  type RelaunchTurnRow,
} from '../shared/relaunchActivitySummary.js';
import { getDbClient } from './localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from './localDb/schema.js';

const MAX_TURN_FACTS = 32;
/** 姓名查询只为确认文案。数据库拥塞时不能把「立即重启」卡住几十秒。 */
export const RELAUNCH_TURN_FACTS_BUDGET_MS = 300;

export async function readRelaunchTurnFacts(
  sessionIds: readonly string[],
): Promise<RelaunchTurnFacts | null> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of sessionIds) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return { companions: [], conversation: false };
  if (ids.length > MAX_TURN_FACTS) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = getDbClient().drizzle
      .select({
        id: sessions.id,
        source: sessions.source,
        displayName: botProfiles.displayName,
        botStatus: botProfiles.status,
        hiddenAt: botProfiles.hiddenAt,
        linkRole: botSessionLinks.role,
      })
      .from(sessions)
      .leftJoin(
        botSessionLinks,
        and(eq(botSessionLinks.sessionId, sessions.id), isNull(botSessionLinks.archivedAt)),
      )
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(inArray(sessions.id, ids))
      .then((rows) => rows)
      .catch(() => null);
    const rows = await Promise.race([
      query,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RELAUNCH_TURN_FACTS_BUDGET_MS);
      }),
    ]);
    if (!rows) return null;
    const facts: RelaunchTurnRow[] = rows.map((row) => ({
      id: row.id,
      source: row.source ?? null,
      displayName: row.displayName ?? null,
      botStatus: row.botStatus ?? null,
      hiddenAt: row.hiddenAt ?? null,
      linkRole: row.linkRole ?? null,
    }));
    return classifyRelaunchTurnRows(ids, facts);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function describeRelaunchTurns(
  listSessionIds: () => readonly string[],
): Promise<RelaunchTurnFacts | null> {
  try {
    return await readRelaunchTurnFacts(listSessionIds());
  } catch {
    return null;
  }
}
