import type { Session } from '@/lib/ccAgent.types';

import type { FilterProjectOrder, FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionCreatedMs } from './dateSessionGrouping';
import type { ProjectNode } from './projectGrouping';

/**
 * 创建时间排序独立于活动变化;其它档位保留调用方已排好的顺序。
 */
export function sortSessionsForSidebar(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
): Session[] {
  return sortBy === 'created'
    ? sessions.slice().sort((a, b) =>
        sessionCreatedMs(b) - sessionCreatedMs(a) || a.id.localeCompare(b.id),
      )
    : sessions.slice();
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

  if (sortBy === 'created') {
    return withSortedSessions.sort((a, b) =>
      Math.max(0, ...b.sessions.map(sessionCreatedMs)) -
        Math.max(0, ...a.sessions.map(sessionCreatedMs)) ||
      (a.sessions[0]?.id ?? '').localeCompare(b.sessions[0]?.id ?? ''),
    );
  }

  return withSortedSessions;
}
