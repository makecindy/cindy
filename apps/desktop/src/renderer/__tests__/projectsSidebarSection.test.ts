/**
 * projectsSidebarSection — Projects section title controls.
 *
 * Projects has two distinct collapse controls:
 * - title-side single arrow: hide/show the whole Projects list
 * - right-side chevrons: keep the old behavior, collapse/expand every
 *   ProjectNode's session list while project rows remain visible
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectsSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx'),
  'utf8',
);

describe('Projects sidebar section', () => {
  it('keeps separate icons and handlers for section collapse vs project-node collapse', () => {
    expect(projectsSectionSource).toContain('ChevronDown');
    expect(projectsSectionSource).toContain('ChevronRight');
    expect(projectsSectionSource).toContain('ChevronsDownUp');
    expect(projectsSectionSource).toContain('ChevronsUpDown');
    expect(projectsSectionSource).toContain('Plus');
    expect(projectsSectionSource).toContain('const [isSectionCollapsed, setIsSectionCollapsed] = useState(false)');
    expect(projectsSectionSource).toContain('const SectionToggleIcon = isSectionCollapsed ? ChevronRight : ChevronDown');
    expect(projectsSectionSource).toContain('const ProjectNodesToggleIcon = isAllCollapsed ? ChevronsUpDown : ChevronsDownUp');
    expect(projectsSectionSource).toContain('const handleToggleAllProjectNodes = isAllCollapsed ? onExpandAll : onCollapseAll');
  });

  it('makes the title and adjacent hover arrow collapse the section and keeps new project at the far right', () => {
    const titleIndex = projectsSectionSource.indexOf("t('ccAgent.sidebar.projects')");
    const titleButtonIndex = projectsSectionSource.lastIndexOf('<button', titleIndex);
    const titleExpandedIndex = projectsSectionSource.indexOf('aria-expanded={!isSectionCollapsed}', titleButtonIndex);
    const hoverToggleIndex = projectsSectionSource.indexOf('<Tip text={sectionToggleLabel}');
    const hoverToggleExpandedIndex = projectsSectionSource.indexOf('aria-expanded={!isSectionCollapsed}', hoverToggleIndex);
    const sectionToggleIndex = projectsSectionSource.indexOf('aria-expanded={!isSectionCollapsed}');
    const createProjectIndex = projectsSectionSource.indexOf('onClick={onCreateProject}');
    const projectNodesToggleIndex = projectsSectionSource.indexOf('onClick={handleToggleAllProjectNodes}');
    const filterIndex = projectsSectionSource.indexOf('<SidebarFilterPopover');

    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(titleButtonIndex).toBeGreaterThanOrEqual(0);
    expect(titleExpandedIndex).toBeLessThan(titleIndex);
    expect(sectionToggleIndex).toBe(titleExpandedIndex);
    expect(hoverToggleIndex).toBeGreaterThan(titleIndex);
    expect(hoverToggleExpandedIndex).toBeGreaterThan(hoverToggleIndex);
    expect(projectNodesToggleIndex).toBeGreaterThan(hoverToggleExpandedIndex);
    expect(filterIndex).toBeGreaterThan(projectNodesToggleIndex);
    expect(createProjectIndex).toBeGreaterThan(filterIndex);
  });

  it('hides the project-node toggle-all control when the Projects section is collapsed', () => {
    expect(projectsSectionSource).toMatch(/\{!isSectionCollapsed && \(\s*<Tip text=\{projectNodesToggleLabel\}/);
  });

  it('exposes a Projects-owned create-project button in the hover action group', () => {
    expect(projectsSectionSource).toContain('onCreateProject: () => void');
    expect(projectsSectionSource).toContain("t('ccAgent.sidebar.newProject')");
    expect(projectsSectionSource).toContain('onClick={onCreateProject}');
    expect(projectsSectionSource).toContain('<Plus size={14} strokeWidth={2} />');
  });

  it('only shows project header actions while hovering or focusing the Projects header row', () => {
    expect(projectsSectionSource).toContain('group/sidebar-header flex h-6');
    expect(projectsSectionSource).toContain('pointer-events-none opacity-0 transition-opacity duration-150');
    expect(projectsSectionSource).toContain('group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100');
    expect(projectsSectionSource).toContain('has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100');
    expect(projectsSectionSource).not.toContain('group-focus-within/sidebar-header:pointer-events-auto');
    expect(projectsSectionSource).toContain('className={HEADER_HOVER_ACTION_CLASS}');
    expect(projectsSectionSource).toContain('className={HEADER_ACTIONS_CLASS}');
  });

  it('hides the project tree only through the section collapsed state', () => {
    expect(projectsSectionSource).toContain('{!isSectionCollapsed && (');
    expect(projectsSectionSource).toContain('isCollapsed={projectKeyComparisonSetHas(');
  });
});
