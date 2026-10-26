import type { Session } from '@/lib/ccAgent.types';

import type { FilterProjectOrder, FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import {
  compareSessionGroupsByPriority,
  sortSessionsForMainList,
  type MainListPriorityContext,
} from './mainListModel';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionCreatedMs } from './dateSessionGrouping';
import { projectKeyComparisonKey, type ProjectNode } from './projectGrouping';

/**
 * 有状态上下文的项目面板沿用主列表优先级；其它调用保留既有顺序。
 */
export function sortSessionsForSidebar(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
  priorityContext?: MainListPriorityContext,
): Session[] {
  if (sortBy === 'priority' && priorityContext) {
    return sortSessionsForMainList(sessions, sortBy, priorityContext);
  }
  return sortBy === 'created'
    ? sessions
        .slice()
        .sort((a, b) => sessionCreatedMs(b) - sessionCreatedMs(a) || a.id.localeCompare(b.id))
    : sessions.slice();
}

export function sortProjectsForSidebar(
  projects: readonly ProjectNode[],
  sortBy: FilterSortBy,
  manualProjectOrder: readonly string[],
  projectOrder: FilterProjectOrder = 'activity',
  localPlatform: string = '',
  priorityContext?: MainListPriorityContext,
): ProjectNode[] {
  const withSortedSessions = projects.map((project) => ({
    ...project,
    sessions: sortSessionsForSidebar(project.sessions, sortBy, priorityContext),
  }));

  if (projectOrder === 'custom') {
    const normalizedOrder = normalizeManualProjectOrder(
      manualProjectOrder,
      projects.map((project) => project.projectKey),
      localPlatform,
    );
    const rank = new Map(
      normalizedOrder.map((key, index) => [
        projectKeyComparisonKey(key, localPlatform) ?? key,
        index,
      ]),
    );
    return withSortedSessions.sort(
      (a, b) =>
        (rank.get(projectKeyComparisonKey(a.projectKey, localPlatform) ?? a.projectKey) ??
          Number.MAX_SAFE_INTEGER) -
        (rank.get(projectKeyComparisonKey(b.projectKey, localPlatform) ?? b.projectKey) ??
          Number.MAX_SAFE_INTEGER),
    );
  }

  if (sortBy === 'created') {
    return withSortedSessions.sort(
      (a, b) =>
        Math.max(0, ...b.sessions.map(sessionCreatedMs)) -
          Math.max(0, ...a.sessions.map(sessionCreatedMs)) ||
        (a.sessions[0]?.id ?? '').localeCompare(b.sessions[0]?.id ?? ''),
    );
  }

  if (sortBy === 'priority' && priorityContext) {
    return withSortedSessions.sort((a, b) =>
      compareSessionGroupsByPriority(a.sessions, b.sessions, priorityContext),
    );
  }

  return withSortedSessions;
}
