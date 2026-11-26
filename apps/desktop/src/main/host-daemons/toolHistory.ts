/**
 * host-daemons/toolHistory —— 归属追溯用的只读消息查询。
 *
 * 只读 `tool_use`：agent 真正执行过的命令。命令的输出（`tool_result`）不算证据——
 * 任何会话跑一次 `schtasks /query` 或 `crontab -l`，输出里就有机器上现成的全部条目。
 * 用户聊天里提到某个名字同理不算。
 *
 * 两种读法都走 `idx_messages_created_at`、在库里按同一组信任条件过滤，并以后台级
 * 发出（面板触发的读要让位于交互与写入）：
 * - 有界窗口：定义时刻前后各 5 分钟，一次读完。
 * - 全历史分页：给没有定义时刻的来源（crontab）用。实测 2.2 GB 的库（约 35 万行
 *   工具调用）冷盘单页最长约 1 秒、热缓存单页几毫秒，所以调用方必须分片推进，
 *   不能在一次请求里读完。
 */

import { and, asc, eq, gt, gte, isNull, lte, notExists, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { runAsBackgroundDbRpc } from '../localDb/client/rpcAdmission';
import { messages, sessionImports, sessions } from '../localDb/schema';
import type { ToolMessageRow } from './attribution.js';

/** 单个窗口最多取多少行（超出时截断，并回报 `truncated`）。 */
export const TOOL_MESSAGE_WINDOW_LIMIT = 300;

/** 窗口被截断时放宽到的上限：10 分钟窗口里超过 300 次工具调用很少见，放宽后读不全更少见。 */
export const TOOL_MESSAGE_WINDOW_WIDE_LIMIT = 5_000;

/** 全历史回看每页的行数。 */
export const TOOL_MESSAGE_PAGE_LIMIT = 300;

export interface ToolMessageWindow {
  rows: ToolMessageRow[];
  /**
   * 窗口内消息超过上限，只读到其中一部分。
   *
   * 匹配放在 JS 里做（`toLowerCase()` 才是完整的大小写折叠，SQLite 的 `lower()`
   * 只处理 ASCII，任务名里非 ASCII 大写字母会被错杀），所以必须把「没读全」和
   * 「读全了确实没有」分开报给调用方：前者不能当作「查无此人」写进长期负缓存。
   */
  truncated: boolean;
}

export interface ToolUseCursor {
  createdAt: number;
  id: string;
}

export interface ToolMessagePage {
  rows: ToolMessageRow[];
  /** 接着读的起点（本页最后一行）；一行都没读到 → null。 */
  next: ToolUseCursor | null;
  /** 历史已经读到最新的一行。之后新落的行从 `next` 接着读，不必从头再来。 */
  exhausted: boolean;
}

/**
 * 工具调用行里实际交给工具的文本。
 *
 * 库里存的是 JSON（`{ toolUseId, toolName, input }`），命令里的引号、反斜杠、换行
 * 在其中都是转义形态（`\"`、`\\`、`\n`）。拿追溯词去比对转义后的文本，带引号的
 * crontab 命令永远对不上，条目会被判成「无关」。这里取出 `input`，把它里面的字符串
 * 值拼成一段（数组展开、对象递归）；解不出 JSON 的行原样返回。
 */
function toolUseInputText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed === 'string') return parsed;
  // 只认 input：toolUseId、toolName 是标识，不是交给工具的内容。
  const input =
    parsed !== null && typeof parsed === 'object' && 'input' in parsed
      ? (parsed as { input: unknown }).input
      : parsed;
  const parts: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(collect);
  };
  collect(input);
  return parts.join('\n');
}

const trustedColumns = {
  sessionId: messages.sessionId,
  title: sessions.title,
  content: messages.content,
};

/**
 * 只认能确认在本机执行的记录：SSH 远端会话的工具调用也会落进同一张消息表，
 * 远端消息提到同名任务时会被误当成本机归属证据（进而授权停止/删除无关的本机任务）。
 * 分享/工具导入的会话：导入的旧消息保留外机原始时间，无法证明在本机执行过；
 * 只认导入时刻之后新产生的消息（导入后真正在本机执行的记录）。
 */
type DrizzleClient = ReturnType<typeof getDbClient>['drizzle'];

const trustedLocalExecution = (db: DrizzleClient) =>
  and(
    eq(messages.sessionId, sessions.id),
    isNull(sessions.remoteHostId),
    notExists(
      db
        .select({ sessionId: sessionImports.sessionId })
        .from(sessionImports)
        .where(
          and(
            eq(sessionImports.sessionId, sessions.id),
            gt(sessionImports.importedAt, messages.createdAt),
          ),
        ),
    ),
  );

export async function readToolUses(
  fromMs: number,
  toMs: number,
  limit = TOOL_MESSAGE_WINDOW_LIMIT,
): Promise<ToolMessageWindow> {
  return runAsBackgroundDbRpc(async () => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select(trustedColumns)
      .from(messages)
      .leftJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          gte(messages.createdAt, fromMs),
          lte(messages.createdAt, toMs),
          eq(messages.role, 'tool_use'),
          trustedLocalExecution(db),
        ),
      )
      .orderBy(asc(messages.createdAt))
      // 多取一行只为判断是否被截断，不把它当证据。
      .limit(limit + 1);
    return {
      rows: rows.slice(0, limit).map((row) => ({
        sessionId: row.sessionId,
        title: row.title ?? null,
        content: toolUseInputText(row.content),
      })),
      truncated: rows.length > limit,
    };
  });
}

export async function readToolUsesFrom(
  after: ToolUseCursor | null,
  limit = TOOL_MESSAGE_PAGE_LIMIT,
): Promise<ToolMessagePage> {
  return runAsBackgroundDbRpc(async () => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({ ...trustedColumns, createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .leftJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          eq(messages.role, 'tool_use'),
          trustedLocalExecution(db),
          after
            ? or(
                gt(messages.createdAt, after.createdAt),
                and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
      // 多取一行只为知道后面还有没有行，不把它当证据。
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        sessionId: row.sessionId,
        title: row.title ?? null,
        content: toolUseInputText(row.content),
      })),
      next: last ? { createdAt: last.createdAt, id: last.id } : null,
      exhausted: rows.length <= limit,
    };
  });
}
