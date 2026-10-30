/**
 * 伙伴工作台与任务摘要的只读会话读取:有界摘录与最近用户消息 / 助手回复。
 *
 * 2026-10-17 放弃「项目」后,不再扫描本机 Claude Code / Codex / Pi 转录目录,也不再为项目
 * 现算摘要;只读 Cindy 自己库里的任务,两条有界查询,输出统一去掉 `<system-reminder>` 之类的
 * 指令块。不写库、不导入。
 */
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';

import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import {
  stripInstructionBlocks,
  type WorkbenchTranscript,
  type WorkbenchTranscriptItem,
} from '../../shared/botWorkbench.js';

export const WORKBENCH_TRANSCRIPT_MAX_CHARS = 4_000;
const PER_MESSAGE_MAX_CHARS = 1_200;
const SESSION_MESSAGE_ROWS = 60;
/** 找最近用户消息 / 助手回复时最多往回看的消息条数。 */
const LAST_EXCHANGE_ROWS = 20;

function cleanText(raw: string): string {
  return stripInstructionBlocks(raw)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 保留最近的消息,单条与总量都有界;顺序仍按时间正序。 */
export function boundTranscript(
  items: readonly WorkbenchTranscriptItem[],
  maxChars = WORKBENCH_TRANSCRIPT_MAX_CHARS,
): WorkbenchTranscript {
  const out: WorkbenchTranscriptItem[] = [];
  let used = 0;
  let truncated = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const cleaned = cleanText(items[index].text);
    if (!cleaned) continue;
    let text = cleaned.length > PER_MESSAGE_MAX_CHARS ? `${cleaned.slice(0, PER_MESSAGE_MAX_CHARS - 1)}…` : cleaned;
    if (used + text.length > maxChars) {
      const room = maxChars - used;
      truncated = true;
      if (room < 80) break;
      text = `…${text.slice(text.length - room + 1)}`;
    }
    out.push({ ...items[index], text });
    used += text.length;
    if (used >= maxChars) {
      truncated = truncated || index > 0;
      break;
    }
  }
  return { items: out.reverse(), truncated };
}

function messageText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const text = (parsed as { text?: unknown; content?: unknown }).text
        ?? (parsed as { content?: unknown }).content;
      if (typeof text === 'string') return text;
    }
    return '';
  } catch {
    return raw;
  }
}

async function sessionMessageWhere(sessionId: string) {
  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = typeof session?.clearedAt === 'number' ? session.clearedAt : NaN;
  const where = [
    eq(messages.sessionId, sessionId),
    isNull(messages.rewindAt),
    inArray(messages.role, ['user', 'assistant']),
  ];
  if (Number.isFinite(clearedAt)) where.push(gt(messages.createdAt, clearedAt));
  return { db, where: and(...where) };
}

export async function readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript> {
  const { db, where } = await sessionMessageWhere(sessionId);
  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(SESSION_MESSAGE_ROWS);
  const items = rows
    .reverse()
    .map((row) => ({ role: row.role as 'user' | 'assistant', text: messageText(row.content), at: row.createdAt }));
  return boundTranscript(items);
}

/** 最后一条用户消息与最后一条助手文字(各取清洗后的全文,由调用方再截断)。 */
export function lastExchange(items: readonly Pick<WorkbenchTranscriptItem, 'role' | 'text'>[]): {
  lastUserAsk: string | null;
  lastAssistantLine: string | null;
} {
  let lastUserAsk: string | null = null;
  let lastAssistantLine: string | null = null;
  for (let index = items.length - 1; index >= 0 && (!lastUserAsk || !lastAssistantLine); index -= 1) {
    const text = cleanText(items[index].text);
    if (!text) continue;
    if (items[index].role === 'user') {
      // Shared with remote history: coordination and recovery inputs carry the
      // same durable marker and must not replace the user's actual request.
      if (!isSyntheticTriggerText(text)) lastUserAsk ??= text;
    } else lastAssistantLine ??= text;
  }
  return { lastUserAsk, lastAssistantLine };
}

/** 本机任务的最近用户消息 / 助手回复:一条有界查询。 */
export async function readSessionLastExchange(sessionId: string) {
  const { db, where } = await sessionMessageWhere(sessionId);
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt))
    .limit(LAST_EXCHANGE_ROWS);
  return lastExchange(rows.reverse().map((row) => ({ role: row.role as 'user' | 'assistant', text: messageText(row.content) })));
}
