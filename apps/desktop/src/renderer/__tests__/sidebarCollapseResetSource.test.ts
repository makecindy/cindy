import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readSidebarSource(...parts: string[]) {
  return readFileSync(
    resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', ...parts),
    'utf8',
  );
}

const sessionEntryListSource = readSidebarSource('SessionEntryList.tsx');
const projectNodeSource = readSidebarSource('sections', 'ProjectNode.tsx');
const projectsSectionSource = readSidebarSource('sections', 'ProjectsSection.tsx');
const dialogueSectionSource = readSidebarSource('sections', 'DialogueSection.tsx');
const sectionCollapseSource = readSidebarSource('SectionCollapse.tsx');

describe('sidebar collapse reset wiring', () => {
  it('resets the collapsible session list showAll from its parent section collapsed state', () => {
    expect(sessionEntryListSource).toContain('sectionCollapsed?: boolean');
    expect(sessionEntryListSource).toContain('useCollapsibleShowAll(sectionCollapsed)');
  });

  it('resets project session showAll on project collapse and on Projects section collapse', () => {
    expect(projectNodeSource).toContain('parentSectionCollapsed: boolean');
    expect(projectNodeSource).toContain('sectionCollapsed={isCollapsed || parentSectionCollapsed}');
    // 2026-08-13 定稿:主列表段级收起随「标题 = 范围下拉」取消,parent 恒为 false
    //(prop 保留:置顶段等其它宿主仍在用)。
    expect(projectsSectionSource).toContain('parentSectionCollapsed={false}');
  });

  it('passes the Dialogue section collapsed state into its collapsible session list', () => {
    expect(dialogueSectionSource).toContain('sectionCollapsed={collapsed}');
  });

  it('Projects section project-list showAll no longer tracks a section collapse (removed)', () => {
    // 段级收起已取消(2026-08-13 定稿),showAll 不再有段收起复位来源。
    expect(projectsSectionSource).toContain('useCollapsibleShowAll(false)');
  });

  it('keeps the reset delay constant in sync with the CSS animation duration', () => {
    // 动画时长走 --motion-base(默认 200ms,DESIGN.md §14.4),复位延时常量要与它的默认值互锁:
    // 谁改了回退值却没同步常量,这里立刻红。
    expect(sectionCollapseSource).toContain('SECTION_COLLAPSE_DURATION_MS = 200');
    expect(sectionCollapseSource).toContain('duration-[var(--motion-base,200ms)]');
    expect(sectionCollapseSource).not.toMatch(/duration-\[(?:var\(--motion-base,)?(?!200ms)\d+m?s\)?\]/);
  });
});
