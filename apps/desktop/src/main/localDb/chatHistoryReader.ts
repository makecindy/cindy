/**
 * chatHistoryReader.ts —— 给 cindy_helper 的 history 类 MCP 工具用的纯查询层。
 *
 * 三个函数:
 *  - listWorkdirsForHistory  → 列出所有出现在 sessions.working_dir 里的目录 + 聚合
 *  - listSessionsForHistory  → 按 workdir / 时间段 / agentKind 过滤 session 列表
 *  - getMessagesForHistory   → 按多种过滤组合拉 messages, JOIN session 元数据
 *
 * 设计要点:
 *  - 消息按 (createdAt, rowid)、其它历史按 (createdAt, id) 分页，保证同毫秒顺序稳定
 *  - 不暴露 IPC, 仅供 mcp-providers.ts 注入给 xdt-helper MCP server
 *  - content / agentMeta JSON 解析复用 mapper.ts 已有逻辑, 保证形态一致
 *  - 时间参数从工具层进来时已经是 unix ms (由 tool handler 把 ISO 转好); reader 不做时间转换
 */

import { and, asc, desc, eq, gt, gte, lt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { getDbClient } from './client/current';
import { sessions, messages } from './schema';
import { messageToCamel } from './mapper';
import {
  managedDialogueRootLikePatterns,
  normalizeHistoryWorkingDir,
  resolveStoredWorkingDirCandidates,
} from './workingDirHistoryFilter';

const messageRowid = sql<number>`"messages"."rowid"`;

// ── Types ───────────────────────────────────────────────────────────────────

export type HistoryOrder = 'asc' | 'desc';
export type HistoryAgentKind = 'cc' | 'codex';

export interface HistoryCursor {
  createdAt: number; // unix ms
  id: string;
  /** SQLite insertion-order tie-breaker for message history cursors. */
  rowid?: number;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor: HistoryCursor | null;
  hasMore: boolean;
}

// ── list_workdirs ───────────────────────────────────────────────────────────

export interface ListWorkdirsParams {
  limit: number;
  cursor: HistoryCursor | null; // cursor.createdAt = lastSessionAt 的 ms; cursor.id = workingDir 字符串
  order: HistoryOrder;
}

export interface WorkdirAggregate {
  workingDir: string;
  sessionCount: number;
  firstSessionAt: number; // unix ms
  lastSessionAt: number; // unix ms
  agentKinds: string[];
}

/**
 * 列出所有 sessions.workingDir(去 NULL + 去 deleted), 按最后活动时间排序。
 * Cursor 形态: { createdAt: lastSessionAt(ms), id: workingDir(string) }
 *
 * slash-variant 合组在内存做(SQL 表达式复刻 normalizeWorkingDirForStorage 会
 * 产生第二份归一实现, 漂移风险大于收益)。物化集合的有界性靠 SQL 侧排除
 * app-managed dialogue 目录保证(见下), 剩余行数是用户项目数量级(< 100),
 * 全量拉回 + 内存合并 + over-fetch 判 hasMore 开销可忽略。
 */
export async function listWorkdirsForHistory(
  params: ListWorkdirsParams,
): Promise<HistoryPage<WorkdirAggregate>> {
  const db = getDbClient().drizzle;
  const orderFn = params.order === 'asc' ? asc : desc;
  // SQLite GROUP_CONCAT 没有内置 DISTINCT 区分; 用 sql 表达式更直观, 后端再 split
  const lastTs = sql<number>`MAX(${sessions.createdAt})`;
  const firstTs = sql<number>`MIN(${sessions.createdAt})`;
  const cnt = sql<number>`COUNT(*)`;
  const kinds = sql<string>`GROUP_CONCAT(DISTINCT ${sessions.agentKind})`;

  // 基础过滤: 不要 deleted, 不要无 workingDir
  const baseConds = [ne(sessions.status, 'deleted'), isNotNull(sessions.workingDir)];
  // 排除 app-managed dialogue 子树(<userData>/dialogues/<day>/<sessionId>):
  // 每个 standalone dialogue 会话一个目录, 是无界增长源——不排除的话大聊天历史
  // 用户一次 list_workdirs 会物化上千个单会话组(Codex review)。它们是内部
  // 实现细节而非用户项目目录, 对「按目录组织历史」没有检索意义。显式指定了
  // 真实目录的 dialogue 不在 managed root 下, 不受影响。模式带分隔符边界,
  // 相邻目录(如 <root>-project)不受误伤(见 managedDialogueRootLikePatterns)。
  for (const pattern of managedDialogueRootLikePatterns()) {
    baseConds.push(sql`${sessions.workingDir} NOT LIKE ${pattern} ESCAPE '!'`);
  }

  const rows = await db
    .select({
      workingDir: sessions.workingDir,
      sessionCount: cnt,
      firstSessionAt: firstTs,
      lastSessionAt: lastTs,
      agentKinds: kinds,
    })
    .from(sessions)
    .where(and(...baseConds))
    .groupBy(sessions.workingDir)
    .orderBy(orderFn(lastTs), orderFn(sessions.workingDir));

  const merged = new Map<string, WorkdirAggregate>();
  for (const r of rows) {
    const key = normalizeHistoryWorkingDir(r.workingDir) ?? (r.workingDir as string);
    const agentKinds = (r.agentKinds ?? '').split(',').filter((s) => s.length > 0);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        workingDir: key,
        sessionCount: Number(r.sessionCount),
        firstSessionAt: Number(r.firstSessionAt),
        lastSessionAt: Number(r.lastSessionAt),
        agentKinds,
      });
      continue;
    }
    existing.sessionCount += Number(r.sessionCount);
    existing.firstSessionAt = Math.min(existing.firstSessionAt, Number(r.firstSessionAt));
    existing.lastSessionAt = Math.max(existing.lastSessionAt, Number(r.lastSessionAt));
    existing.agentKinds = [...new Set([...existing.agentKinds, ...agentKinds])];
  }
  // tiebreak 必须与下方 afterCursor 的 `>` / `<` 用同一比较语义(JS 码元序,
  // 与旧 SQL 路径的 SQLite BINARY collation 对齐)。混用 localeCompare 会在
  // lastSessionAt 相同且目录跨页边界时漏项/重复(如 'a' vs 'B' 两种序相反)。
  const compareDir = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...merged.values()].sort((a, b) => {
    const byTime = params.order === 'asc'
      ? a.lastSessionAt - b.lastSessionAt
      : b.lastSessionAt - a.lastSessionAt;
    if (byTime !== 0) return byTime;
    return params.order === 'asc'
      ? compareDir(a.workingDir, b.workingDir)
      : compareDir(b.workingDir, a.workingDir);
  });
  const afterCursor = params.cursor
    ? ordered.filter((item) => params.order === 'asc'
      ? item.lastSessionAt > params.cursor!.createdAt ||
        (item.lastSessionAt === params.cursor!.createdAt && item.workingDir > params.cursor!.id)
      : item.lastSessionAt < params.cursor!.createdAt ||
        (item.lastSessionAt === params.cursor!.createdAt && item.workingDir < params.cursor!.id))
    : ordered;
  const hasMore = afterCursor.length > params.limit;
  const items = hasMore ? afterCursor.slice(0, params.limit) : afterCursor;
  const last = items[items.length - 1];
  const nextCursor: HistoryCursor | null = hasMore && last
    ? { createdAt: last.lastSessionAt, id: last.workingDir }
    : null;
  return { items, nextCursor, hasMore };
}

// ── list_sessions ───────────────────────────────────────────────────────────

export interface ListSessionsParams {
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  includeDeleted: boolean;
  limit: number;
  cursor: HistoryCursor | null; // (createdAt(ms), sessionId)
  order: HistoryOrder;
}

export interface SessionSummary {
  id: string;
  title: string;
  workingDir: string | null;
  agentKind: string;
  workspaceKind: string;
  model: string;
  status: string;
  source: string;
  orcaRole: string | null;
  parentSessionId: string | null;
  createdAt: number; // unix ms
  updatedAt: number;
  userSendAt: number | null;
  messageCount: number;
}

export async function listSessionsForHistory(
  params: ListSessionsParams,
): Promise<HistoryPage<SessionSummary>> {
  const db = getDbClient().drizzle;
  const orderFn = params.order === 'asc' ? asc : desc;

  const conds = [];
  if (!params.includeDeleted) conds.push(ne(sessions.status, 'deleted'));
  if (params.workdir !== null) {
    const candidates = await resolveStoredWorkingDirCandidates(params.workdir);
    if (candidates.length === 0) return { items: [], nextCursor: null, hasMore: false };
    conds.push(inArray(sessions.workingDir, candidates));
  }
  if (params.fromMs !== null) conds.push(gte(sessions.createdAt, params.fromMs));
  if (params.toMs !== null) conds.push(lt(sessions.createdAt, params.toMs));
  if (params.agentKind !== null) conds.push(eq(sessions.agentKind, params.agentKind));

  if (params.cursor) {
    const { createdAt: c, id } = params.cursor;
    if (params.order === 'desc') {
      conds.push(
        or(lt(sessions.createdAt, c), and(eq(sessions.createdAt, c), lt(sessions.id, id))),
      );
    } else {
      conds.push(
        or(
          sql`${sessions.createdAt} > ${c}`,
          and(eq(sessions.createdAt, c), sql`${sessions.id} > ${id}`),
        ),
      );
    }
  }

  const fetchLimit = params.limit + 1;

  // 不在 sessions 主查询里塞相关子查询 —— drizzle 的 sql template literal 在嵌入
  // 表对象 (`${messages}`) 时会当作 placeholder 处理, 子查询表达式拿不到表名,
  // 导致 COUNT 返回 NULL → 外层始终 0。改成两段查询: 先拿 sessions, 再用
  // inArray + groupBy 一次批量取 messageCount 合并。单 SELECT 多一次 IO,
  // 但 limit 上限 1000 下完全可接受, 且语义清晰。
  const sessionRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      agentKind: sessions.agentKind,
      workspaceKind: sessions.workspaceKind,
      model: sessions.model,
      status: sessions.status,
      source: sessions.source,
      orcaRole: sessions.orcaRole,
      parentSessionId: sessions.parentSessionId,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      userSendAt: sessions.userSendAt,
    })
    .from(sessions)
    .where(and(...conds))
    .orderBy(orderFn(sessions.createdAt), orderFn(sessions.id))
    .limit(fetchLimit);

  const hasMore = sessionRows.length > params.limit;
  const sliced = hasMore ? sessionRows.slice(0, params.limit) : sessionRows;

  // 批量查 messageCount (已过滤 rewindAt 软删)
  const countMap = new Map<string, number>();
  if (sliced.length > 0) {
    const ids = sliced.map((s) => s.id);
    const countRows = await db
      .select({
        sessionId: messages.sessionId,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(messages)
      .where(and(inArray(messages.sessionId, ids), isNull(messages.rewindAt)))
      .groupBy(messages.sessionId);
    for (const r of countRows) countMap.set(r.sessionId, Number(r.cnt));
  }

  const items: SessionSummary[] = sliced.map((r) => ({
    id: r.id,
    title: r.title,
    workingDir: r.workingDir,
    agentKind: r.agentKind,
    workspaceKind: r.workspaceKind,
    model: r.model,
    status: r.status,
    source: r.source,
    orcaRole: r.orcaRole,
    parentSessionId: r.parentSessionId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    userSendAt: r.userSendAt,
    messageCount: countMap.get(r.id) ?? 0,
  }));
  const last = items[items.length - 1];
  const nextCursor: HistoryCursor | null = hasMore && last
    ? { createdAt: last.createdAt, id: last.id }
    : null;
  return { items, nextCursor, hasMore };
}

// ── get_chat_history ────────────────────────────────────────────────────────

export type HistoryRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking';

export interface GetMessagesParams {
  sessionIds: string[] | null;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  roles: HistoryRole[] | null;
  includeRewound: boolean;
  limit: number;
  cursor: HistoryCursor | null; // (messages.createdAt(ms), messages.rowid); id remains for legacy cursors
  order: HistoryOrder;
}

export interface HistoryMessage {
  id: string;
  sessionId: string;
  sessionWorkingDir: string | null;
  sessionAgentKind: string;
  sessionTitle: string;
  role: string;
  content: unknown; // JSON.parse 后原样
  toolUseId: string | null;
  agentMeta: unknown; // JSON.parse 后原样 (可能 null)
  createdAt: number; // unix ms
  rewindAt: number | null;
}

/**
 * workdir / agentKind 这两个过滤本质是 sessions 表上的字段。直接挂在
 * messages JOIN sessions 的 WHERE 里, planner 在大库下会陷入两难:
 *   - 走 sessions 索引拿 sessionId 集合 → 全量取 messages 内存排序;
 *   - 走 messages.createdAt 索引反向扫 → 大量行被 workdir post-filter 丢掉。
 * 两条路都跟库总量线性。
 *
 * 改成两段: 先用 idx_sessions_workdir_created 把候选 sessionId 拿出来,
 * 再以 IN-list 喂 messages 查询走 idx_messages_session_created。
 * 命中 sessionId 数 > MAX_WORKDIR_SESSION_RESOLUTION 时退回 join 模式 ——
 * 此时 IN-list 自身会膨胀, 不优化反而让 planner 自决更合适。
 */
const MAX_WORKDIR_SESSION_RESOLUTION = 5000;

export async function getMessagesForHistory(
  params: GetMessagesParams,
): Promise<HistoryPage<HistoryMessage>> {
  const db = getDbClient().drizzle;
  const orderFn = params.order === 'asc' ? asc : desc;

  // ── 两段查询: 当存在 sessions 侧过滤(workdir / agentKind), 先预解析 sessionId 集合 ──
  let sessionIdsToFilter = params.sessionIds;
  let dropSessionTableConds = false;
  // workdir 候选解析一次, 预解析分支与下方降级 join 分支复用同一集合
  const workdirCandidates =
    params.workdir !== null ? await resolveStoredWorkingDirCandidates(params.workdir) : null;
  if (workdirCandidates !== null && workdirCandidates.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }
  if (params.workdir !== null || params.agentKind !== null) {
    const sessionConds = [];
    if (workdirCandidates !== null) {
      sessionConds.push(inArray(sessions.workingDir, workdirCandidates));
    }
    if (params.agentKind !== null) sessionConds.push(eq(sessions.agentKind, params.agentKind));
    if (sessionIdsToFilter !== null && sessionIdsToFilter.length > 0) {
      sessionConds.push(inArray(sessions.id, sessionIdsToFilter));
    }
    const sessionRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(...sessionConds))
      .limit(MAX_WORKDIR_SESSION_RESOLUTION + 1);
    if (sessionRows.length <= MAX_WORKDIR_SESSION_RESOLUTION) {
      const ids = sessionRows.map((r) => r.id);
      if (ids.length === 0) {
        // 无任何 session 命中 sessions 侧过滤 → 后续 messages 查询必为空
        return { items: [], nextCursor: null, hasMore: false };
      }
      sessionIdsToFilter = ids;
      dropSessionTableConds = true;
    }
    // else: 命中 session 过多, 降级到 join 模式 — 保持原 conds, 让 planner 自决
  }

  const conds = [];
  if (!params.includeRewound) conds.push(isNull(messages.rewindAt));
  if (sessionIdsToFilter !== null && sessionIdsToFilter.length > 0) {
    conds.push(inArray(messages.sessionId, sessionIdsToFilter));
  }
  if (!dropSessionTableConds) {
    if (workdirCandidates !== null) {
      conds.push(inArray(sessions.workingDir, workdirCandidates));
    }
    if (params.agentKind !== null) conds.push(eq(sessions.agentKind, params.agentKind));
  }
  if (params.fromMs !== null) conds.push(gte(messages.createdAt, params.fromMs));
  if (params.toMs !== null) conds.push(lt(messages.createdAt, params.toMs));
  if (params.roles !== null && params.roles.length > 0) {
    conds.push(inArray(messages.role, params.roles));
  }

  if (params.cursor) {
    const { createdAt: c, id, rowid } = params.cursor;
    const tieBreaker = rowid === undefined
      ? params.order === 'desc'
        ? lt(messages.id, id)
        : sql`${messages.id} > ${id}`
      : params.order === 'desc'
        ? lt(messageRowid, rowid)
        : gt(messageRowid, rowid);
    if (params.order === 'desc') {
      conds.push(
        or(
          lt(messages.createdAt, c),
          and(eq(messages.createdAt, c), tieBreaker),
        ),
      );
    } else {
      conds.push(
        or(
          sql`${messages.createdAt} > ${c}`,
          and(eq(messages.createdAt, c), tieBreaker),
        ),
      );
    }
  }

  const fetchLimit = params.limit + 1;

  const rows = await db
    .select({
      m: messages,
      rowid: messageRowid,
      sWorkingDir: sessions.workingDir,
      sAgentKind: sessions.agentKind,
      sTitle: sessions.title,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(and(...conds))
    .orderBy(orderFn(messages.createdAt), orderFn(!params.cursor || params.cursor.rowid !== undefined
      ? messageRowid
      : messages.id))
    .limit(fetchLimit);

  const hasMore = rows.length > params.limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const items: HistoryMessage[] = sliced.map((r) => {
    // 复用 messageToCamel 拿 content/agentMeta JSON 解析 + 错误兜底
    const camel = messageToCamel(r.m);
    return {
      id: camel.id,
      sessionId: camel.sessionId,
      sessionWorkingDir: r.sWorkingDir,
      sessionAgentKind: r.sAgentKind,
      sessionTitle: r.sTitle,
      role: camel.role,
      content: camel.content,
      toolUseId: camel.toolUseId,
      agentMeta: camel.agentMeta,
      createdAt: r.m.createdAt,
      rewindAt: r.m.rewindAt,
    };
  });
  const last = items[items.length - 1];
  const nextCursor: HistoryCursor | null = hasMore && last
    ? {
      createdAt: last.createdAt,
      id: last.id,
      ...(typeof sliced[sliced.length - 1]?.rowid === 'number'
        ? { rowid: sliced[sliced.length - 1].rowid }
        : {}),
    }
    : null;
  return { items, nextCursor, hasMore };
}
