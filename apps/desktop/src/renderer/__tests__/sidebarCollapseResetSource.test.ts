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
    // Tailwind 任意值类名无法引用常量,两处 200 只能靠这条断言互锁:
    // 谁改了动画时长却没同步另一处,这里立刻红。
    expect(sectionCollapseSource).toContain('SECTION_COLLAPSE_DURATION_MS = 200');
    expect(sectionCollapseSource).toContain('duration-[200ms]');
    expect(sectionCollapseSource).not.toMatch(/duration-\[(?!200ms)\d+m?s\]/);
  });
});
