/**
 * 夜间学习的对话计数：主人和伙伴每完成一轮真实对话，计数加一。只读一次数据库、写一次状态文件，
 * 不调用模型；夜间学习到点时计数为 0 就直接跳过。
 *
 * 计入：伙伴主任务、私聊话题，以及主人本人在 IM 频道里发起的轮次。
 * 不计：子代理、私下回复、群专线，自动化 / 目标 / 协同 / 其他任务投递进来的输入，
 * 以及宿主合成的隐藏指令（开场问候、续跑等 `[UI_ACTION_TRIGGER]` 行）。
 * 同一条回复只计一次（回复上记 nightlyLearningCounted），重启或重放终态不会重复计数。
 */
import { BrowserWindow } from 'electron';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { patchMessageAgentMetaWithResult } from '../localDb/ipc/messages.js';
import { drainPersistQueue, enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import { isAutomaticInputOriginKind } from '../../shared/agentInputQueue.js';
import { recordNightlyLearningTurn } from './botNightlyLearningState.js';

const parse = (raw: string | null | undefined): Record<string, any> => {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

/** 用户行的正文：纯文本或 `{ text }` 结构。 */
function inputText(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : typeof parsed?.text === 'string' ? parsed.text : raw;
  } catch {
    return raw;
  }
}

export async function countNightlyLearningTurn(sessionId: string, replyId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  const db = getDbClient();
  const current = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner && getDbClient() === db;
  await drainPersistQueue();
  if (!current()) return;
  const read = () => db.queryOne<{
    botId: string; role: string; createdAt: number; meta: string; inputMeta: string | null; inputContent: string | null;
  }>(
    `SELECT b.bot_id AS botId, b.role, m.created_at AS createdAt, m.agent_meta AS meta,
       u.agent_meta AS inputMeta, u.content AS inputContent
     FROM messages m JOIN sessions s ON s.id=m.session_id
     -- 回复不一定带 replyToClientId：没有时取这条回复之前最近的一条用户消息作为它的输入。
     LEFT JOIN messages u ON u.session_id=m.session_id AND u.role='user'
       AND (s.cleared_at IS NULL OR u.created_at > s.cleared_at)
       AND u.rowid = COALESCE(
         (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
           AND x.client_id=json_extract(m.agent_meta, '$.replyToClientId')),
         (SELECT x.rowid FROM messages x WHERE x.session_id=m.session_id AND x.role='user' AND x.rewind_at IS NULL
           AND x.rowid < m.rowid ORDER BY x.rowid DESC LIMIT 1))
     JOIN bot_session_links b ON b.session_id=s.id JOIN bot_profiles p ON p.id=b.bot_id
     WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
       AND b.role IN ('canonical','thread','channel') AND b.archived_at IS NULL AND p.status='active'
       AND s.source='bot' AND s.status='active' AND s.remote_host_id IS NULL
       AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at) /* nightly-learning-count */`,
    [sessionId, replyId],
  );
  const row = await read();
  if (!row || !current()) return;
  const meta = parse(row.meta);
  if (meta.turnCompleted !== true || meta.parentUuid || meta.botPrivateReply || meta.botGroupLane || meta.nightlyLearningCounted) return;
  const input = parse(row.inputMeta);
  if (isAutomaticInputOriginKind(input.origin?.kind) || isSyntheticTriggerText(inputText(row.inputContent))) return;
  if (row.role === 'channel' && input.imSource?.origin?.sender?.isOwner !== true) return;
  const claimed = await enqueueDurableWrite(`nightly-learning-count:${sessionId}:${replyId}`, async () => {
    if (!current()) return false;
    const latest = await read();
    if (!latest || parse(latest.meta).nightlyLearningCounted) return false;
    return !!(await patchMessageAgentMetaWithResult(sessionId, replyId, { nightlyLearningCounted: true }));
  });
  if (!claimed || !current()) return;
  await recordNightlyLearningTurn(ownerScopedUserDataPath(), row.botId, sessionId, row.createdAt);
  // 打开着的例行任务页与学习记录页随之刷新「待整理」；换账号后不推给新账号的页面。
  if (!current()) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('routines:changed');
  }
}
