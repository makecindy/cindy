/**
 * dialogueSidebarSection — projectless conversation sidebar invariants.
 *
 * These are static checks because the renderer test environment has no jsdom.
 *
 * 侧边栏重设计 D 期(2026-08-12,docs/product-rules/sidebar-redesign-plan.md):
 * 旧裁决「Dialogue 是 Projects 的同级固定段、固定显示在 Projects 之后」已被
 * **有意推翻**——对话与项目行在主列表中按同一口径混排(mainListModel),
 * 「对话归为一组」成为可选开关。本文件的不变量随之改写:
 *   - 主列表由 ProjectsSection 统一渲染,dialogues 作为混排输入传入;
 *   - 项目筛选含「对话」哨兵:未勾选 DIALOGUE_FILTER_KEY 时隐藏无项目任务;
 *   - 固定 DialogueSection 段与按日期分组段不再渲染。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

const projectsSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx'),
  'utf8',
);

const mainListModelSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'lib', 'mainListModel.ts'),
  'utf8',
);

const newMakerDraftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

function extractHandlerBlock(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?(?:\\}, \\[|\\};)`));
  expect(match, `expected to find handler ${name}`).not.toBeNull();
  return match![0];
}

const remoteProjectsHookSource = readFileSync(
  resolve(__dirname, '..', 'features', 'device-link', 'useDeviceLinkRemoteProjects.ts'),
  'utf8',
);

describe('Mixed main list (sidebar-redesign D 期)', () => {
  it('renders dialogues through the mixed ProjectsSection instead of a fixed DialogueSection', () => {
    expect(sidebarSource).toContain('dialogues={visibleDialogues}');
    expect(sidebarSource).not.toContain('<DialogueSection');
    expect(projectsSectionSource).toContain('buildMainListEntries');
  });

  it('drops the removed date-grouped section entirely', () => {
    expect(sidebarSource).not.toContain('<DateGroupedSessionsSection');
    expect(sidebarSource).not.toContain("filter.groupBy === 'date'");
  });

  it('lets the project filter include or exclude dialogues via DIALOGUE_FILTER_KEY', () => {
    expect(sidebarSource).toContain('DIALOGUE_FILTER_KEY');
    expect(sidebarSource).toContain('filter.projectsAsSet.has(DIALOGUE_FILTER_KEY)');
  });

  it('keeps manual sort scoped to project rows (设计文档 §9.3 收窄)', () => {
    // 手动排序只重排项目行;散排对话 / 对话组不进 manualProjectOrder。
    expect(mainListModelSource).toContain("sortBy === 'manual'");
    expect(mainListModelSource).toContain('normalizeManualProjectOrder');
    expect(projectsSectionSource).toContain("filter.sortBy === 'manual' ? (");
  });

  it('offers the dialogue group as an opt-in toggle, not a fixed section', () => {
    expect(mainListModelSource).toContain('groupDialogue');
    expect(projectsSectionSource).toContain('DialogueGroupNode');
    expect(projectsSectionSource).toContain("t('ccAgent.sidebar.dialogues')");
  });

  it('loads archived sessions on demand for the selected connected remote devices', () => {
    expect(sidebarSource).toContain("if (filter.status === 'active') return;");
    expect(sidebarSource).toContain("requestRemoteSessionStatus(device.deviceId, 'archived')");
    expect(sidebarSource).toContain('if (!device.connected) continue;');
    expect(sidebarSource).toContain('selectedRemoteIds && !selectedRemoteIds.has(device.deviceId)');
    // 折叠 rail 与展开态必须共用同一状态过滤结果，不能在「已归档」下继续露出 active。
    expect(sidebarSource).toContain('statusFilteredSessionsWithRemote');
    expect(sidebarSource).toContain('matchesSidebarSessionStatus');
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
    expect(remoteProjectsHookSource).toContain(
      'remoteProjectsStore.markSessionStatusFailed(deviceId, status)',
    );
    expect(remoteProjectsHookSource).toContain('scheduleArchivedSessionRetry(deviceId)');
    expect(remoteProjectsHookSource).toContain("retryRemoteSessionStatus(deviceId, 'archived')");
    expect(sidebarSource).toContain('useRemoteArchivedFailedDeviceIds()');
    expect(sidebarSource).toContain('useRemoteArchivedLoadedDeviceIds()');
    expect(sidebarSource).toContain("if (filter.status === 'archived')");
  });

  it('keeps remote background loading from changing the sidebar layout', () => {
    // Existing local/cached rows must stay in place while remote bootstrap runs in the background.
    // A partial loading notice in the scroll flow makes every row jump when it mounts/unmounts.
    expect(sidebarSource).toContain('远程任务 / 设备目录的 loading 只在上面的「无内容」分支显示');
    expect(sidebarSource).not.toMatch(
      /remoteDeviceDirectoryStatus === 'loading'\s*&&\s*\n?\s*\(\s*<RemoteSidebarLoadNotice[\s\S]*?partial\s*\/\>\s*\)/,
    );
    expect(sidebarSource).not.toMatch(
      /remoteSessionBootstrapLoadingDevices\.length > 0\s*&&\s*\n?\s*\(\s*<RemoteSidebarLoadNotice[\s\S]*?partial\s*\n?\s*\/\>\s*\)/,
    );
  });

  it('routes standalone dialogue targets through the mounted draft page transition', () => {
    const handler = extractHandlerBlock(sidebarSource, 'handleCreateDialogue');
    expect(sidebarSource).toContain(
      'resolveDialogueDeviceTarget(selectedMachineId, switcherDevices, deviceListSettled)',
    );
    expect(handler).toContain("selectedDialogueDeviceResolution.status === 'pending'");
    // 无显式目标时仍走作用域推断(pending 守卫 + resolution.target);显式目标见下一条。
    expect(handler).toContain('if (deviceTarget === undefined)');
    expect(handler).toContain('target = selectedDialogueDeviceResolution.target;');
    expect(handler).toContain('state: makeDialogueNewMakerRouteState(target)');
    expect(handler).not.toContain('resetDraftWorkspaceTargets');
    expect(handler).not.toContain('patchNewMakerDraft');
    expect(newMakerDraftRouteSource).toContain('readNewMakerDialogueTargetRequest(location.state)');
    expect(newMakerDraftRouteSource).toContain(
      'handledDialogueTargetRequestRef.current === dialogueTargetRequest.requestId',
    );
    expect(newMakerDraftRouteSource).toContain('patchCollab({ enabled: false });');
    expect(newMakerDraftRouteSource).toMatch(
      /applyDraftTarget\(\{\s*deviceId: dialogueTargetRequest\.deviceId,\s*deviceName: dialogueTargetRequest\.deviceName,\s*workingDir: null,/,
    );
    expect(newMakerDraftRouteSource).toContain(
      'state: consumeNewMakerDialogueTargetRequest(location.state)',
    );
    expect(newMakerDraftRouteSource).toContain('replace: true');
    expect(handler).toContain("navigate('/cc-agent/new'");
    // 混排后展开态的「新建对话」入口并入统一新建;rail 对话面板仍保留独立入口。
    expect(sidebarSource).toContain('onCreateDialogue={handleCreateDialogue}');
    expect(sidebarSource).toContain('isCreateDialogueDisabled={dialogueCreatePending}');
  });

  // 2026-08-12 用户裁决:按设备分组时,某个设备段下「对话」组的新建必须落在该设备上,
  // 不再按当前机器作用域猜(作用域可能是「所有」或另一台设备)。
  it('creates the dialogue on the device that owns the group when grouping by device', () => {
    // 设备段把自己的设备作为创建目标传下去:本机段 null,远程段 {deviceId, deviceName}。
    expect(projectsSectionSource).toMatch(
      /renderNonProjectEntry\(\s*entry,\s*key,\s*section\.deviceId\s*\?\s*\{ deviceId: section\.deviceId, deviceName: name \}\s*:\s*null,\s*\)/,
    );
    // 不按设备分组的两条渲染路径不传目标 → 上层沿用作用域推断。
    expect(projectsSectionSource).toContain('renderNonProjectEntry(entry, DIALOGUE_GROUP_ALL_KEY)');
    expect(projectsSectionSource).toContain(
      'onCreateDialogue={() => onCreateDialogue(dialogueDeviceTarget)}',
    );
    // 目标设备离线 → 禁用新建并复用远程写保护文案(被控端才是真正的创建方)。
    expect(projectsSectionSource).toContain("t('ccAgent.remoteSession.actionsUnavailable')");
    expect(projectsSectionSource).toMatch(/const targetDeviceOffline = Boolean\(/);
    // 显式目标不受作用域解析 pending 影响(目标已定,无需等设备目录 settle)。
    expect(projectsSectionSource).toContain(
      'dialogueDeviceTarget === undefined ? isCreateDialogueDisabled : false',
    );
  });

  // 2026-08-12 实机反馈:list 变体的分割线是「每行底线 + 列表首行顶线」,而混排把
  // 每条散排对话各渲染成一个单条 SessionEntryList → 每个都自认首行,上一行底线与
  // 本行顶线叠成两根横线。散排路径必须关掉顶线(底线已覆盖行间分割)。
  it('does not double up dividers between standalone dialogues in list mode', () => {
    const sessionEntryListSource = readFileSync(
      resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionEntryList.tsx'),
      'utf8',
    );
    expect(sessionEntryListSource).toContain('isFirst={showFirstDivider && index === 0}');
    expect(projectsSectionSource).toContain('showFirstDivider={false}');
    // 真正的列表首行(置顶段 / 项目内会话 / 自动化组)保持默认,不传该 prop。
    const pinnedSectionSource = readFileSync(
      resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'PinnedSection.tsx'),
      'utf8',
    );
    expect(pinnedSectionSource).not.toContain('showFirstDivider');
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
