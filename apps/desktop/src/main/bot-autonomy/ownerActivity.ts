/**
 * 主人最近一次和这个伙伴说话的时间：伙伴例行任务的前置检查经 stdin 的 `ownerActiveAt` 读到它，
 * 与 `lastFinishedAt` 比较就能判断「上次之后有没有新对话」（默认的夜间学习就是这样跳过的，
 * bot-routines.md「夜间学习例行任务」）。
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

/** 这条伙伴专线所属伙伴的主人最近一轮已完成对话的时间（ms）；不是伙伴专线或从未对话时为 undefined。 */
export async function lastOwnerActivityAt(laneSessionId: string): Promise<number | undefined> {
  const db = getDbClient();
  const lane = await db.query<{ botId: string }>(
    `SELECT bot_id AS botId FROM bot_session_links WHERE session_id=? LIMIT 1 /* routine-owner-activity-lane */`,
    [laneSessionId],
  );
  const botId = lane[0]?.botId;
  if (!botId) return undefined;
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = await db.query<{
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
         AND m.role='assistant' AND m.rewind_at IS NULL AND m.created_at < ?
         AND m.created_at > COALESCE(s.cleared_at, 0)
         AND json_extract(m.agent_meta, '$.turnCompleted') = 1
       ORDER BY m.created_at DESC LIMIT ${PAGE} /* routine-owner-activity */`,
      [botId, cursor],
    );
    for (const row of rows) if (isOwnerTurn(row)) return row.createdAt;
    if (rows.length < PAGE) return undefined;
    cursor = rows[rows.length - 1]!.createdAt;
  }
}

function isOwnerTurn(row: { meta: string; role: string; inputId: string | null; inputContent: string | null; inputMeta: string | null }): boolean {
  const meta = parseMeta(row.meta);
  if (meta.parentUuid || meta.botPrivateReply || meta.botGroupLane || !row.inputId) return false;
  const inputMeta = parseMeta(row.inputMeta);
  if (isAutomaticInputOriginKind(inputMeta.origin?.kind)) return false;
  const source = inputMeta.imSource;
  if (row.role === 'channel' && source?.origin?.sender?.isOwner !== true) return false;
  const userText = row.role === 'channel' && typeof source?.userText === 'string'
    ? source.userText : textOf(row.inputContent ?? '');
  return !!userText.trim() && !isSyntheticTriggerText(userText);
}
