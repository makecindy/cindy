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
  const rows = await getDbClient().query<{ sessionId: string }>(
    `SELECT session_id AS sessionId
       FROM bot_session_links
      WHERE bot_id = ?
      ORDER BY created_at DESC`,
    [scope.botId],
  );
  return rows.map((row) => row.sessionId);
}
