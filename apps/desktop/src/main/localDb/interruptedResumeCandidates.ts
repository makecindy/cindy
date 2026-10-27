/**
 * 启动「继续上次中断的任务」弹窗的数据源。
 *
 * 中断判定完全复用 listInterruptedPendingRows(startedAt > endedAt 且早于本进程启动),
 * 这里只为每个中断会话补两项展示素材:
 *  - interruptedAt:中断那一轮最后一条落库消息的时间(崩溃时刻无从得知,最后一次
 *    落库是最接近的可观察值);该轮没有任何落库消息时回退到 turn 开始时间;
 *  - lastToolUse:中断那一轮最后一次工具调用的原始 toolName / input,由 IPC 层格式化成
 *    与灵动岛同源的「正在做什么」文案。没有工具调用时为 null,界面只显示项目与时间。
 *
 * 必须走 `.select().from()` builder:生产 worker 模式的 drizzleProxy 只路由带 toSQL 的
 * builder(同 sessionActiveTurn.ts 的说明)。
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';

import { getDbClient } from './client/current';
import { listInterruptedPendingRows } from './sessionActiveTurn';
import { messages } from './schema';

export interface InterruptedTurnToolUse {
  toolName: string;
  input: unknown;
}

export interface InterruptedResumeCandidateRow {
  sessionId: string;
  interruptedAt: number;
  lastToolUse: InterruptedTurnToolUse | null;
}

/** 同毫秒批量落库时以 rowid 保持写入顺序(与 messages:list 口径一致)。 */
const messageRowid = sql<number>`rowid`;

function parseToolUse(raw: string | null): InterruptedTurnToolUse | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { toolName, input } = parsed as { toolName?: unknown; input?: unknown };
    return typeof toolName === 'string' && toolName ? { toolName, input } : null;
  } catch {
    return null;
  }
}

export async function listInterruptedResumeCandidateRows(): Promise<
  InterruptedResumeCandidateRow[]
> {
  const pending = await listInterruptedPendingRows();
  if (pending.length === 0) return [];
  const db = getDbClient().drizzle;
  return Promise.all(
    pending.map(async ({ sessionId, startedAt }) => {
      const inTurn = and(
        eq(messages.sessionId, sessionId),
        isNull(messages.rewindAt),
        gte(messages.createdAt, startedAt),
      );
      const [lastMessage] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(inTurn)
        .orderBy(desc(messages.createdAt), desc(messageRowid))
        .limit(1);
      const [lastTool] = await db
        .select({ content: messages.content })
        .from(messages)
        .where(and(inTurn, eq(messages.role, 'tool_use')))
        .orderBy(desc(messages.createdAt), desc(messageRowid))
        .limit(1);
      return {
        sessionId,
        interruptedAt: lastMessage?.createdAt ?? startedAt,
        lastToolUse: parseToolUse(lastTool?.content ?? null),
      };
    }),
  );
}
