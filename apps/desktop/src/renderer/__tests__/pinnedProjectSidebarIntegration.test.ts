/**
 * Project pinning must stay reachable and deduplicated across expanded, rail,
 * and date-grouped sidebar presentations.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');
const filterHookSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useSidebarFilter.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('pinned project sidebar integration', () => {
  it('keeps pinned projects out of expanded Projects but available in the collapsed rail', () => {
    expect(sidebarSource).toContain('const visibleRailProjectsWithVendor = useMemo(() => {');
    expect(sidebarSource).toContain(
      '<RailPanels\n        projects={visibleRailProjectsWithVendor}',
    );
    expect(sidebarSource).toContain(
      '<ProjectsSection\n              unclassified={visibleUnclassified}\n              projects={visibleProjectsWithVendor}',
    );
  });

  it('keeps all-pinned projects available while omitting their pinned child rows', () => {
    expect(sidebarSource).toContain(
      'const groupsWithPinnedProjects = useProjectGroups(',
    );
    expect(sidebarSource).toContain(
      'if (filter.projectsAsSet === null) return groupsWithPinnedProjects.projects;',
    );
    expect(sidebarSource).toContain(
      'sessions: matchingSessions.filter((session) => session.pinnedAt == null)',
    );
  });

  it('exposes project pin toggling from the collapsed rail project menu', () => {
    expect(sidebarSource).toContain('pinnedProjectKeys={pinnedProjectKeys}');
    expect(sidebarSource).toContain('onToggleProjectPin={handleToggleProjectPin}');
    expect(sidebarSource).toContain('pinnedProjectKeys.has(menuTarget.projectKey)');
  });

  it('applies main-process pinned-order broadcasts to every mounted sidebar hook', () => {
    expect(filterHookSource).toContain(
      'window.electronAPI.sidebarSettingsOnPinnedOrderChanged((next) => {',
    );
    expect(filterHookSource).toContain('setManualPinnedOrderState((prev) =>');
  });

  it('omits sessions belonging to pinned projects from date groups', () => {
    const dateStart = sidebarSource.indexOf('const visibleDateSessions = useMemo(() => {');
    const dateEnd = sidebarSource.indexOf('const [selectedSessionIds', dateStart);
    const dateBlock = sidebarSource.slice(dateStart, dateEnd);

    expect(dateStart).toBeGreaterThanOrEqual(0);
    expect(dateEnd).toBeGreaterThan(dateStart);
    expect(dateBlock).toContain('pinnedProjectKeys.has(pinnedProjectKey)');
    expect(dateBlock).toContain(
      '[activityFilteredSessions, vendorPredicate, filter.projectsAsSet, pinnedProjectKeys]',
    );
  });
});
