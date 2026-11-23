/**
 * projectsSidebarSection — 主列表接线不变量。
 *
 * 2026-11-19 极简侧栏:顶部标签(任务 / 对话 / 自动化)取代段头范围下拉、批量折叠按钮
 * 与竖向设备分段;电脑改由标签下的横向电脑行切换。这里只守仍然存在的接线。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectsSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx'),
  'utf8',
);

describe('Projects sidebar section', () => {
  it('feeds every visible list session into source labels outside the inbox', () => {
    // task-inbox.md：收件箱候选现在也在普通列表中保持订阅，不能抢占普通列表的来源标签。
    // 保留已有 guard 接线契约：普通列表覆盖项目、对话和未分类；只有收件箱模式用 inboxSessions。
    expect(projectsSectionSource).toContain('flattenedSessionsForSourceLabels');
    expect(projectsSectionSource).toContain(
      "if (taskListMode === 'inbox' && inboxSessions) return inboxSessions",
    );
    expect(projectsSectionSource).toContain(
      '[...projects.flatMap((project) => project.sessions), ...dialogues, ...unclassified]',
    );
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
      'getRemoteSessionActivity(session.id, session.deviceLinkDeviceId)?.phase',
    );
    // 档位映射由 sidebarPriorityContext 行为测试覆盖;排序和点击共用该入口。
    expect(projectsSectionSource).toContain('sidebarPriorityContext(');
    // 三个集合作为一个整体喂给混排模型。
    expect(projectsSectionSource).toContain('priorityContext,');
    expect(projectsSectionSource).toContain('useViewedPriorityHold(');
    expect(projectsSectionSource).toContain('holdViewedPriorityRank(');
    expect(projectsSectionSource).toContain('viewedSessionId ?? activeSessionId');
    // 折叠豁免与排序、聚合灯同一口径(含远程):attention ∪ running
    // (Greptile P1:running-only 会话不能被折进「显示全部」,否则上层
    // 呼吸灯指向不可见条目),不再用只有本地的 notifications。
    expect(projectsSectionSource).toContain(
      'const next = new Set(priorityContext.attentionSessionIds)',
    );
    expect(projectsSectionSource).toContain(
      'for (const id of priorityContext.runningSessionIds) next.add(id)',
    );
    expect(projectsSectionSource).toContain(
      'entrySessions(entry).some((s) => lampFoldExemptIds.has(s.id))',
    );
  });

  // 顶部标签把同一份混排结果切给各标签,再各自走「显示全部」折叠视图;
  // 先折叠再切会让别的标签的条目占掉本标签的可见名额。
  it('slices the mixed list per top tab before applying the fold view', () => {
    expect(projectsSectionSource).toContain('groupDialogue: true,');
    expect(projectsSectionSource).toContain('groupAutomation: true,');
    expect(projectsSectionSource).toContain(
      'const mixedEntries = useMemo(() => entriesForTab(allTabEntries, mainTab), [allTabEntries, mainTab]);',
    );
    expect(projectsSectionSource).toContain('} = collapseEntries(mixedEntries, showAllProjects);');
    expect(projectsSectionSource.indexOf('const mixedEntries = useMemo(')).toBeLessThan(
      projectsSectionSource.indexOf('} = collapseEntries(mixedEntries, showAllProjects);'),
    );
    // F-PJ-10:具体多选项目时未分类区不渲染;否则并入混排,自动化跑出的未分类任务才能归到自动化标签。
    expect(projectsSectionSource).toContain(
      '() => (unclassifiedHidden ? [] : unclassified),',
    );
    expect(projectsSectionSource).toContain('unclassified: mixedUnclassified,');
    expect(projectsSectionSource).toContain('{!deviceGroupingActive && projectsOverflow && (');
  });

  it('renders pre-grouped automation entries as one flat-list row', () => {
    expect(projectsSectionSource).toContain(
      "entry.kind === 'session' || entry.kind === 'automation-group'",
    );
    expect(projectsSectionSource).toContain('<SessionEntryRows');
    expect(projectsSectionSource).toContain('entries={[entry]}');
    expect(projectsSectionSource).not.toContain('sessions={[entry.session]}');
  });

  it('keeps per-group automation collapse wired after the batch fold button was removed', () => {
    expect(projectsSectionSource).toContain('useAutomationGroupsCollapsed(');
    expect(projectsSectionSource).toContain(
      'automationGroupCollapsed={isAutomationGroupCollapsed}',
    );
    expect(projectsSectionSource).toContain(
      'onAutomationGroupCollapsedChange={setAutomationGroupCollapsed}',
    );
  });
});
