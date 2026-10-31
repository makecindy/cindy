/**
 * Project pinning must stay reachable and deduplicated across expanded, rail,
 * and date-grouped sidebar presentations.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { includeProjectInFilter } from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';
import type { PersistentLocalProject } from '@/features/cc-agent/lib/projectGrouping';
import {
  collectRestorableProjectKeys,
  restoreHiddenProjectIfPresent,
} from '@/features/cc-agent/lib/sidebarProjectRestore';

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
      /<ProjectsSection\s+unclassified=\{mainUnclassified\}\s+projects=\{visibleProjectsWithVendor\}/,
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
    expect(filterHookSource).toContain('window.electronAPI.sidebarSettings.onPinnedOrderChanged(');
    expect(filterHookSource).toContain('isExactOwnerStampCurrent(nextOwnerStamp, ownerStamp)');
    expect(filterHookSource).toContain('isDataOwnerPushStampCurrent(actual)');
    expect(filterHookSource).toContain('durablePinnedOrderRef.current = snapshot;');
  });

  // (侧边栏重设计 D 期:按日期分组已删除,visibleDateSessions 的置顶项目剔除
  //  断言随之下线;置顶项目剔除现由 visibleProjectsWithVendor 的
  //  pinnedProjectKeys 过滤承担,上方断言已覆盖。)

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

  // #7469, unit: the old source-string assertion required eager useMemo and
  // failed after lazy collection, without testing restore/filter outcomes.
  // An empty catalogue gains one project while IPC is pending; exercise the
  // real collector, restore transaction and filter reducer together.
  it('restores against the latest project catalogue and re-admits the active filter', async () => {
    const projectKey = 'local:/workspace/restored';
    let catalogue: PersistentLocalProject[] = [];
    let filter: Parameters<typeof includeProjectInFilter>[0] = ['local:/workspace/old'];
    let finishUpdate!: (changed: boolean) => void;
    const update = new Promise<boolean>((resolve) => { finishUpdate = resolve; });
    const setProjectHidden = vi.fn(() => update);
    const getCurrentProjectKeys = vi.fn(() => collectRestorableProjectKeys({
      sessions: [], persistentLocalProjects: catalogue, lastActivityCutoff: null,
      pinnedProjectKeys: new Set(), vendorPredicate: null, localPlatform: 'linux',
    }));
    const restore = () => restoreHiddenProjectIfPresent({
      projectKey, wasHiddenAtPickerOpen: true, setProjectHidden, getCurrentProjectKeys,
      ensureProjectIncluded: (key) => { filter = includeProjectInFilter(filter, key, 'linux'); },
      localPlatform: 'linux',
    });
    const pending = restore();
    expect(setProjectHidden).toHaveBeenCalledWith(projectKey, false);
    expect(getCurrentProjectKeys).not.toHaveBeenCalled();
    expect(filter).toEqual(['local:/workspace/old']);

    catalogue = [{ workingDir: '/workspace/restored', lastUsedAt: '2026-01-01T00:00:00Z', knownAgentKinds: [] }];
    filter = ['local:/workspace/concurrent'];
    finishUpdate(true);

    await expect(pending).resolves.toBe(true);
    expect(getCurrentProjectKeys).toHaveBeenCalledOnce();
    expect(filter).toEqual(['local:/workspace/concurrent', projectKey]);
    await expect(restore()).resolves.toBe(true);
    expect(filter).toEqual(['local:/workspace/concurrent', projectKey]);
  });

  it('prunes hidden projects from filters in every renderer hook', () => {
    expect(filterHookSource).toContain('const next = removeProjectsFromFilter(');
    expect(filterHookSource).toContain(
      'removeProjectsFromFilter(prev, hiddenProjectKeys, window.electronAPI.platform)',
    );
  });
});
