/**
 * xdt-helper/_history_types.ts —— history 类工具的 host-injected deps 类型契约。
 *
 * 与 apps/desktop/src/main/localDb/chatHistoryReader.ts 的返回值形态 1:1 对齐;
 * @cindy/mcps 不能反向 import desktop, 所以在这里独立定义 (host 注入时把 reader
 * 结果适配到这层类型即可)。
 */

import type { ControlResult } from '../types.js';

export type HistoryAgentKind = 'cc' | 'codex';
export type HistoryOrder = 'asc' | 'desc';

/** Stable business errors exposed by cross-device history readers. */
export type HistoryReadErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'REMOTE_UNSUPPORTED_QUERY'
  | 'REMOTE_DEVICE_OFFLINE'
  | 'REMOTE_LINK_REQUIRED'
  | 'DEVICE_LINK_NOT_READY'
  | 'REMOTE_DISABLED'
  | 'REMOTE_ACCESS_REVOKED'
  | 'REMOTE_UNSUPPORTED'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_PAYLOAD_TOO_LARGE';

export type HistoryRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking';

export interface HistoryCursor {
  /** unix ms */
  createdAt: number;
  id: string;
  /** SQLite insertion-order tie-breaker for message history cursors. */
  rowid?: number;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor: HistoryCursor | null;
  hasMore: boolean;
}

export interface HistoryWorkdir {
  workingDir: string;
  sessionCount: number;
  firstSessionAt: number; // unix ms
  lastSessionAt: number; // unix ms
  agentKinds: string[];
}

export interface HistorySession {
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

export interface HistoryMessage {
  id: string;
  sessionId: string;
  sessionWorkingDir: string | null;
  sessionAgentKind: string;
  sessionTitle: string;
  role: string;
  content: unknown;
  toolUseId: string | null;
  agentMeta: unknown;
  createdAt: number; // unix ms
  rewindAt: number | null;
}

// ── Reader 调用参数 (host 端把 tool 解析后的参数透传给 reader) ───────────────

export interface ListWorkdirsArgs {
  limit: number;
  cursor: HistoryCursor | null;
  order: HistoryOrder;
}

export interface ListSessionsArgs {
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  includeDeleted: boolean;
  limit: number;
  cursor: HistoryCursor | null;
  order: HistoryOrder;
}

export interface GetMessagesArgs {
  sessionIds: string[] | null;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  roles: HistoryRole[] | null;
  /** Whether roles were filled from get_chat_history's default role set. */
  rolesDefaulted?: boolean;
  includeRewound: boolean;
  limit: number;
  cursor: HistoryCursor | null;
  order: HistoryOrder;
}

// ── search_chat_history (混合检索: FTS5 + 向量 RRF 融合) ─────────────────────
//
// 与 GetMessagesArgs 的关系: GetMessages 是"按元数据精确捞", SearchChatHistory 是
// "按内容语义找"。后者输入多一个 query(自然语言)+ contextRadius(上下文窗口半径),
// 结构化过滤维度对齐 GetMessages。host 侧引擎做 FTS arm + vector arm + RRF 融合 +
// 上下文窗口拼装; 向量不可用 / 未开 embedding 时静默退化为纯 FTS。

export interface SearchChatHistoryArgs {
  /** 自然语言查询(必填)。 */
  query: string;
  sessionIds: string[] | null;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  /** 命中消息的 role 过滤(缺省 = 问答四类); 也用于上下文窗口的 role 过滤。 */
  roles: HistoryRole[] | null;
  /** 每条命中前后各取多少条同 session 邻居(0 = 不带上下文)。 */
  contextRadius: number;
  /** 融合后返回的命中条数。 */
  limit: number;
  /** 物化候选池内的偏移(由 cursor 解码而来); 0 = 第一页。 */
  offset: number;
}

/** 命中消息周边的一条上下文消息(含命中本身)。createdAt 为 unix ms, 由 tool 层转 ISO。 */
export interface SearchChatHistoryContextMessage {
  id: string;
  sessionId: string;
  role: string;
  content: unknown; // JSON.parse 后原样
  toolUseId: string | null;
  agentMeta: unknown; // JSON.parse 后原样(可能 null)
  createdAt: number; // unix ms
  rewindAt: number | null;
  /** 是否是命中本身(用于区分命中行与上下文行)。 */
  isHit: boolean;
}

export interface SearchChatHistoryHit {
  messageId: string;
  sessionId: string;
  role: string;
  createdAt: number; // unix ms
  /** FTS 命中时的高亮 snippet; 纯向量命中(FTS 未召回)时为 null。 */
  snippet: string | null;
  /** RRF 融合分(越大越相关)。 */
  score: number;
  /** 该命中在 FTS arm 的 1-based 排名; 未被 FTS 召回则 null。 */
  ftsRank: number | null;
  /** 该命中在向量 arm 的 1-based 排名; 未被向量召回则 null。 */
  vectorRank: number | null;
  /** 向量 arm 的余弦/L2 距离(越小越近); 未被向量召回则 null。 */
  vectorDistance: number | null;
  /** 上下文窗口(含命中本身), 按 createdAt asc。 */
  context: SearchChatHistoryContextMessage[];
}

export interface SearchChatHistorySessionMeta {
  workingDir: string | null;
  agentKind: string;
  title: string;
}

export interface SearchChatHistoryResult {
  hits: SearchChatHistoryHit[];
  /** 涉及到的 session 元数据(按 id 索引一次, 避免逐条命中重复)。 */
  sessions: Record<string, SearchChatHistorySessionMeta>;
  /** 本次是否真正用上了向量 arm。 */
  vectorUsed: boolean;
  /** 向量 arm 被跳过的原因(vectorUsed=false 时给出, 满足无静默降级)。 */
  vectorSkipReason: string | null;
  /** 下一页在候选池内的 offset; null = 无下一页。tool 层 encode 成 cursor。 */
  nextOffset: number | null;
  hasMore: boolean;
  /** 实际融合候选池大小。 */
  poolSize: number;
  /** 候选池是否触达硬上限被截断(true 时提示可能有更靠后的相关结果未进池)。 */
  poolCapped: boolean;
}

// ── Deps interface ─────────────────────────────────────────────────────────

export interface XdtHelperHistoryDeps {
  listWorkdirs: (args: ListWorkdirsArgs) => Promise<ControlResult<{ page: HistoryPage<HistoryWorkdir> }>>;
  listSessions: (args: ListSessionsArgs) => Promise<ControlResult<{ page: HistoryPage<HistorySession> }>>;
  getMessages: (
    args: GetMessagesArgs,
  ) => Promise<ControlResult<{ page: HistoryPage<HistoryMessage> }, HistoryReadErrorCode>>;
  searchChatHistory: (
    args: SearchChatHistoryArgs,
  ) => Promise<ControlResult<{ result: SearchChatHistoryResult }>>;
}
