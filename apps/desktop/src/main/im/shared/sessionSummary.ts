/**
 * main/im/shared/sessionSummary.ts
 * ---------------------------------------------------------------------------
 * /ctr session pick 路径下的"接力 brief" — 直接返回该 session 最后一条
 * assistant turn-end 消息原文, 不做任何 LLM 总结/改写。
 *
 * 历史: 早期版本走 maker.oneShot('claude-code') + Haiku 4.5 出"接力 brief",
 * 但 LLM 总结的第一句容易跑偏 / 不忠实于原文, 用户反馈很奇怪。改成原文回显
 * 后, 用户能直接看到 agent 上轮 final 说了啥, 自行决定下一步。
 *
 * 数据来源: SQLite messages 表中 role='assistant' 且未被 rewind 软删的最新一行
 * (由 messagePersistBroadcaster 在 text isFinal / tool_use / done 等边界落库;
 * 注意 broadcaster 按 tool_use 边界分块, 一个 turn 可能有多行 assistant,
 * 这里取到的是最后一个文本块)。
 */

import { imText } from './imText';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import { messages as messagesTable } from '../../localDb/schema';
import { createLogger } from '../../logger';

const log = createLogger('im:summary');

/**
 * 从 messages.content (JSON 字符串) 中抽出 assistant 文本。
 * - persistAssistantMessage 写入时 content = string (text 本体)
 * - 老消息 / renderer 写入路径可能是 { text: '...' } 或 blocks 数组, 兜底解析
 */
function extractAssistantText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed.trim();
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.text === 'string') return parsed.text.trim();
      if (Array.isArray(parsed)) {
        const t = parsed.find((b) => b && typeof b === 'object' && b.type === 'text');
        if (t && typeof t.text === 'string') return t.text.trim();
      }
    }
  } catch {
    return raw.trim();
  }
  return '';
}

/**
 * 取该 session 最后一条 assistant turn-end 消息原文, 拼成
 * `最后一条处理的消息为:xxxx`。空 / 异常时返回 null, caller 用 fallback 文案。
 */
export async function generateTakeoverSummary(sessionId: string): Promise<string | null> {
  const t0 = Date.now();
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.sessionId, sessionId),
          eq(messagesTable.role, 'assistant'),
          isNull(messagesTable.rewindAt),
        ),
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      log.info(
        `summary skipped (no assistant message) session=...${sessionId.slice(-8)} ` +
          `elapsed=${Date.now() - t0}ms`,
      );
      return null;
    }

    const text = extractAssistantText(rows[0].content);
    if (!text) {
      log.info(
        `summary skipped (empty text) session=...${sessionId.slice(-8)} ` +
          `elapsed=${Date.now() - t0}ms`,
      );
      return null;
    }

    log.info(
      `summary done session=...${sessionId.slice(-8)} chars=${text.length} ` +
        `elapsed=${Date.now() - t0}ms`,
    );
    return imText('imBot.text.shared.takeover.lastMessage', { text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `generateTakeoverSummary failed session=...${sessionId.slice(-8)} ` +
        `elapsed=${Date.now() - t0}ms: ${msg}`,
    );
    return null;
  }
}
