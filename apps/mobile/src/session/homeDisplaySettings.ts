import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import type { MobileHomePresentation } from './mobileHome';
import type { RemoteSessionListItem } from './sessionList';
import { activityMsFromIso } from './homeListPriority';
import { formatRemoteMoney, resolveSessionTotalMoney } from './remoteMoney';
import { sessionWorktreeInfo } from './sessionWorktree';

/**
 * 首页「显示」菜单里与桌面侧栏对齐的设置(筛选 / 显示 / 任务信息)。
 * 语义逐项照搬桌面 SidebarFilterPopover:
 *   - 筛选只含项目 / Harness / 最近活跃,不动任务状态;
 *   - 显示 = 文字(单行)/ 列表(带预览行);
 *   - 任务信息复选,行内渲染顺序 = 勾选先后。
 */
export type HomeVendorFilter = 'all' | 'cc' | 'codex' | 'pi';
export type HomeLastActivityFilter = '1d' | '3d' | '7d' | '30d' | 'all';
/** 'all' = 不筛选;数组 = 只看这些项目(含对话占位键)。 */
export type HomeProjectFilter = 'all' | readonly string[];
export type HomeListViewMode = 'text' | 'list';
export type HomeTaskInfoField = 'time' | 'pr' | 'worktree' | 'tokens' | 'cost';

/** 项目筛选里「对话」的占位键;与真实项目 key 不会撞(项目 key 带设备 / 路径前缀)。 */
export const HOME_DIALOGUE_FILTER_KEY = 'dialogue';

export const HOME_VENDOR_FILTERS: readonly HomeVendorFilter[] = ['all', 'cc', 'codex', 'pi'];
export const HOME_LAST_ACTIVITY_FILTERS: readonly HomeLastActivityFilter[] = ['1d', '3d', '7d', '30d', 'all'];
/** 本表顺序 = 菜单里复选项的排列顺序(固定),与桌面一致。 */
export const HOME_TASK_INFO_FIELDS: readonly HomeTaskInfoField[] = ['time', 'pr', 'worktree', 'tokens', 'cost'];
export const DEFAULT_HOME_TASK_INFO_FIELDS: readonly HomeTaskInfoField[] = ['time'];

const LAST_ACTIVITY_DAYS: Record<Exclude<HomeLastActivityFilter, 'all'>, number> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HomeContentFilters {
  projects: HomeProjectFilter;
  vendor: HomeVendorFilter;
  lastActivity: HomeLastActivityFilter;
}

export function normalizeVendorFilter(value: unknown): HomeVendorFilter {
  return HOME_VENDOR_FILTERS.includes(value as HomeVendorFilter) ? value as HomeVendorFilter : 'all';
}

export function normalizeLastActivityFilter(value: unknown): HomeLastActivityFilter {
  return HOME_LAST_ACTIVITY_FILTERS.includes(value as HomeLastActivityFilter)
    ? value as HomeLastActivityFilter
    : 'all';
}

export function normalizeProjectFilter(value: unknown): HomeProjectFilter {
  if (!Array.isArray(value)) return 'all';
  const keys = uniqueStrings(value);
  return keys.length > 0 ? keys : 'all';
}

export function normalizeViewMode(value: unknown): HomeListViewMode {
  return value === 'text' ? 'text' : 'list';
}

/** 缺省(从未设置)给默认;显式存过空数组 = 用户全不选,保留。 */
export function normalizeTaskInfoFields(value: unknown): HomeTaskInfoField[] {
  if (!Array.isArray(value)) return [...DEFAULT_HOME_TASK_INFO_FIELDS];
  return uniqueStrings(value).filter((field): field is HomeTaskInfoField =>
    HOME_TASK_INFO_FIELDS.includes(field as HomeTaskInfoField));
}

/** 勾选追加到末尾、取消原位删除:数组顺序即行内渲染顺序。 */
export function toggleTaskInfoField(
  prev: readonly HomeTaskInfoField[],
  field: HomeTaskInfoField,
): HomeTaskInfoField[] {
  return prev.includes(field) ? prev.filter((item) => item !== field) : [...prev, field];
}

/** 与桌面 nextProjectsAfterToggle 同语义:从「全部」点一项 = 只看这一项;取消最后一项回到「全部」。 */
export function toggleProjectFilter(prev: HomeProjectFilter, key: string): HomeProjectFilter {
  if (prev === 'all') return [key];
  if (prev.includes(key)) {
    const next = prev.filter((item) => item !== key);
    return next.length > 0 ? next : 'all';
  }
  return [...prev, key];
}

export function projectFilterIncludes(filter: HomeProjectFilter, key: string): boolean {
  return filter === 'all' || filter.includes(key);
}

export function activeContentFilterCount(filters: HomeContentFilters): number {
  return (filters.projects !== 'all' ? 1 : 0)
    + (filters.vendor !== 'all' ? 1 : 0)
    + (filters.lastActivity !== 'all' ? 1 : 0);
}

/**
 * 按筛选收窄首页展示模型。Harness 与最近活跃作用于全部任务(含置顶,与桌面一致);
 * 项目筛选只作用于项目组与对话,置顶是用户显式钉住的,不被项目筛选藏掉。
 * 筛完为空的项目组整组隐藏。
 */
export function applyHomeContentFilters(
  home: MobileHomePresentation,
  filters: HomeContentFilters,
  nowMs: number,
): MobileHomePresentation {
  if (activeContentFilterCount(filters) === 0) return home;
  const cutoff = filters.lastActivity === 'all'
    ? null
    : nowMs - LAST_ACTIVITY_DAYS[filters.lastActivity] * DAY_MS;
  const keep = (item: RemoteSessionListItem): boolean => {
    if (filters.vendor !== 'all' && sessionVendor(item) !== filters.vendor) return false;
    if (cutoff !== null && activityMsFromIso(item.lastActivityAt) < cutoff) return false;
    return true;
  };
  const projects = home.projects.flatMap((project) => {
    if (!projectFilterIncludes(filters.projects, project.key)) return [];
    const sessions = project.sessions.filter(keep);
    if (sessions.length === 0) return [];
    return [sessions.length === project.sessions.length
      ? project
      : { ...project, sessionCount: sessions.length, sessions }];
  });
  return {
    ...home,
    chats: projectFilterIncludes(filters.projects, HOME_DIALOGUE_FILTER_KEY) ? home.chats.filter(keep) : [],
    pinned: home.pinned.filter(keep),
    projects,
  };
}

function sessionVendor(item: RemoteSessionListItem): HomeVendorFilter {
  const kind = (item.session as { agentKind?: unknown }).agentKind;
  return kind === 'codex' || kind === 'pi' ? kind : 'cc';
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

export type HomeSessionInfoPiece =
  | { key: 'time' }
  | { key: 'pr' }
  | { key: 'worktree'; name: string; path: string }
  | { key: 'tokens' | 'cost'; text: string };

/**
 * 按勾选顺序拼出任务行右侧的信息片段;无数据的项(Token 为 0、无费用、无 worktree)
 * 不占位。'pr' 只是占位,PR 号与状态由行内单独查询后替换,查不到时调用方跳过。
 */
export function buildHomeSessionInfoPieces(
  session: {
    totalTokenUsage?: unknown;
    totalMoney?: unknown;
    totalCostUsd?: unknown;
    worktreePath?: string | null;
  },
  fields: readonly HomeTaskInfoField[],
): HomeSessionInfoPiece[] {
  const pieces: HomeSessionInfoPiece[] = [];
  for (const field of fields) {
    if (field === 'time' || field === 'pr') {
      pieces.push({ key: field });
    } else if (field === 'tokens') {
      const tokens = session.totalTokenUsage;
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        pieces.push({ key: 'tokens', text: formatCompactTokens(tokens) });
      }
    } else if (field === 'cost') {
      const money = resolveSessionTotalMoney(session);
      if (money) pieces.push({ key: 'cost', text: formatRemoteMoney(money) });
    } else {
      const worktree = sessionWorktreeInfo(session);
      if (worktree) pieces.push({ key: 'worktree', name: worktree.name, path: worktree.path });
    }
  }
  return pieces;
}
