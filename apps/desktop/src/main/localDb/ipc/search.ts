import { ipcMain } from 'electron';

import { searchConversations } from '../conversationSearch.js';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchFilters,
  ConversationSearchLastActivityFilter,
  ConversationSearchSemanticMode,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '../../../shared/conversationSearch.js';
import { optionalEnum, requireObject, throwIpcError } from '../../utils/ipcValidate.js';

const SORT_VALUES = ['relevance', 'activityDesc', 'activityAsc'] as const;
const SEMANTIC_MODE_VALUES = ['hybrid', 'keyword'] as const;
const STATUS_VALUES = ['active', 'archived', 'all'] as const;
const AGENT_VALUES = ['all', 'cc', 'codex', 'pi'] as const;
const LAST_ACTIVITY_VALUES = ['all', '1d', '3d', '7d', '30d'] as const;

export function registerSearchIpc(): void {
  ipcMain.handle('local-db:conversations:search', async (_e, payload: unknown) => {
    const body = requireObject(payload, 'payload');
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      throwIpcError('INVALID_PARAMS', 'query is required');
    }
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const includeArchived = typeof body.includeArchived === 'boolean'
      ? body.includeArchived
      : undefined;
    const sortBy = optionalEnum(body.sortBy, SORT_VALUES, 'sortBy') as
      | ConversationSearchSortBy
      | undefined;
    const semanticMode = optionalEnum(body.semanticMode, SEMANTIC_MODE_VALUES, 'semanticMode') as
      | ConversationSearchSemanticMode
      | undefined;
    const filters = parseFilters(body.filters);
    const unnamedLabel = parseUnnamedLabel(body.unnamedLabel);
    return searchConversations({
      query,
      limit,
      includeArchived,
      sortBy,
      semanticMode,
      filters,
      unnamedLabel,
    });
  });
}

/** i18n 文案不可能有这么长;超限说明调用方拼错了,宁可报错也不静默截断(见下)。 */
const UNNAMED_LABEL_MAX_LENGTH = 120;

/**
 * 「尚未起名」会话的显示文案(renderer 已解析的 i18n 值)。
 *
 * 必须原样转发,不能截断也不能替换:main 用它算标题匹配与 `titleMatchIndices`、
 * renderer 用同一个串渲染结果行,两端逐字一致才能保证高亮下标对齐。这里一旦悄悄改动
 * 或漏传,表现就是「搜界面上看得见的文案搜不到、搜内部哨兵反而命中」——
 * 本轮 review 抓到的正是漏传(PR #1031)。
 */
function parseUnnamedLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', 'unnamedLabel must be a string');
  }
  if (!value.trim()) return undefined;
  if (value.length > UNNAMED_LABEL_MAX_LENGTH) {
    throwIpcError(
      'INVALID_PARAMS',
      `unnamedLabel must be at most ${UNNAMED_LABEL_MAX_LENGTH} characters`,
    );
  }
  // 刻意**不 trim**:renderer 渲染时用的是 t() 的原串,这里改一个字符就会让两端的
  // 命中下标错位。只用 trim 判空,转发的仍是原值。
  return value;
}

function parseFilters(value: unknown): ConversationSearchFilters | undefined {
  if (value === undefined || value === null) return undefined;
  const body = requireObject(value, 'filters');
  const filters: ConversationSearchFilters = {};
  const status = optionalEnum(body.status, STATUS_VALUES, 'filters.status') as
    | ConversationSearchStatusFilter
    | undefined;
  const agentKind = optionalEnum(body.agentKind, AGENT_VALUES, 'filters.agentKind') as
    | ConversationSearchAgentFilter
    | undefined;
  const lastActivity = optionalEnum(body.lastActivity, LAST_ACTIVITY_VALUES, 'filters.lastActivity') as
    | ConversationSearchLastActivityFilter
    | undefined;

  if (status) filters.status = status;
  if (agentKind) filters.agentKind = agentKind;
  if (lastActivity) filters.lastActivity = lastActivity;
  if (body.sessionIds !== undefined && body.sessionIds !== null) {
    if (!Array.isArray(body.sessionIds)) {
      throwIpcError('INVALID_PARAMS', 'filters.sessionIds must be an array');
    }
    filters.sessionIds = body.sessionIds.map((id, index) => {
      if (typeof id !== 'string' || id.trim() === '') {
        throwIpcError('INVALID_PARAMS', `filters.sessionIds[${index}] must be a non-empty string`);
      }
      return id.trim();
    });
  }
  if (body.workingDirs !== undefined && body.workingDirs !== null) {
    if (!Array.isArray(body.workingDirs)) {
      throwIpcError('INVALID_PARAMS', 'filters.workingDirs must be an array');
    }
    filters.workingDirs = body.workingDirs.map((dir, index) => {
      if (typeof dir !== 'string' || dir.trim() === '') {
        throwIpcError('INVALID_PARAMS', `filters.workingDirs[${index}] must be a non-empty string`);
      }
      return dir;
    });
  }
  return filters;
}
