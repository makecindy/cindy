/**
 * latestMessageText — 取会话 user / assistant 消息的纯文本素材。
 *
 * 与 messages:list 同一套可见性口径:只取 clearedAt 之后、未被 rewind 软删的消息,
 * 否则 /clear 过的会话会读到本该隐藏的旧内容。排序同样对齐 messages:list:
 * createdAt 相同(同毫秒批量落库)时以 rowid 保持写入顺序,避免 transcript 错序。
 *
 * 消费方:sessionTaskSummary(置顶卡片摘要素材,用 latestMessage)、maker-ipc/title
 * (重命名输入框 Magic 按钮按对话内容重起标题,用 regenerateTitleMaterial)。
 * 放在 localDb 层而不是 sessionTaskSummary,是为避免 maker-ipc → sessionTaskSummary
 * → maker-host/index → maker-ipc 的静态模块环。
 */

import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import { extractText } from '../sessionTaskSummary.logic.js';

import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

export interface LatestMessage {
  text: string;
  /** unix ms;无该角色可见消息时为 null。调用方可据此判断 user/assistant 是否同轮。 */
  createdAt: number | null;
}

/** regenerateTitleMaterial 的单条素材:带角色的纯文本消息。
 *  rowid 用于精确判断某行是否落在最近窗口内(同毫秒批量落库时时间戳无法区分行)。 */
export interface RecentMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number | null;
  rowid: number;
}

/** 对话开场素材:无开场时 text 为空串、rowid 为 null。 */
export interface OpeningMessage {
  text: string;
  createdAt: number | null;
  rowid: number | null;
}

/** Magic 重命名的素材包:对话开场 + 最近窗口。 */
export interface RegenerateTitleMaterial {
  /** 第一条非空文本的用户消息(对话开场,通常最能定义会话主题)。 */
  opening: OpeningMessage;
  /** 最近 limit 条非空文本的 user/assistant 消息,时间正序(最新一条在末尾)。 */
  recent: RecentMessage[];
}

/** 同毫秒 tie-breaker:与 messages:list 一致,用 SQLite rowid 保持写入顺序。 */
const messageRowid = sql<number>`rowid`;

/** 开场扫描窗口:会话开头可能连续多条纯附件等抽不出正文的消息,按序多看一批。 */
const OPENING_SCAN_LIMIT = 15;

/** 读会话 clearedAt(/clear 可见性边界)。会话不存在 → null。 */
async function sessionClearedAt(sessionId: string): Promise<number | null> {
  const [sess] = await getDbClient()
    .drizzle.select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return sess?.clearedAt ?? null;
}

export async function latestMessage(
  sessionId: string,
  role: 'user' | 'assistant',
): Promise<LatestMessage> {
  const db = getDbClient().drizzle;
  const clearedAt = await sessionClearedAt(sessionId);
  const conds = [
    eq(messages.sessionId, sessionId),
    eq(messages.role, role),
    isNull(messages.rewindAt),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  const [row] = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  return { text: extractText(row?.content, role), createdAt: row?.createdAt ?? null };
}

export async function latestMessageText(
  sessionId: string,
  role: 'user' | 'assistant',
): Promise<string> {
  return (await latestMessage(sessionId, role)).text;
}

/**
 * 最近 `limit` 条非空文本的 user / assistant 消息,时间正序。工具行等抽不出
 * 正文的消息会被跳过,所以 DB 侧多取 3 倍再过滤,保证长会话里也能凑满窗口。
 */
async function recentMessagesWithClearedAt(
  sessionId: string,
  limit: number,
  clearedAt: number | null,
): Promise<RecentMessage[]> {
  const db = getDbClient().drizzle;
  const conds = [
    eq(messages.sessionId, sessionId),
    inArray(messages.role, ['user', 'assistant']),
    isNull(messages.rewindAt),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(limit * 3);
  const picked: RecentMessage[] = [];
  for (const row of rows) {
    const role = row.role === 'user' ? 'user' : 'assistant';
    const text = extractText(row.content, role);
    if (!text) continue;
    picked.push({ role, text, createdAt: row.createdAt ?? null, rowid: row.rowid });
    if (picked.length >= limit) break;
  }
  return picked.reverse();
}

/** 第一条非空文本的用户消息;开头连续附件超过扫描窗口时退化为空(调用方按无开场处理)。 */
async function firstUserMessageWithClearedAt(
  sessionId: string,
  clearedAt: number | null,
): Promise<OpeningMessage> {
  const db = getDbClient().drizzle;
  const conds = [
    eq(messages.sessionId, sessionId),
    eq(messages.role, 'user'),
    isNull(messages.rewindAt),
  ];
  if (clearedAt != null) conds.push(gt(messages.createdAt, clearedAt));
  const rows = await db
    .select({ content: messages.content, createdAt: messages.createdAt, rowid: messageRowid })
    .from(messages)
    .where(and(...conds))
    .orderBy(asc(messages.createdAt), asc(messageRowid))
    .limit(OPENING_SCAN_LIMIT);
  for (const row of rows) {
    const text = extractText(row.content, 'user');
    if (text) return { text, createdAt: row.createdAt ?? null, rowid: row.rowid };
  }
  return { text: '', createdAt: null, rowid: null };
}

/**
 * Magic 重命名的素材一次取齐:clearedAt 只查一次,开场与最近窗口两个查询并发。
 * (拆成两个独立导出会让调用方并发时重复查 clearedAt,review 反馈已合并。)
 */
export async function regenerateTitleMaterial(
  sessionId: string,
  recentLimit: number,
): Promise<RegenerateTitleMaterial> {
  const clearedAt = await sessionClearedAt(sessionId);
  const [recent, opening] = await Promise.all([
    recentMessagesWithClearedAt(sessionId, recentLimit, clearedAt),
    firstUserMessageWithClearedAt(sessionId, clearedAt),
  ]);
  return { recent, opening };
}
