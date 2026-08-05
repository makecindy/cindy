import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import type { SessionSource } from './sessionSource';

export type ConversationSearchAgentKind = 'cc' | 'codex' | 'pi';
export type ConversationSearchWorkspaceKind = 'project' | 'dialogue';
export type ConversationSearchSessionStatus = 'active' | 'archived' | 'deleted';
export type ConversationSearchOrcaRole = 'lead' | 'worker';
export type ConversationSearchMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking';

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  sortBy?: ConversationSearchSortBy;
  semanticMode?: ConversationSearchSemanticMode;
  filters?: ConversationSearchFilters;
  /**
   * @deprecated Use filters.status instead. Kept so older renderer builds keep
   * the previous active-only / active+archived behavior.
   */
  includeArchived?: boolean;
  /**
   * 「尚未起名」会话的显示文案(renderer 已解析的 i18n 值)。main 只拿它做标题匹配与
   * 命中下标 —— 结果里的 `session.title` 始终是原始存储值,投影只发生在渲染那一刻。
   * 不传则退回按原始哨兵匹配(旧 renderer 构建)。
   */
  unnamedLabel?: string;
}

export type ConversationSearchSortBy = 'relevance' | 'activityDesc' | 'activityAsc';
export type ConversationSearchSemanticMode = 'hybrid' | 'keyword';
export type ConversationSearchStatusFilter = 'active' | 'archived' | 'all';
export type ConversationSearchAgentFilter = 'all' | ConversationSearchAgentKind;
export type ConversationSearchLastActivityFilter = 'all' | '1d' | '3d' | '7d' | '30d';

export interface ConversationSearchFilters {
  status?: ConversationSearchStatusFilter;
  agentKind?: ConversationSearchAgentFilter;
  lastActivity?: ConversationSearchLastActivityFilter;
  /**
   * Optional pre-filtered session id set. The renderer uses this for project
   * filtering so search follows the exact same project grouping as the sidebar.
   */
  sessionIds?: string[] | null;
}

export type ConversationSearchMatchKind = 'title' | 'content' | 'both';

export interface ConversationSearchSessionSummary {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: ConversationSearchWorkspaceKind;
  agentKind: ConversationSearchAgentKind;
  status: ConversationSearchSessionStatus;
  source?: SessionSource;
  orcaRole?: ConversationSearchOrcaRole | null;
  parentSessionId?: string | null;
  userSendAt: string | null;
  updatedAt: string;
  createdAt: string;
  _count: { messages: number };
}

export interface ConversationSearchContentHit {
  messageId: string;
  messageClientId: string;
  role: ConversationSearchMessageRole;
  createdAt: string;
  snippet: string | null;
  preview: string;
  score: number;
  ftsRank: number | null;
  vectorRank: number | null;
}

export interface ConversationSearchResultItem {
  session: ConversationSearchSessionSummary;
  matchKind: ConversationSearchMatchKind;
  titleMatchIndices: number[];
  titleScore: number | null;
  /** Best content hit for backward-compatible single-click jump behavior. */
  contentHit: ConversationSearchContentHit | null;
  /** Multiple matching positions within the same conversation. */
  contentHits: ConversationSearchContentHit[];
  rankScore: number;
}

/**
 * 会话搜索里「参与匹配 / 被渲染」的标题串 —— **main 与 renderer 共用同一函数**。
 *
 * main 用它算 `titleMatchIndices`,renderer 用它渲染结果行;两端必须逐字得到同一个串,
 * 否则高亮下标会画到别的字上。共用一个纯函数就是这个保证本身(同 `normalizeAutoTitle`
 * 收敛掉两份复制实现的理由)。
 *
 * 注意投影只发生在「匹配 / 渲染」这一刻:`ConversationSearchSessionSummary.title` 仍是
 * 原始存储值,不把某次请求时的 locale 固化进返回数据。
 */
export function conversationSearchTitle(title: string, unnamedLabel?: string | null): string {
  return projectDraftSessionTitle(title, unnamedLabel);
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchResultItem[];
  vectorUsed: boolean;
  vectorSkipReason: string | null;
  poolCapped: boolean;
}
