/**
 * The latest user ask and assistant reply of a local task (get_task_digest). One bounded query on
 * Cindy's own database; instruction blocks such as `<system-reminder>` are stripped. Read only.
 */
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';

import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';

/** How far back to look for the latest user ask / assistant reply. */
const LAST_EXCHANGE_ROWS = 20;

/** Drop angle-bracket instruction blocks (such as `<system-reminder>…</system-reminder>`) and stray tags. */
function stripInstructionBlocks(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(/<([A-Za-z][\w-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ');
}

function cleanText(raw: string): string {
  return stripInstructionBlocks(raw)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/** 最后一条用户消息与最后一条助手文字(各取清洗后的全文,由调用方再截断)。 */
export function lastExchange(items: readonly { role: 'user' | 'assistant'; text: string }[]): {
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
