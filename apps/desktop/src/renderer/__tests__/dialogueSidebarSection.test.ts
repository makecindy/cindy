/**
 * dialogueSidebarSection — projectless conversation sidebar invariants.
 *
 * These are static checks because the renderer test environment has no jsdom.
 * The product rule is intentionally narrow: Dialogue is a project-peer section,
 * not a pseudo-project, so project filtering/manual project order must not hide
 * or reposition the Dialogue section.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

const dialogueSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'DialogueSection.tsx'),
  'utf8',
);

const dateGroupedSectionSource = readFileSync(
  resolve(
    __dirname,
    '..',
    'features',
    'cc-agent',
    'sidebar',
    'sections',
    'DateGroupedSessionsSection.tsx',
  ),
  'utf8',
);

const newMakerDraftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const remoteProjectsHookSource = readFileSync(
  resolve(__dirname, '..', 'features', 'device-link', 'useDeviceLinkRemoteProjects.ts'),
  'utf8',
);

describe('Dialogue sidebar section', () => {
  it('is rendered after Projects in project-grouped mode', () => {
    const projectsIndex = sidebarSource.indexOf('<ProjectsSection');
    const dialogueIndex = sidebarSource.indexOf('<DialogueSection');

    expect(projectsIndex).toBeGreaterThanOrEqual(0);
    expect(dialogueIndex).toBeGreaterThanOrEqual(0);
    expect(dialogueIndex).toBeGreaterThan(projectsIndex);
  });

  it('does not let project filtering hide dialogues', () => {
    expect(sidebarSource).not.toMatch(/filter\.projectsAsSet\s*!==\s*null\)\s*return\s*\[\]/);
  });

  it('keeps the Dialogue section visible when it has no sessions', () => {
    expect(dialogueSectionSource).not.toMatch(/sessions\.length\s*===\s*0\)\s*return\s+null/);
    expect(dialogueSectionSource).toContain("'ccAgent.sidebar.noDialogues'");
  });

  it('shows loading instead of the empty state until the initial session fetch settles', () => {
    expect(sidebarSource.match(/isLoading=\{isLoadingSidebarSessions\}/g)).toHaveLength(2);
    expect(sidebarSource).toContain('useRemoteSessionBootstrapLoading(selectedMachineId)');
    expect(sidebarSource).toMatch(
      /sessionsHook\.isLoading\s*\|\|\s*remoteSessionBootstrapLoading\s*\|\|\s*remoteDeviceDirectoryStatus === 'loading'/,
    );
    expect(dialogueSectionSource).toContain('isLoading: boolean');
    expect(dialogueSectionSource).toContain("'ccAgent.sidebar.loadingDialogues'");
    expect(dialogueSectionSource).toMatch(
      /isLoading\s*\?\s*'ccAgent\.sidebar\.loadingDialogues'\s*:\s*'ccAgent\.sidebar\.noDialogues'/,
    );
    expect(dateGroupedSectionSource).toContain('isLoading: boolean');
    expect(dateGroupedSectionSource).toContain('!isLoading');
    expect(dateGroupedSectionSource).toMatch(
      /isLoading\s*\?\s*'ccAgent\.sidebar\.loadingDialogues'\s*:\s*'ccAgent\.sidebar\.dateGroup\.empty'/,
    );
  });

  it('shows remote directory/task loading and failures before connecting or authoritative empty states', () => {
    const failureIndex = sidebarSource.indexOf(
      'remoteSessionBootstrapFailures.length > 0 && !hasVisibleSidebarContent',
    );
    const connectingIndex = sidebarSource.indexOf('selectedMachineConnecting ?');
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(connectingIndex).toBeGreaterThan(failureIndex);
    expect(sidebarSource).toContain("'ccAgent.sidebar.machineSwitcher.tasksLoadFailed'");
    expect(sidebarSource).toContain("'ccAgent.sidebar.machineSwitcher.tasksPartiallyFailed'");
    // 任务读取失败是「自动重试进行中」的状态说明(reconciler 退避重试 + 熔断探测恢复
    // 自动补拉),不再提供手动重试按钮(2026-08 弱网实测反馈:重连必须全自动)。
    expect(sidebarSource).not.toContain('retryRemoteSessionBootstrap(device.deviceId)');
    expect(sidebarSource).not.toContain("'ccAgent.sidebar.machineSwitcher.retryTasks'");
    expect(sidebarSource).toContain("'ccAgent.sidebar.machineSwitcher.tasksLoading'");
    expect(sidebarSource).toContain("'ccAgent.sidebar.machineSwitcher.devicesLoadFailed'");
    expect(sidebarSource).toContain("'ccAgent.sidebar.machineSwitcher.devicesLoading'");
    expect(sidebarSource).toContain('retryDeviceLinkDeviceList');
    // 即使有旧/空 shard，本轮 gave-up 也必须进 error，不能把缓存伪装成权威结果。
    expect(remoteProjectsHookSource).toContain("if (result === 'gave-up') {");
    expect(remoteProjectsHookSource).not.toContain(
      "result === 'gave-up' && !remoteProjectsStore.hasDevice(deviceId)",
    );
  });

  it('has a Dialogue-owned runtime sort setting instead of using project manual order or renderer storage', () => {
    expect(dialogueSectionSource).toContain('DIALOGUE_SORT_OPTIONS');
    expect(dialogueSectionSource).not.toMatch(/manualProjectOrder/);
    expect(dialogueSectionSource).not.toMatch(/localStorage/);
  });

  it('exposes Dialogue-owned create and section collapse controls', () => {
    expect(dialogueSectionSource).toContain('onCreateDialogue');
    expect(dialogueSectionSource).toContain('SquarePen');
    expect(dialogueSectionSource).toContain('ChevronDown');
    expect(dialogueSectionSource).toContain('ChevronRight');
    expect(dialogueSectionSource).not.toContain('ChevronsDownUp');
    expect(dialogueSectionSource).not.toContain('ChevronsUpDown');
    expect(dialogueSectionSource).toContain("t('ccAgent.sidebar.newDialogue')");
    expect(dialogueSectionSource).toContain("t('ccAgent.sidebar.dialoguesToggleExpand')");
    expect(dialogueSectionSource).toContain("t('ccAgent.sidebar.dialoguesToggleCollapse')");
  });

  it('makes the Dialogue title and adjacent hover arrow collapse the section instead of putting collapse in the right tool group', () => {
    const titleIndex = dialogueSectionSource.indexOf("t('ccAgent.sidebar.dialogues')");
    const titleButtonIndex = dialogueSectionSource.lastIndexOf('<button', titleIndex);
    const titleExpandedIndex = dialogueSectionSource.indexOf(
      'aria-expanded={!collapsed}',
      titleButtonIndex,
    );
    const hoverToggleIndex = dialogueSectionSource.indexOf('<Tip text={toggleLabel}');
    const hoverToggleExpandedIndex = dialogueSectionSource.indexOf(
      'aria-expanded={!collapsed}',
      hoverToggleIndex,
    );
    const settingsIndex = dialogueSectionSource.indexOf("t('ccAgent.sidebar.dialogueSettings')");

    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(titleButtonIndex).toBeGreaterThanOrEqual(0);
    expect(titleExpandedIndex).toBeLessThan(titleIndex);
    expect(hoverToggleIndex).toBeGreaterThan(titleIndex);
    expect(hoverToggleExpandedIndex).toBeGreaterThan(hoverToggleIndex);
    expect(settingsIndex).toBeGreaterThan(hoverToggleExpandedIndex);
  });

  it('only shows dialogue header actions while hovering or focusing the Dialogue header row', () => {
    expect(dialogueSectionSource).toContain('group/sidebar-header flex h-6');
    expect(dialogueSectionSource).toContain(
      'pointer-events-none opacity-0 transition-opacity duration-150',
    );
    expect(dialogueSectionSource).toContain(
      'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
    );
    expect(dialogueSectionSource).toContain(
      'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
    );
    expect(dialogueSectionSource).not.toContain(
      'group-focus-within/sidebar-header:pointer-events-auto',
    );
    expect(dialogueSectionSource).toContain('className={HEADER_HOVER_ACTION_CLASS}');
    expect(dialogueSectionSource).toContain('className={HEADER_ACTIONS_CLASS}');
  });

  it('creates a standalone dialogue without inheriting a project draft directory', () => {
    expect(sidebarSource).toContain('resetDraftWorkspaceTargets();');
    expect(sidebarSource).toMatch(
      /navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('dialogue'\)\s*\}\)/,
    );
    expect(sidebarSource).toContain('onCreateDialogue={handleCreateDialogue}');
  });

  it('allows the shared create route to send a standalone dialogue without picking a project', () => {
    // 产品决策:新建入口、对话段 +、项目行内 + 都进同一个创建页;差异只在默认
    // workingDir。workingDir 为空时直接创建 dialogue,不再强制弹项目 picker。
    expect(newMakerDraftRouteSource).not.toContain('selectProjectRequired');
    expect(newMakerDraftRouteSource).not.toContain('!selectedWorkingDir');
    expect(newMakerDraftRouteSource).toContain(
      "workspaceKind: workingDir ? 'project' : 'dialogue'",
    );
  });
});
