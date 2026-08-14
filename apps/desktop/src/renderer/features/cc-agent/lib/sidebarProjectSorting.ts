import type { Session } from '@/lib/ccAgent.types';

import type { FilterSortBy } from '../hooks/helpers/sidebarFilterCore';
import { normalizeManualProjectOrder } from '../hooks/helpers/sidebarFilterCore';
import { sessionActivityMs } from './dateSessionGrouping';
import type { ProjectNode } from './projectGrouping';
import { projectKeyComparisonKey } from './projectGrouping';

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function sortSessionsForSidebar(
  sessions: readonly Session[],
  sortBy: FilterSortBy,
): Session[] {
  if (sortBy === 'time') {
    return sessions.slice().sort((a, b) => sessionActivityMs(a) - sessionActivityMs(b));
  }
  return sessions.slice();
}

export function sortProjectsForSidebar(
  projects: readonly ProjectNode[],
  sortBy: FilterSortBy,
  manualProjectOrder: readonly string[],
  localPlatform: string = '',
): ProjectNode[] {
  const withSortedSessions = projects.map((project) => ({
    ...project,
    sessions: sortSessionsForSidebar(project.sessions, sortBy),
  }));

  if (sortBy === 'time') {
    return withSortedSessions.sort((a, b) => toMs(a.latestActivityAt) - toMs(b.latestActivityAt));
  }
  if (sortBy === 'alphabetic') {
    return withSortedSessions.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    );
  }
  if (sortBy === 'manual') {
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

  return withSortedSessions;
}
