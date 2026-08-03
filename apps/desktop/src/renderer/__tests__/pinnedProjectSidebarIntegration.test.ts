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
    expect(sidebarSource).toMatch(
      /<ProjectsSection\s+unclassified=\{visibleUnclassified\}\s+projects=\{visibleProjectsWithVendor\}/,
    );
  });

  it('keeps all-pinned projects available while omitting their pinned child rows', () => {
    expect(sidebarSource).toContain('const groupsWithPinnedProjects = useProjectGroups(');
    expect(sidebarSource).toContain('const notHidden = visibleSidebarProjects(');
    expect(sidebarSource).toContain('if (filter.projectsAsSet === null) return notHidden;');
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

  it('confirms before removing a project and keeps the rail open when cancelled', () => {
    const removeStart = sidebarSource.indexOf(
      'const handleRemoveProjectFromSidebar = useCallback(',
    );
    const removeEnd = sidebarSource.indexOf('/* ---- Pin / Unpin handler ---- */', removeStart);
    const removeBlock = sidebarSource.slice(removeStart, removeEnd);
    const railRemoveStart = sidebarSource.indexOf('onRemoveProjectFromSidebar(menuTarget);');
    const railRemoveBlock = sidebarSource.slice(railRemoveStart - 120, railRemoveStart + 80);

    expect(removeStart).toBeGreaterThanOrEqual(0);
    expect(removeEnd).toBeGreaterThan(removeStart);
    expect(railRemoveStart).toBeGreaterThanOrEqual(0);
    expect(removeBlock).toContain('const confirmed = await confirmDialog({');
    expect(removeBlock).toContain('if (!confirmed) return;');
    expect(removeBlock.indexOf('if (!confirmed) return;')).toBeLessThan(
      removeBlock.indexOf('await setProjectHidden(project.projectKey, true);'),
    );
    expect(removeBlock).not.toContain('filter.toggleProject(project.projectKey);');
    expect(removeBlock.indexOf('await setProjectHidden(project.projectKey, true);')).toBeLessThan(
      removeBlock.indexOf('railPanelStore.closeAll();'),
    );
    expect(railRemoveBlock).not.toContain('railPanelStore.closeAll();');
  });

  it('restores against the latest project catalogue and re-admits the active filter', () => {
    expect(sidebarSource).toContain('const filter = useSidebarFilter(hiddenProjectKeys);');
    expect(sidebarSource).toContain('collectRestorableProjectKeys({');
    expect(sidebarSource).toContain('sessions: scopedSidebarSessions,');
    expect(sidebarSource).toContain('const restored = await restoreHiddenProjectIfPresent({');
    expect(sidebarSource).toContain(
      'getCurrentProjectKeys: () => restorableProjectKeysRef.current,',
    );
    expect(sidebarSource).toContain('ensureProjectIncluded: filter.ensureProjectIncluded,');
    expect(sidebarSource).toContain('localPlatform,');
    expect(sidebarSource).toContain('if (restored) return;');
  });

  it('prunes hidden projects from filters in every renderer hook', () => {
    expect(filterHookSource).toContain('const next = removeProjectsFromFilter(');
    expect(filterHookSource).toContain('window.electronAPI.platform,');
  });
});
