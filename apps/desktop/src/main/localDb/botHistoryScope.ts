import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('bot-history-scope');

export type BotHistoryScope =
  | { kind: 'unscoped' }
  | { kind: 'bot'; botId: string }
  | { kind: 'denied' };

/**
 * Resolve history ownership from host-owned runtime attribution.
 * A Bot memory scope must never fall back to account-wide history when the
 * Session id is missing or its ownership link is damaged.
 */
export async function resolveBotHistoryScope(
  callerSessionId: string | undefined,
  callerMemoryScopeKey: string | undefined,
): Promise<BotHistoryScope> {
  if (!callerSessionId) {
    return callerMemoryScopeKey?.startsWith('bot:') ? { kind: 'denied' } : { kind: 'unscoped' };
  }
  const row = await getDbClient().queryOne<{ source: string; botId: string | null }>(
    `SELECT s.source AS source,
            bsl.bot_id AS botId
       FROM sessions s
       LEFT JOIN bot_session_links bsl ON bsl.session_id = s.id
      WHERE s.id = ?
      LIMIT 1`,
    [callerSessionId],
  );
  if (!row) return { kind: 'denied' };
  if (row.source !== 'bot') return { kind: 'unscoped' };
  if (!row.botId) {
    log.warn('Bot Session is missing its ownership link', { sessionId: callerSessionId });
    return { kind: 'denied' };
  }
  return { kind: 'bot', botId: row.botId };
}

export async function resolveBotHistorySessionIds(
  callerSessionId: string | undefined,
  callerMemoryScopeKey: string | undefined,
): Promise<string[] | null> {
  const scope = await resolveBotHistoryScope(callerSessionId, callerMemoryScopeKey);
  if (scope.kind === 'unscoped') return null;
  if (scope.kind === 'denied') return [];
  // The Bot's own sessions plus the background tasks it started (ordinary
  // `desktop` sessions without a bot_session_links row).
  const rows = await getDbClient().query<{ sessionId: string }>(
    `SELECT sessionId FROM (
       SELECT session_id AS sessionId, created_at AS createdAt
         FROM bot_session_links
        WHERE bot_id = ?
       UNION
       SELECT child_session_id AS sessionId, created_at AS createdAt
         FROM bot_delegations
        WHERE requesting_bot_id = ? AND child_session_id IS NOT NULL
     )
     ORDER BY createdAt DESC`,
    [scope.botId, scope.botId],
  );
  return [...new Set(rows.map((row) => row.sessionId))];
}

/**
 * 换窗交接回忆指引用的伙伴自有会话清单(有界,最多 `limit` 条)。按归属分层而不是按时间混排:
 * 伙伴自己的私聊会话(当前主对话 + 恢复前的 history Session,最新在前)整体优先,剩余名额再
 * 给最新的、由它发起的后台任务——后台任务再多,结果也早已按回执进过主对话;而旧对话一旦被
 * 挤出清单,用户追问恢复前的事就只能得到"没有记录"。
 *
 * 只算私聊:`group`(群专线,不进主时间线)和 `delegation`(受派任务)链接都不是这段私聊。
 * 受派任务完成后会转成 `history`(tx.ts 的委派收尾),识别它靠两重标记:链接上保留的
 * `route_key = 'delegation:<id>'`(收尾不再清空,发起方被删除后仍在),以及 bot_delegations 的
 * `target_bot_id`(兜底收尾前写入的旧行)。否则群消息 / 受派内容会被当成私聊里的承诺。
 *
 * 私聊超过 `limit` 条时只列最新的,但用 `chatsTruncated` 如实告诉调用方,指引据此给模型
 * 一条可用的退路,而不是静默截断。非伙伴会话或归属损坏返回空清单。
 */
export interface BotRecallSessionIds {
  sessionIds: string[];
  /** 私聊会话比 limit 多,清单里没放全(后台任务被挤掉不算)。 */
  chatsTruncated: boolean;
}

export async function listBotRecallSessionIds(callerSessionId: string, limit: number): Promise<BotRecallSessionIds> {
  const scope = await resolveBotHistoryScope(callerSessionId, undefined);
  if (scope.kind !== 'bot' || limit <= 0) return { sessionIds: [], chatsTruncated: false };
  const db = getDbClient();
  const chats = await db.query<{ sessionId: string }>(
    `SELECT l.session_id AS sessionId FROM bot_session_links l
      WHERE l.bot_id = ? AND l.role IN ('canonical', 'history')
        AND (l.route_key IS NULL OR l.route_key NOT LIKE 'delegation:%')
        AND NOT EXISTS (
          SELECT 1 FROM bot_delegations d
           WHERE d.child_session_id = l.session_id AND d.target_bot_id = ?
        )
      ORDER BY l.created_at DESC LIMIT ?`,
    [scope.botId, scope.botId, limit + 1],
  );
  const chatsTruncated = chats.length > limit;
  const ids = new Set(chats.slice(0, limit).map((row) => row.sessionId));
  const remaining = limit - ids.size;
  if (remaining > 0) {
    const tasks = await db.query<{ sessionId: string }>(
      `SELECT child_session_id AS sessionId FROM bot_delegations
        WHERE requesting_bot_id = ? AND child_session_id IS NOT NULL
        ORDER BY created_at DESC LIMIT ?`,
      [scope.botId, remaining],
    );
    for (const row of tasks) ids.add(row.sessionId);
  }
  return { sessionIds: [...ids], chatsTruncated };
}

/**
 * 这个伙伴的队友们 —— 除它自己之外、还启用着的伙伴。
 *
 * 给提示词里的队友名册用(见 buildBotTeammateRoster):委派能力开着却不告诉伙伴
 * 队友是谁,那条能力基本不会被触发 —— 模型没有任何理由想到去调 `list_bots`,
 * 因为提示词里一个队友的名字都没出现过。
 *
 * 只列 active 的:归档/停用的伙伴委派过去也跑不起来,列出来就是空头支票。
 * 按名字排序,让同一批伙伴在不同会话里渲染出**逐字节相同**的名册 —— 名册在
 * 易变层,顺序抖动会平白打断前缀缓存。
 */
export async function listBotTeammates(input: {
  excludeBotId: string;
}): Promise<{ id: string; name: string; description?: string | null }[]> {
  const rows = await getDbClient().query<{
    id: string;
    name: string;
    description: string | null;
  }>(
    `SELECT id, display_name AS name, description
       FROM bot_profiles
      WHERE id <> ?
        AND status = 'active'
      ORDER BY display_name ASC`,
    [input.excludeBotId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
  }));
}
