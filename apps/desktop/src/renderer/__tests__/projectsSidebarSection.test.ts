/**
 * projectsSidebarSection — 主列表段头控件不变量。
 *
 * 2026-08-13 用户定稿:段头标题即机器范围下拉(MachineSwitcherMenu,「全部任务」
 * 与设备下拉合并),段级收起取消;右侧保留折叠按钮(单层 = 收起所有分组 ↔ 展开;
 * 设备+项目双层 = 循环 收项目层 → 收设备层 → 全部展开,foldState 状态机)与
 * 侧边栏显示设置入口。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectsSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx'),
  'utf8',
);

describe('Projects sidebar section', () => {
  it('keeps the group fold state machine (section collapse itself is gone)', () => {
    // 设备段头仍用单箭头折叠;右侧折叠按钮走三态状态机。
    expect(projectsSectionSource).toContain('ChevronDown');
    expect(projectsSectionSource).toContain('ChevronRight');
    expect(projectsSectionSource).toContain('ChevronsDownUp');
    expect(projectsSectionSource).toContain('ChevronsUpDown');
    // E 期折叠状态机:三态循环 + 图标随「下一步动作」切换。
    expect(projectsSectionSource).toContain(
      "'collapse-groups' | 'collapse-devices' | 'expand-all'",
    );
    expect(projectsSectionSource).toContain(
      "const FoldIcon = foldState === 'expand-all' ? ChevronsUpDown : ChevronsDownUp",
    );
    // 段级收起已随「标题 = 范围下拉」取消(2026-08-13 用户定稿)。
    expect(projectsSectionSource).not.toContain('isSectionCollapsed');
    expect(projectsSectionSource).not.toContain('SectionToggleIcon');
  });

  it('header order: scope title dropdown → fold → filter', () => {
    const titleIndex = projectsSectionSource.indexOf('<MainListScopeHeader');
    const foldIndex = projectsSectionSource.indexOf('onClick: handleFoldAll');
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(foldIndex).toBeGreaterThan(titleIndex);
    expect(projectsSectionSource).toContain('hasMainListContent && foldState !== null');
    // 只有对话组、没有项目时折叠按钮仍可用;零项目不能把 isAllCollapsed 当成组层已收齐。
    expect(projectsSectionSource).toContain(
      'disabled: projectNodesToggleDisabled && !hasDeviceLayer && !hasGroupLayer',
    );
    expect(projectsSectionSource).toContain(
      "const hasVisibleProjectGroups = mixedEntries.some((entry) => entry.kind === 'project')",
    );
    expect(projectsSectionSource).toContain('(!hasVisibleProjectGroups || isAllCollapsed)');
    // 平铺时来源标签要覆盖从项目摊出来的会话,不能只喂 dialogues。
    expect(projectsSectionSource).toContain('flattenedSessionsForSourceLabels');
    expect(projectsSectionSource).toContain(
      '[...projects.flatMap((project) => project.sessions), ...dialogues]',
    );
  });

  // 2026-08-12 用户裁决:段头「新建项目」按钮暂时移除(同一动作在新任务页的工作
  // 目录选择器仍可完成)。prop 保留但不再渲染按钮;恢复入口时把这条断言改回正向。
  it('no longer renders the create-project button in the header action group', () => {
    expect(projectsSectionSource).toContain('onCreateProject?: () => void');
    expect(projectsSectionSource).not.toContain('onClick={onCreateProject}');
    expect(projectsSectionSource).not.toContain("t('ccAgent.sidebar.newProject')");
    expect(projectsSectionSource).not.toContain('<Plus size={14} strokeWidth={2} />');
  });

  it('only shows project header actions while hovering or focusing the Projects header row', () => {
    const headerSource = readFileSync(
      resolve(
        __dirname,
        '..',
        'features',
        'cc-agent',
        'sidebar',
        'MainListScopeHeader.tsx',
      ),
      'utf8',
    );
    expect(headerSource).toContain('group/sidebar-header flex h-6');
    expect(headerSource).toContain(
      'pointer-events-none opacity-0 transition-opacity duration-150',
    );
    expect(headerSource).toContain(
      'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
    );
    expect(headerSource).toContain(
      'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
    );
    expect(headerSource).not.toContain(
      'group-focus-within/sidebar-header:pointer-events-auto',
    );
    expect(headerSource).toContain('className={HEADER_ACTIONS_CLASS}');
  });

  it('the project tree renders unconditionally (section collapse removed)', () => {
    // 树不再包 SectionCollapse(设备段 / 对话组内部的仍在);项目行折叠照旧受控。
    expect(projectsSectionSource).not.toMatch(/<SectionCollapse collapsed=\{isSectionCollapsed\}>/);
    expect(projectsSectionSource).toContain('isCollapsed={collapsed.has(project.projectKey)}');
  });

  // 2026-08-13 review P1:优先级排序的三个集合必须并入 device-link 远程活动镜像
  // ——远程行自己的状态点亮着,排序却把它当 idle。
  it('priority context merges remote activity (running / waiting / unread)', () => {
    // 远程镜像经整表版本号订阅 + 逐 id 读(聚合组件先例)。
    expect(projectsSectionSource).toContain(
      'const remoteActivityRevision = useRemoteSessionActivityRevision()',
    );
    expect(projectsSectionSource).toContain(
      'const activity = getRemoteSessionActivity(session.id)',
    );
    // running / needs-interaction / error / completed-unread 各归其档。
    expect(projectsSectionSource).toMatch(
      /activity\.phase === 'needs-interaction' \|\| activity\.phase === 'error'/,
    );
    // 三个集合作为一个整体喂给混排模型。
    expect(projectsSectionSource).toContain('priorityContext,');
    expect(projectsSectionSource).toContain('advanceViewedPriorityHold(');
    expect(projectsSectionSource).toContain('holdViewedPriorityRank(');
    expect(projectsSectionSource).toContain('viewedSessionId ?? activeSessionId');
    // 折叠豁免与排序同一口径(含远程),不再用只有本地的 notifications。
    expect(projectsSectionSource).toContain(
      'entrySessions(entry).some((s) => priorityContext.attentionSessionIds.has(s.id))',
    );
  });

  // 2026-08-13 review P1:设备是最外层层级,折叠只能发生在段内——先全局折叠再
  // 切段会把前 N 名之外的设备连段头一起藏掉。
  it('device grouping splits the full list first, then collapses per section', () => {
    expect(projectsSectionSource).toContain(
      'return splitEntriesByDevice(mixedEntries, [...(remoteDeviceIndex?.keys() ?? [])], {',
    );
    expect(projectsSectionSource).toContain('unclassified: deviceGroupingActive && !unclassifiedHidden ? unclassified : []');
    // 每段独立折叠视图 + 段内作用域的「显示全部」(复核 P2:共用一个标志会让
    // 点任一段全段展开)。
    expect(projectsSectionSource).toMatch(
      /const sectionView = collapseEntries\(\s*section\.entries,\s*expandedDeviceSections\.has\(key\),\s*\)/,
    );
    expect(projectsSectionSource).toContain('{sectionView.isOverflowing && (');
    expect(projectsSectionSource).toContain(
      'setExpandedDeviceSections((prev) => new Set(prev).add(key))',
    );
    expect(projectsSectionSource).toContain('{!deviceGroupingActive && projectsOverflow && (');
  });

  // 2026-08-13 复核 P1:manual 与设备分组"渲染不叠加"是定稿,生效判定必须跟着
  // 排除——否则机器标签被藏、批量折叠键按逐设备派生、折叠状态机进入
  // collapse-devices 却没有可见效果(派生态以为在设备分组、渲染实际是单段)。
  it('deviceGroupingActive excludes manual sort so derived state matches the rendered mode', () => {
    expect(projectsSectionSource).toContain(
      "deviceGroupingAvailable && filter.groupDevice && filter.sortBy !== 'manual'",
    );
  });

  it('renders pre-grouped automation entries as one flat-list row', () => {
    expect(projectsSectionSource).toContain(
      "entry.kind === 'session' || entry.kind === 'automation-group'",
    );
    expect(projectsSectionSource).toContain('<SessionEntryRows');
    expect(projectsSectionSource).toContain('entries={[entry]}');
    expect(projectsSectionSource).not.toContain('sessions={[entry.session]}');
  });

  it('includes automation groups in the header batch fold state machine', () => {
    expect(projectsSectionSource).toContain(
      "const hasGroupLayer = mixedEntries.some((entry) => entry.kind !== 'session')",
    );
    expect(projectsSectionSource).toContain('useAutomationGroupsCollapsed(');
    expect(projectsSectionSource).toContain('setAllAutomationGroupsCollapsed(true)');
    expect(projectsSectionSource).toContain('setAllAutomationGroupsCollapsed(false)');
    expect(projectsSectionSource).toContain('allAutomationGroupsCollapsed');
    expect(projectsSectionSource).toContain(
      'automationGroupCollapsed={isAutomationGroupCollapsed}',
    );
    expect(projectsSectionSource).toContain(
      'onAutomationGroupCollapsedChange={setAutomationGroupCollapsed}',
    );
  });
});
