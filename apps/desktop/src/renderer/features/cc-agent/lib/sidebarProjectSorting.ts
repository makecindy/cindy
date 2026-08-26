import type { Session } from '@/lib/ccAgent.types';

import type { FilterProjectOrder, FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionActivityMs } from './dateSessionGrouping';
import type { ProjectNode } from './projectGrouping';

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 会话排序。旧 'time'(最早优先)2026-08-12 用户裁决删除,时间排序只保留最近活动
 * 在前一档(recency,由调用方的既有顺序承载),这里对所有档位都保持入参序。
 */
export function sortSessionsForSidebar(
  sessions: readonly Session[],
  _sortBy: FilterSortBy,
): Session[] {
  return sessions.slice();
}

export function sortProjectsForSidebar(
  projects: readonly ProjectNode[],
  sortBy: FilterSortBy,
  manualProjectOrder: readonly string[],
  projectOrder: FilterProjectOrder = 'activity',
): ProjectNode[] {
  const withSortedSessions = projects.map((project) => ({
    ...project,
    sessions: sortSessionsForSidebar(project.sessions, sortBy),
  }));

  if (projectOrder === 'custom') {
    const normalizedOrder = normalizeManualProjectOrder(
      manualProjectOrder,
      projects.map((project) => project.projectKey),
    );
    const rank = new Map(normalizedOrder.map((wd, index) => [wd, index]));
    return withSortedSessions.sort(
      (a, b) =>
        (rank.get(a.projectKey) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.projectKey) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  return withSortedSessions;
}
