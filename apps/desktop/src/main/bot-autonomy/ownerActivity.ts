/**
 * 「主人和这个伙伴有没有新对话」：例行任务的通用前置条件 `requireOwnerActivity` 用它在派发前判断，
 * 没有就跳过，不建任务、不调用模型（bot-routines.md「只在主人有新对话时运行」）。
 *
 * 口径：伙伴主任务、私聊话题与 IM 渠道专线里，主人本人发起、伙伴已经答完的轮次。不算子代理、
 * 私下回复、群专线，也不算自动化 / 目标 / 协同 / 其他任务投递的输入。
 */
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import { isAutomaticInputOriginKind } from '../../shared/agentInputQueue.js';
import { getDbClient } from '../localDb/client/current.js';

const PAGE = 200;

type Meta = {
  parentUuid?: unknown;
  botPrivateReply?: unknown;
  botGroupLane?: unknown;
  origin?: { kind?: string };
  imSource?: { userText?: unknown; origin?: { sender?: { isOwner?: unknown } } };
};

const parseMeta = (raw: string | null): Meta => {
  try { return JSON.parse(raw || '{}') as Meta; } catch { return {}; }
};

function textOf(raw: string): string {
  let parsed: unknown = raw;
  try { parsed = JSON.parse(raw); } catch { /* Plain text is already the content. */ }
  if (typeof parsed === 'string') return parsed;
  const text = (parsed as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
}

/** 自 `after`（不含）以来是否有一轮主人与伙伴已完成的对话。 */
export async function hasOwnerActivitySince(botId: string, after: number): Promise<boolean> {
  let cursor = after;
  for (;;) {
    const rows = await getDbClient().query<{
      createdAt: number; meta: string; role: string;
      inputId: string | null; inputContent: string | null; inputMeta: string | null;
    }>(
      `SELECT m.created_at AS createdAt, m.agent_meta AS meta, b.role,
         u.client_id AS inputId, u.content AS inputContent, u.agent_meta AS inputMeta
       FROM messages m JOIN sessions s ON s.id=m.session_id
       JOIN bot_session_links b ON b.session_id=s.id
       -- 回复不一定带 replyToClientId：没有时取这条回复之前最近的一条用户消息作为它的输入。
       LEFT JOIN messages u ON u.session_id=m.session_id AND u.role='user'
         AND u.created_at > COALESCE(s.cleared_at, 0)
         AND u.rowid = COALESCE(
           (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
             AND x.client_id=json_extract(m.agent_meta, '$.replyToClientId')),
           (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
             AND x.rowid < m.rowid ORDER BY x.rowid DESC LIMIT 1))
       WHERE b.bot_id=? AND b.role IN ('canonical','thread','channel') AND b.archived_at IS NULL
         AND s.source='bot' AND s.status='active' AND s.remote_host_id IS NULL
         AND m.role='assistant' AND m.rewind_at IS NULL AND m.created_at > ?
         AND m.created_at > COALESCE(s.cleared_at, 0)
         AND json_extract(m.agent_meta, '$.turnCompleted') = 1
       ORDER BY m.created_at ASC LIMIT ${PAGE} /* routine-owner-activity */`,
      [botId, cursor],
    );
    for (const row of rows) {
      const meta = parseMeta(row.meta);
      if (meta.parentUuid || meta.botPrivateReply || meta.botGroupLane || !row.inputId) continue;
      const inputMeta = parseMeta(row.inputMeta);
      if (isAutomaticInputOriginKind(inputMeta.origin?.kind)) continue;
      const source = inputMeta.imSource;
      if (row.role === 'channel' && source?.origin?.sender?.isOwner !== true) continue;
      const userText = row.role === 'channel' && typeof source?.userText === 'string'
        ? source.userText : textOf(row.inputContent ?? '');
      if (userText.trim() && !isSyntheticTriggerText(userText)) return true;
    }
    if (rows.length < PAGE) return false;
    cursor = rows[rows.length - 1]!.createdAt;
  }
}
