/**
 * Shared create project picker invariants.
 *
 * Static checks keep the architecture boundary explicit: shared picker
 * primitives still support project selection, while the CREATE AGENT route
 * only exposes the Figma mode pill and never renders its own sidebar chrome
 * inside the app shell.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// 本仓 core.autocrlf=true 时 Windows checkout 出来的源文件是 CRLF,而下面的快照断言
// 统一按 LF 书写;读入时归一化行尾(CRLF 与孤立 CR 都归一为 LF),让断言不绑定
// checkout 端的行尾配置。
const readSource = (...segments: string[]): string =>
  readFileSync(resolve(__dirname, '..', ...segments), 'utf8').replace(/\r\n?/g, '\n');

const newMakerDraftRouteSource = readSource('features', 'cc-agent', 'NewMakerDraftRoute.tsx');

const worktreeChipsSource = readSource('components', 'new-chat', 'WorktreeChipsRow.tsx');

const folderPickerPopoverSource = readSource('components', 'new-chat', 'FolderPickerPopover.tsx');
const mainLayoutSource = readSource('components', 'layout', 'MainLayout.tsx');

const addRemoteProjectDialogSource = readSource(
  'components',
  'new-chat',
  'AddRemoteProjectDialog.tsx',
);

const projectPickerOptionsHookSource = readSource('hooks', 'useProjectPickerOptions.ts');

const deviceLinkProjectsHookSource = readSource('hooks', 'useDeviceLinkProjects.ts');

const remoteSessionHandoffSource = readSource('features', 'cc-agent', 'remoteSessionHandoff.ts');

const remoteCollabHandoffSource = readSource('features', 'cc-agent', 'remoteCollabHandoff.ts');

const deviceSwitcherPillSource = readSource('components', 'new-chat', 'DeviceSwitcherPill.tsx');

const controllableDevicesHookSource = readSource('hooks', 'useControllableDevices.ts');

const deviceLinkRemoteProjectsSource = readSource(
  'features',
  'device-link',
  'useDeviceLinkRemoteProjects.ts',
);

const branchPickSource = readSource('components', 'new-chat', 'branchPick.ts');

const deviceProvidersHookSource = readSource('hooks', 'useDeviceProviders.ts');

const agentCapabilitiesHookSource = readSource('hooks', 'useAgentCapabilities.ts');
const availableAgentsHookSource = readSource('hooks', 'useAvailableAgents.ts');
const vendorSwitcherSource = readSource('components', 'new-chat', 'VendorSegmentedSwitcher.tsx');

const scheduleFormDialogSource = readSource(
  'features',
  'scheduler',
  'components',
  'ScheduleFormDialog.tsx',
);

const scheduleChipsSource = readSource('features', 'scheduler', 'components', 'ScheduleChips.tsx');

const newGoalDialogSource = readSource('components', 'new-chat', 'NewGoalDialog.tsx');

const chatInputSource = readSource('components', 'new-chat', 'ChatInput.tsx');

const sidebarUpperSource = readSource('features', 'cc-agent', 'CCAgentSidebarUpper.tsx');

describe('Shared create project picker', () => {
  it('builds project options from the persistent recent_workdirs table, not from live sessions', () => {
    // 0031 起创建页草稿的"项目"下拉脱离 sessions 列表,改读 recent_workdirs
    // 独立表 —— 归档/删除某目录下所有 session 时,该目录仍保留在最近列表里。
    expect(projectPickerOptionsHookSource).toContain('useRecentWorkdirs()');
    expect(projectPickerOptionsHookSource).toContain('extractDisplayName(');
    expect(projectPickerOptionsHookSource).toContain('getProjectPickerEmptyLabelKey');
    expect(newMakerDraftRouteSource).toContain(
      'const projectPickerOptions = useProjectPickerOptions()',
    );
    // 反向防回退:旧的从 sessions 反推路径已下线,不要再被引入。
    expect(newMakerDraftRouteSource).not.toContain('groupSessions(projectCandidates).projects');
    expect(newMakerDraftRouteSource).not.toContain('sortProjectsForSidebar(');
  });

  it('keeps the CREATE AGENT route from rendering internal project/sidebar chrome', () => {
    expect(newMakerDraftRouteSource).toContain('projectOptions={projectPickerOptions}');
    expect(newMakerDraftRouteSource).toContain('data-testid="create-agent-mode-pill"');
    expect(newMakerDraftRouteSource).not.toContain('emptyProjectLabel={emptyProjectLabel}');
    expect(newMakerDraftRouteSource).not.toContain(
      'getProjectPickerEmptyLabelKey(workspacePrompt)',
    );
    // 2026-07-19 恢复 worktree 入口(用户裁决,488cb33 误删回归;详见
    // newMakerCreateAgentVisualContract):路由允许且仅允许一个 advancedOnly
    // 变体的 WorktreeChipsRow(2026-07-28 起渲染 [分支 chip][worktree 勾选 chip],
    // 齿轮 popover 已移除;folderPickerMode="project" 仅为其 advancedHidden
    // 语义服务),不回退 folder chip 版;项目选择仍由 mode pill 独占。
    expect(newMakerDraftRouteSource).toMatch(/<WorktreeChipsRow[\s\S]*?variant="advancedOnly"/);
    expect((newMakerDraftRouteSource.match(/<WorktreeChipsRow/g) ?? []).length).toBe(1);
    expect(newMakerDraftRouteSource).not.toContain('data-testid="create-agent-sidebar"');
    expect(worktreeChipsSource).toContain("t('newChat.folderPicker.dialogue')");
    expect(worktreeChipsSource).toContain('emptyProjectLabel ??');
    expect(folderPickerPopoverSource).toContain("handleSelectPath('', 'dialogue')");
  });

  it('automation form uses the same project picker source and popover', () => {
    expect(scheduleFormDialogSource).toContain('const projectOptions = useProjectPickerOptions()');
    expect(scheduleFormDialogSource).not.toContain('useProjectGroups(');
    expect(scheduleFormDialogSource).not.toContain('useCCSessions(');
    expect(scheduleChipsSource).toContain('FolderPickerPopover');
    expect(scheduleChipsSource).toContain('projectOptions={projectOptions}');
    expect(scheduleChipsSource).toContain("source === 'dialogue'");
    expect(scheduleChipsSource).toContain("getProjectPickerEmptyLabelKey('generic')");
  });

  it('keeps folder picker wheel scrolling inside the shared menu', () => {
    expect(folderPickerPopoverSource).toContain('handleFolderPickerWheel');
    expect(folderPickerPopoverSource).toContain('onWheel={handleFolderPickerWheel}');
    expect(folderPickerPopoverSource).toContain('data-folder-picker-scroll="true"');
    expect(folderPickerPopoverSource).toContain('scrollRoot.scrollTop += normalizeWheelDeltaY(e)');
  });

  it('waits for async folder selection before closing the controlled popover', () => {
    const start = folderPickerPopoverSource.indexOf('const handleSelectPath = async');
    const end = folderPickerPopoverSource.indexOf('const handleRemoveProject', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = folderPickerPopoverSource.slice(start, end);
    const selectAt = body.indexOf('await onSelect(folderPath, source, option);');
    const closeAt = body.indexOf('onOpenChange(false);');
    expect(selectAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(selectAt);
    expect(body).toContain('finally {');
  });

  it('restores a hidden local project before applying the selected folder to the draft', () => {
    const handlerStart = newMakerDraftRouteSource.indexOf(
      'const handleModePickerSelect = useCallback(',
    );
    const handlerEnd = newMakerDraftRouteSource.indexOf(
      'const handleWtEnabledChange = useCallback(',
      handlerStart,
    );
    const handler = newMakerDraftRouteSource.slice(handlerStart, handlerEnd);

    expect(handler).toContain("source !== 'dialogue' && !effectiveDeviceLinkDeviceId");
    expect(handler).toContain('await requestSidebarProjectRestore(localProjectKey)');
    expect(handler).toContain('selectionSeq !== modePickerSelectionSeqRef.current');
    expect(handler.indexOf('await requestSidebarProjectRestore(localProjectKey)')).toBeLessThan(
      handler.indexOf("handleWorkingDirChange(source === 'dialogue' ? null : path)"),
    );
    expect(sidebarUpperSource).toContain('registerSidebarProjectRestoreHandler((projectKey) =>');
    expect(sidebarUpperSource).toContain('restoreSelectedHiddenProject({');
  });

  it('holds the existing creation lock until project restoration commits the draft target', () => {
    const handlerStart = newMakerDraftRouteSource.indexOf(
      'const handleModePickerSelect = useCallback(',
    );
    const handlerEnd = newMakerDraftRouteSource.indexOf(
      'const handleWtEnabledChange = useCallback(',
      handlerStart,
    );
    const handler = newMakerDraftRouteSource.slice(handlerStart, handlerEnd);
    const guardAt = handler.indexOf('if (sendInFlightRef.current) return;');
    const selectionAt = handler.indexOf(
      'const selectionSeq = ++modePickerSelectionSeqRef.current;',
    );
    const lockAt = handler.indexOf('markSendInFlight(true);');
    const restoreAt = handler.indexOf('await requestSidebarProjectRestore(localProjectKey);');
    const applyAt = handler.indexOf('handleWorkingDirChange(path);');
    const unlockAt = handler.indexOf('markSendInFlight(false);');

    expect(guardAt).toBeGreaterThan(-1);
    expect(selectionAt).toBeGreaterThan(guardAt);
    expect(lockAt).toBeGreaterThan(selectionAt);
    expect(restoreAt).toBeGreaterThan(lockAt);
    expect(applyAt).toBeGreaterThan(restoreAt);
    expect(unlockAt).toBeGreaterThan(applyAt);
    expect(handler.slice(lockAt, unlockAt)).toContain('finally {');
  });

  it('keeps picker choices disabled until the accepted selection finishes', () => {
    expect(folderPickerPopoverSource).toContain('if (selectionPendingRef.current) return;');
    expect(folderPickerPopoverSource).toContain('selectionPendingRef.current = true;');
    expect((folderPickerPopoverSource.match(/disabled=\{selectionPending\}/g) ?? []).length).toBe(
      8,
    );

    const handlerStart = folderPickerPopoverSource.indexOf('const handleSelectPath = async (');
    const handlerEnd = folderPickerPopoverSource.indexOf(
      'const handleRemoveProject =',
      handlerStart,
    );
    const handler = folderPickerPopoverSource.slice(handlerStart, handlerEnd);
    expect(handler.indexOf('selectionPendingRef.current = true;')).toBeLessThan(
      handler.indexOf('await onSelect(folderPath, source, option);'),
    );
    expect(handler.indexOf('await onSelect(folderPath, source, option);')).toBeLessThan(
      handler.indexOf('onOpenChange(false);'),
    );
  });

  it('keeps the sidebar restore owner mounted on the new-task route', () => {
    expect(mainLayoutSource).toContain(
      "forceMountFeatureContent={location.pathname === '/cc-agent/new'}",
    );
  });

  it('invalidates an in-flight folder restore before applying a same-route dialogue target', () => {
    const effectStart = newMakerDraftRouteSource.indexOf(
      '// “对话”分组可能在 /cc-agent/new 已经打开时再次导航到同一路由',
    );
    const effectEnd = newMakerDraftRouteSource.indexOf(
      '// 弹窗确认添加后的落点',
      effectStart,
    );
    const effect = newMakerDraftRouteSource.slice(effectStart, effectEnd);
    const invalidateAt = effect.indexOf('modePickerSelectionSeqRef.current += 1;');
    const applyAt = effect.indexOf('applyDraftTarget({');

    expect(invalidateAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(invalidateAt);
  });

  it('keeps dialogue outside of the project group in the picker menu', () => {
    const topHeadingIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.dialogueOrSelectProject')",
    );
    const dialogueOptionIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.dialogue')",
    );
    const projectsHeadingIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.projects')",
    );

    expect(topHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(dialogueOptionIndex).toBeGreaterThan(topHeadingIndex);
    expect(projectsHeadingIndex).toBeGreaterThan(dialogueOptionIndex);
    expect(folderPickerPopoverSource).toContain("t('newChat.folderPicker.browseProjectFolder')");
  });

  it('keeps route-local placeholder state out of CREATE AGENT after sidebar ownership moved to the app shell', () => {
    expect(newMakerDraftRouteSource).not.toContain(
      'getWorkspacePromptFromRouteState(location.state)',
    );
    expect(newMakerDraftRouteSource).not.toContain("setWorkspacePrompt('dialogue')");
    expect(newMakerDraftRouteSource).not.toContain("workspacePrompt === 'generic'");
    expect(newMakerDraftRouteSource).not.toContain(
      '[location.key, location.state, routeWorkspacePrompt]',
    );
  });

  it('hides worktree controls for pure-dialogue drafts without a selected project', () => {
    // advancedHidden 把 "project 模式 + 无 cwd" 归到 dialogue 上下文,
    // 让联合控件 / effectiveWorktreeEnabled 用同一个 flag 拦掉。
    expect(worktreeChipsSource).toContain(
      "const advancedHidden = folderPickerMode === 'project' && !cwd",
    );
    expect(worktreeChipsSource).toContain(
      'const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled',
    );
  });

  it('keeps the worktree checkbox owned by direct checkbox interaction alone', () => {
    // 勾选状态只属于用户——
    //  1) 组件内不存在任何 useEffect 自动改写 enabled 的路径(资格变化不改状态;
    //     OFF 时禁止开启，旧 ON 仍保留显式关闭入口;旧 handleAutoDisable 不得复活);
    //  2) 用户点击 checkbox → 写穿工作端记忆(本地专用单字段 setter /
    //     device-link 远程 apply-new-maker-worktree-pref);
    //  3) 分支选择只修改源分支,永远不调用 onEnabledChange;
    //  4) checkbox 原样直出记忆(播种无 baseRepo 点亮门槛),资格未就绪时
    //     发送侧保留输入并阻塞创建,绝不静默降级到普通 session。
    expect(worktreeChipsSource).not.toContain('handleAutoDisable');
    expect(worktreeChipsSource).not.toMatch(/useEffect\([^)]*onEnabledChange/s);
    expect(worktreeChipsSource).toContain('onToggle={onEnabledChange}');
    expect(worktreeChipsSource).not.toContain("'branch-pick'");
    expect(branchPickSource).not.toContain("kind: 'enable-worktree'");
    expect(branchPickSource).not.toContain("kind: 'disable-worktree'");
    expect(newMakerDraftRouteSource).toContain("'maker:apply-new-maker-worktree-pref'");
    expect(newMakerDraftRouteSource).toContain('setWorktreePreference(enabled)');
    expect(worktreeChipsSource).not.toContain('onSourceBranchChange(branches.current)');
    expect(worktreeChipsSource).toContain(
      'const switchDisabled = disabled || checkboxDisabled || (environmentDisabled && !enabled)',
    );
    // 2026-08-07 裁决:确认不合格(confirmedIneligible === true)时整条控件隐藏、
    // 发送侧放行普通会话;探测中/失败(null)时已 ON 仍显示并 fail closed。
    expect(worktreeChipsSource).toContain('confirmedIneligible !== true');
    expect(worktreeChipsSource).toContain('&& (enabled || !!detect.data?.isGitRepo)');
    const toggleHandler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWtEnabledChange = useCallback('),
      newMakerDraftRouteSource.indexOf('const handleWtSourceBranchChange = useCallback('),
    );
    expect(toggleHandler.indexOf('setWtEnabled(enabled)')).toBeGreaterThan(
      toggleHandler.indexOf("'maker:apply-new-maker-worktree-pref'"),
    );
    expect(newMakerDraftRouteSource).toContain(
      "if (typeof remotePreference === 'boolean') setWtEnabled(remotePreference);",
    );
    expect(newMakerDraftRouteSource).toContain(
      'if (isDeviceLinkDraft) setWtEnabled(false);',
    );
    expect(newMakerDraftRouteSource).toContain('wt.enabled && wt.baseRepo');
    const sendGuardStart = newMakerDraftRouteSource.indexOf(
      '&& selectedWorktree.confirmedIneligible !== true',
    );
    expect(sendGuardStart).toBeGreaterThan(-1);
    const sendGuard = newMakerDraftRouteSource.slice(
      sendGuardStart,
      newMakerDraftRouteSource.indexOf('const dataOwnerAtSend = getDataOwnerGeneration();'),
    );
    expect(sendGuard).toContain('worktreeMissingRepo');
    expect(sendGuard).toContain('!selectedWorktree.branchPreferenceReady');
    expect(sendGuard).toContain('selectedWorktree.supportsRecoveryKeyDiscard !== true');
    expect(sendGuard).toContain('return false;');
  });

  it('only forwards a worktree-eligible repo root to fail-closed creation gates', () => {
    // linked worktree、非 Git 目录和探测失败都不能把 repoRoot 暴露给发送 / Goal；
    // checkbox 仍保留用户输入，由上层 ON 门明确阻塞，不能静默降级成 base-repo 创建。
    // baseRepo 与 confirmedIneligible 从共享的 gitEligible 派生,保证两处使用同一条件。
    expect(worktreeChipsSource).toContain('const gitEligible: boolean | null = detect.data');
    expect(worktreeChipsSource).toContain('detect.data.gitInstalled && detect.data.isGitRepo && !detect.data.isInsideWorktree');
    expect(worktreeChipsSource).toContain('const baseRepo = gitEligible ? (detect.data!.repoRoot ?? null) : null;');
  });

  it('mirrors the repo-scoped source branch through the selected working device', () => {
    // baseRepo ready 后才读：本机走 preload，device-link 草稿走被控端 invoke。
    expect(newMakerDraftRouteSource).toContain(
      'window.electronAPI.getNewMakerWorktreeBranchPreference(wtBaseRepo)',
    );
    expect(newMakerDraftRouteSource).toContain(
      "'maker:get-new-maker-worktree-branch-pref'",
    );
    // 选择同样写回工作端；两条路径返回的权威 snapshot 进入同一 revision fence。
    expect(newMakerDraftRouteSource).toContain(
      'window.electronAPI.applyNewMakerWorktreeBranchPreference(',
    );
    expect(newMakerDraftRouteSource).toContain(
      "'maker:apply-new-maker-worktree-branch-pref'",
    );
    expect(newMakerDraftRouteSource).toContain(
      'snapshot.revision < previous.revision',
    );
    expect(newMakerDraftRouteSource).toContain(
      'sameDraftWorktreeBranchTarget(requestTarget, currentTarget)',
    );
    // 本机 push 与远端转发 push 都消费同名 host snapshot；远端额外按 deviceId 过滤。
    expect(newMakerDraftRouteSource).toContain(
      'window.electronAPI.onNewMakerWorktreeBranchChanged(',
    );
    expect(newMakerDraftRouteSource).toContain(
      "push.channel !== 'maker:new-maker-worktree-branch:changed'",
    );
    expect(newMakerDraftRouteSource).toContain(
      'push.deviceId !== target.deviceId',
    );
    // GET 未完成时分支半区独立禁用；checkbox 半区不受 branch 读写状态牵连。
    expect(newMakerDraftRouteSource).toContain('disabled={wtCreating || sendInFlight}');
    expect(newMakerDraftRouteSource).toContain(
      'branchDisabled={wtBranchPreferenceLoading || wtBranchPreferenceSaving}',
    );
    expect(newMakerDraftRouteSource).toContain(
      'checkboxDisabled={wtPreferenceSaving}',
    );
    // null / 明确旧端不支持才能降级；malformed / transient errors 保持未就绪。
    expect(newMakerDraftRouteSource).toContain('if (snapshot === null) {');
    expect(newMakerDraftRouteSource).toContain(
      'if (isWorktreeBranchPreferenceChannelUnsupported(error)) {',
    );
    expect(newMakerDraftRouteSource).toContain('wtBranchPreferenceErrorRef.current = true;');

    const branchHandler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWtSourceBranchChange = useCallback('),
      newMakerDraftRouteSource.indexOf('const handleWtBaseRepoChange = useCallback('),
    );
    expect(branchHandler).not.toContain('setWtEnabled(');
    expect(branchHandler).not.toContain('setWorktreePreference(');
  });

  it('treats checkbox and branch host writes as independent creation transactions', () => {
    const sendStart = newMakerDraftRouteSource.indexOf('const handleSend = useCallback(');
    const goalStart = newMakerDraftRouteSource.indexOf('const handleCreateGoal = useCallback(');
    const send = newMakerDraftRouteSource.slice(sendStart, goalStart);
    const goal = newMakerDraftRouteSource.slice(goalStart);

    // Checkbox APPLY is a bidirectional gate. Branch APPLY only gates when the
    // current checkbox intent is ON, so OFF can still create a base-repo task.
    for (const flow of [send, goal]) {
      expect(flow).toContain('wtPreferenceSavingRef.current');
      expect(flow).toContain('wtPreferenceAuthorityUnknownRef.current');
      expect(flow).toContain(
        'selectedWorktree.enabled && wtBranchPreferenceSavingRef.current',
      );
    }
    expect(newMakerDraftRouteSource).toContain('wtPreferenceWriteChainRef.current');
    expect(newMakerDraftRouteSource).toContain('wtBranchWriteChainRef.current');
    expect(newMakerDraftRouteSource).toContain('wtBranchWriteSeqRef.current');
  });

  it('only commits a branch write after host authority observes that exact requested branch', () => {
    const branchHandler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWtSourceBranchChange = useCallback('),
      newMakerDraftRouteSource.indexOf('const handleWtBaseRepoChange = useCallback('),
    );

    // A successful invoke is not sufficient: its snapshot must both advance
    // the revision seen at write start and contain this exact requested branch.
    expect(branchHandler).toContain('parsedSnapshot!.sourceBranch === normalized');
    expect(branchHandler).toContain('parsedSnapshot!.revision > revisionAtStart');

    // Both the resolved-invalid-payload and rejected/lost-ACK reconciliation
    // paths may use a concurrent push, but only when it confirms the same branch.
    expect((branchHandler.match(/current\.sourceBranch === normalized/g) ?? []).length).toBe(2);
    expect(branchHandler).not.toContain('armWtBranchCommittedValue(parsedSnapshot!.sourceBranch)');
    expect(branchHandler).not.toContain('armWtBranchCommittedValue(current.sourceBranch)');

    // A newer authoritative value for another branch remains the retry floor;
    // it must not release the create fence or replace the user's requested UI.
    expect(branchHandler).not.toContain('wtBranchSyncRef.current = null;');
    expect(branchHandler).toContain('setWtSourceBranch(normalized);');
    expect(branchHandler).toContain('setWtBranchPreferenceError(true);');
  });

  it('creates managed worktrees before starting either local or device-link goals', () => {
    const goal = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleCreateGoal = useCallback('),
    );
    const localCreate = goal.indexOf('const newSession = await createSession({');
    const localWorktree = goal.indexOf('await prepareLocalGoalWorktree({', localCreate);
    const localSetGoal = goal.indexOf('await window.electronAPI.maker.setGoal(', localWorktree);
    expect(localCreate).toBeGreaterThan(-1);
    expect(localWorktree).toBeGreaterThan(localCreate);
    expect(localSetGoal).toBeGreaterThan(localWorktree);

    const remoteWorktree = goal.indexOf("invokeRemote('worktree:create'");
    const remoteClaim = goal.indexOf('createRemoteSessionWithPrecreatedWorktree({', remoteWorktree);
    const pendingGoal = goal.indexOf('setPendingGoal(remoteSessionId', remoteClaim);
    expect(goal.indexOf('recoverPendingRemotePrecreatedWorktrees({')).toBeGreaterThan(-1);
    expect(remoteWorktree).toBeGreaterThan(-1);
    expect(remoteClaim).toBeGreaterThan(remoteWorktree);
    expect(pendingGoal).toBeGreaterThan(remoteClaim);
  });

  it('merges branch and worktree into a single joined pill (Claude Code style)', () => {
    // 2026-07-29 用户裁决:[⎇ 分支 │ ☑ worktree] 是一个 pill、两个点击区;
    // 分支选择与 checkbox 独立,未勾时也可先选源分支;悬停任一半区时分隔线隐去。
    expect(worktreeChipsSource).toContain('function BranchWorktreeChip');
    expect(worktreeChipsSource).toContain('data-testid="create-agent-branch-worktree"');
    expect(worktreeChipsSource).toContain(
      '!(disabled || branchDisabled || environmentDisabled) && baseRepo !== null',
    );
    expect(worktreeChipsSource).toContain('aria-disabled={!branchInteractive}');
    expect(worktreeChipsSource).toContain('tabIndex={branchInteractive ? 0 : -1}');
    expect(worktreeChipsSource).not.toMatch(/\n\s+disabled=\{!branchInteractive\}/);
    expect(worktreeChipsSource).toContain(
      "const branchLabel = sourceBranch || branches.current || currentBranch || 'HEAD'",
    );
    expect(worktreeChipsSource).toContain(
      'effectiveWorktreeEnabled || branchListWanted ? baseRepo : null',
    );
    expect(worktreeChipsSource).not.toContain(
      'useBranches(effectiveWorktreeEnabled ? baseRepo : null',
    );
    expect(worktreeChipsSource).toContain('checked || branchSourceSelected');
    expect(worktreeChipsSource).toContain('group-hover:opacity-0');
    expect(worktreeChipsSource).not.toContain('function BranchChip');
    expect(worktreeChipsSource).not.toContain('function WorktreeChip(');
  });

  it('keeps remote project drafts out of local workspace probes', () => {
    expect(newMakerDraftRouteSource).toContain('if (wd && !isRemoteProjectDraft');
    // device-link 草稿的 git 探测经隧道在被控端执行(本机 git 对远程路径必然误报);
    // SSH(worktreeDisabled)仍不探测。
    expect(worktreeChipsSource).toContain('deviceLinkReconnectEpoch,');
    expect(newMakerDraftRouteSource).toContain(
      'deviceLinkReconnectEpoch={remoteDraftRefreshEpoch}',
    );
    expect(worktreeChipsSource).toContain(
      "sourceBranch || branches.current || currentBranch || 'HEAD'",
    );
    expect(worktreeChipsSource).not.toContain("sourceBranch || branches.current || 'main'");
  });

  it('invalidates worktree probe-derived fields when the selected project changes', () => {
    const start = newMakerDraftRouteSource.indexOf('const handleWorkingDirChange');
    const end = newMakerDraftRouteSource.indexOf('// ─── 新草稿入场', start);
    const handler = newMakerDraftRouteSource.slice(start, end);
    const actionStart = newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback(');
    const actionEnd = newMakerDraftRouteSource.indexOf('// 弹窗确认添加后的落点', actionStart);
    const action = newMakerDraftRouteSource.slice(actionStart, actionEnd);

    expect(handler).toContain('applyDraftTarget({');
    expect(action).toContain('if (deviceChanged || workingDirChanged)');
    expect(action).toContain('setWtBaseRepo(null)');
    expect(action).toContain("setWtSourceBranch('')");
  });

  it('wires the remote project entry into the CREATE AGENT mode-pill picker', () => {
    // 2026-07-22 恢复「添加远程项目」入口(用户裁决,488cb33 对齐 Figma 时删除,声称移到
    // 应用外壳/共享弹窗但该新家从未落地 → 入口整套变孤儿死代码)。与 2026-07-19 worktree
    // 高级入口的恢复同款处理:入口就在 mode pill 的 FolderPickerPopover 里(Globe 项),
    // gate 走 hasAnyRemoteTarget(SSH ready 主机 或 device-link 可控设备),不新绘 sidebar chrome。
    expect(newMakerDraftRouteSource).toContain('import { useHasAnyRemoteTarget }');
    expect(newMakerDraftRouteSource).toContain(
      'const hasAnyRemoteTarget = useHasAnyRemoteTarget()',
    );
    expect(newMakerDraftRouteSource).toContain('onAddRemoteProject={');
    expect(newMakerDraftRouteSource).toContain('hasAnyRemoteTarget || folderPickerDeviceScope');
    // #807 方案 B:设备提成 pill 上的一级维度,项目区只列**当前设备**的项目(不再跨设备分组)。
    expect(newMakerDraftRouteSource).toContain('projectOptions={activeProjectOptions}');
    expect(newMakerDraftRouteSource).toContain('deviceScope={folderPickerDeviceScope}');
    expect(deviceLinkProjectsHookSource).toContain('loadDeviceLinkExistingProjects(deviceId)');
    expect(deviceLinkProjectsHookSource).toContain('removeDeviceLinkExistingProject(');
    expect(deviceLinkProjectsHookSource).toContain("status: 'error'");
    expect(deviceLinkProjectsHookSource).toContain('retry: () => void');
    expect(folderPickerPopoverSource).toContain("deviceScope?.status === 'error'");
    expect(folderPickerPopoverSource).toContain(
      "t('newChat.folderPicker.remoteProjectsLoadFailed'",
    );
    expect(folderPickerPopoverSource).toContain("t('newChat.folderPicker.retryRemoteProjects')");
    // 弹窗统一两类来源:SSH ready hosts + device-link 可控设备(optgroup 区分)。
    expect(addRemoteProjectDialogSource).toContain("res.hosts.filter((h) => h.status === 'ready')");
    expect(addRemoteProjectDialogSource).toContain('useControllableDevices()');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupSsh');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupDevice');
    expect(addRemoteProjectDialogSource).not.toContain('res.hosts.filter((h) => h.autoConnect)');
    // 归属一致:device-link 建会话参数只经 resolveDeviceLinkSubmission 组装(它内部转调
    // buildDeviceLinkCreateArgs 派生 workspaceKind),行为由 deviceLinkCreateArgs.test.ts 断言;
    // 此处锁「route 确实经那个唯一入口」,防有人再内联错 workspaceKind 或绕过来源校准。
    expect(newMakerDraftRouteSource).toContain('resolveDeviceLinkSubmission({');
    // 组件不得直接调底层组装函数 —— 那样就绕开了来源校准这一步(第 25 轮缺陷的形状)。
    expect(newMakerDraftRouteSource).not.toContain('buildDeviceLinkCreateArgs({');
  });

  // codex review P1:Pi 是本地专属 agent(startSession 拒绝任何 remoteHostId),SSH 目标
  // 会建出永远起不来的会话。两道防线:dialog 按 agentVendor 过滤掉 SSH 主机(proactive),
  // handleRemoteProjectAdded 的 SSH 分支再 fail-closed 兜底(防非 UI 路径漏进 Pi+SSH)。
  // codex review P2:Pi 二进制缺失时 buildPiAgent() 返回 null → agent map 无 pi,但模型目录仍
  // 投影 Pi。创建入口必须按 maker:list-available-agents(runtime 注册结果)过滤,否则一路创建到
  // requireAgent 的 not-registered。远程草稿以被控端注册结果为准(hook 传 deviceId 走隧道)。
  it('gates the vendor switcher by runtime-registered agents (list-available-agents)', () => {
    // hook 用权威的 runtime 注册来源,而非模型目录;远程走 device-link 隧道。
    expect(availableAgentsHookSource).toContain('api.listAvailableAgents()');
    expect(availableAgentsHookSource).toContain(
      "dl.invoke(deviceId, 'maker:list-available-agents', [])",
    );
    // claude-code → cc 归一,fail-open(未加载不隐藏)。
    expect(availableAgentsHookSource).toContain("agent === 'claude-code' ? 'cc' : agent");
    // 未加载完成时不隐藏任何入口(loaded 保持 false → 空 hidden)。
    expect(availableAgentsHookSource).toMatch(/loaded/);

    // 开关按 hiddenVendors 过滤 OPTIONS,但保留当前选中段避免"无选中"过渡帧。
    expect(vendorSwitcherSource).toContain('hiddenVendors');
    expect(vendorSwitcherSource).toMatch(
      /opt\.vendor === value \|\| !hiddenVendors\.includes\(opt\.vendor\)/,
    );

    // 路由:以被控端(deviceId)为准计算 hidden;选中值被隐藏时 coerce 到首个可用。
    expect(newMakerDraftRouteSource).toMatch(
      /useAvailableAgents\(\s*effectiveDeviceLinkDeviceId,?\s*\)/,
    );
    expect(newMakerDraftRouteSource).toMatch(/hiddenSwitcherVendors\.includes\(draft\.vendor\)/);

    // 2026-08-12 统一模型选择器(M5):新会话工具条上的引擎下拉常态已撤除(只在
    // device-link 老被控端的降级分支里保留),上面那条 hiddenVendors 断言因此不再是
    // 常态路径的门禁。**门禁没放松,只是换了承载物**:ChatInput 按同一个 runtime 注册
    // 结果算出 unifiedAgents 交给联合列表,未注册的引擎连行都不出现。
    expect(newMakerDraftRouteSource).toContain('hiddenVendors={hiddenSwitcherVendors}');
    expect(chatInputSource).toMatch(/useAvailableAgents\(deviceLinkDeviceId\)/);
    expect(chatInputSource).toContain('unifiedAgents={effectiveUnifiedAgents}');
    // fail-open:注册结果没回来之前不隐藏任何引擎;当前引擎恒在列。
    expect(chatInputSource).toContain('if (!runtimeAgentsLoaded) return undefined;');
    expect(chatInputSource).toContain(
      'kind === agentKind || runtimeAvailableVendors.has(agentKindToVendor(kind)),',
    );
  });

  it('does not hide SSH targets for Pi (Pi SSH remote runtime landed)', () => {
    // dialog:Pi 已支持 SSH 远端(轮 35),不再按 vendor 排除 SSH 主机。
    expect(addRemoteProjectDialogSource).toContain('const excludeSsh = false;');
    // 父层仍把当前 draft.vendor 传进 dialog 驱动目标列表。
    expect(newMakerDraftRouteSource).toContain('agentVendor={draft.vendor}');
    // 兜底不再需要:Pi+SSH 组合合法,路由里不得残留「Pi 仅本地」的拒绝文案。
    expect(newMakerDraftRouteSource).not.toContain("t('ccAgent.draft.piRemoteUnsupported')");
  });

  // #807:设备切换 pill。三条产品裁决写进源码断言,防后续重构悄悄改掉。
  it('wires the device switcher pill and keeps it invisible without paired devices', () => {
    expect(newMakerDraftRouteSource).toContain(
      'const { devices: selectableDevices, loaded: selectableDevicesLoaded } = useSelectableDevices();',
    );
    expect(newMakerDraftRouteSource).toContain('<DeviceSwitcherPill');
    // 没有对端设备 → 组件自己返回 null,只有本机的用户看不到任何新增控件。
    expect(deviceSwitcherPillSource).toContain('if (devices.length === 0) return null');
    // 离线设备列出但禁用 —— 掉线时从列表消失会让用户以为配对丢了。
    expect(deviceSwitcherPillSource).toContain('disabled={!device.online}');
    // 换设备后停在这台设备的「对话」:上一台的项目路径在新机器上基本不存在,
    // 留着会让用户以为项目跟过来了、发送时才在被控端 path guard 上失败。
    expect(newMakerDraftRouteSource).toContain('const handleDeviceChange = useCallback(');
    expect(newMakerDraftRouteSource).toContain(
      'applyDraftTarget({ deviceId, deviceName, workingDir: null });',
    );
  });

  // #807:跨设备纯对话。放宽后「选了设备」单独成立即可整套走对端(能力/provider/创建同口径),
  // 修掉「模型列表来自对端、会话却建在本机」的不一致。
  it('treats a picked device alone as a device-link draft so cross-device dialogues work', () => {
    expect(newMakerDraftRouteSource).toContain(
      'const isDeviceLinkDraft = effectiveDeviceLinkDeviceId != null',
    );
    expect(newMakerDraftRouteSource).toContain(
      'if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {',
    );
    // 远程纯对话没有 repo:即使 wtEnabled 残留 true 也必须跳过 worktree 分支。
    expect(newMakerDraftRouteSource).toMatch(/&&\s*wt\.supportsRecoveryKeyDiscard === true/);
    expect(newMakerDraftRouteSource).toContain(
      'onRecoveryKeyDiscardSupportChange={handleWtRecoveryKeyDiscardSupportChange}',
    );
    expect(worktreeChipsSource).toContain('detect.data.supportsRecoveryKeyDiscard === true');
  });

  // #807 review 修复:新建目标必须与普通发送同口径 —— 远程纯对话下不能因为缺 workingDir 就抛错。
  it('lets goal creation accept a device-only draft (same shape as normal send)', () => {
    expect(newMakerDraftRouteSource).not.toContain(
      'if (!effectiveDeviceLinkDeviceId || !effectiveWorkingDir) {',
    );
    expect(newMakerDraftRouteSource).toContain('if (!effectiveDeviceLinkDeviceId) {');
    expect(newMakerDraftRouteSource).toContain('workingDir: remoteWorkingDir,');
  });

  // #807 review 修复:换工作区必须显式回传当前设备。store 的不变量是「改 workingDir 又不带
  // 设备字段就清设备」,不显式带会让选「对话」/换项目把设备悄悄清回本机。
  it('carries the current device when only the workspace changes', () => {
    // 工作区 picker 原样回传当前设备 → 转移动作判出 deviceChanged=false,只处理「换项目」那一半。
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWorkingDirChange = useCallback('),
    );
    const body = handler.slice(0, handler.indexOf('    [applyDraftTarget'));
    expect(body).toContain('deviceId: draft.deviceLinkDeviceId,');
    expect(body).toContain('workingDir: dir,');
    // 而那个动作**总是**显式带上设备字段,所以这条不变量对四条路径一次性成立,
    // 不再依赖每个调用方各自记得拼一个 keepDevice。
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    expect(action).toContain('deviceLinkDeviceId: req.deviceId,');
    expect(action).toContain('deviceLinkDeviceName: req.deviceName,');
  });

  // #807 review 修复:设备真正从可选列表消失时把草稿收敛回本机,避免显示与实际目标不一致。
  it('falls back to local when the selected device is no longer selectable', () => {
    expect(newMakerDraftRouteSource).toContain(
      'if (selectableDevices.some((d) => d.deviceId === effectiveDeviceLinkDeviceId)) return;',
    );
    // 判据是「拉到过权威快照」而非「列表非空」—— 详见 distinguishes a loaded-empty… 用例。
    expect(newMakerDraftRouteSource).toContain('if (!selectableDevicesLoaded) return;');
  });

  // #807 review 修复:远程删除失败 + 权威回读也失败时,必须把行放回去,不留幻影删除。
  it('restores the optimistically removed row when both remove and reload fail', () => {
    expect(deviceLinkProjectsHookSource).toContain('const restored = removedRow;');
    expect(deviceLinkProjectsHookSource).toContain('removedIndex');
  });

  // #807 review 第二轮:远程设备语境下「选择其他项目文件夹」不能开本机原生目录对话框 ——
  // 选出来的是控制端路径,配上远程 deviceId 发送时要么被 path guard 拒,要么在对端一个
  // 毫不相关的同名目录里建会话。
  it('routes folder browsing through the selected device instead of the local native picker', () => {
    expect(folderPickerPopoverSource).toContain('if (deviceScope) {');
    expect(folderPickerPopoverSource).toContain('onAddRemoteProject?.(deviceScope.deviceId);');
  });

  /**
   * 2026-07-30 用户真机反馈:选定远程设备后不该再出现「添加远程项目」。
   *
   * 不只是文案冗余 —— 那一项调 `onAddRemoteProject()` **不带 deviceId**,弹窗会让用户从头重选
   * 目标,于是可以从设备 A 的语境里点一个叫「添加远程项目」的入口、选到设备 B,等于绕过设备 pill
   * 改掉了设备这一级维度,而 #807 方案 B 的前提正是「设备由设备 pill 独占」。
   * 同一语境下「选择其他项目文件夹」已经承担了浏览对端文件夹的职责(见上一条用例)。
   */
  it('hides the add-remote-project entry once a device is selected', () => {
    // 条件里必须有 !deviceScope —— 这是这条行为的全部实现。
    expect(folderPickerPopoverSource).toContain(
      '{isProjectPicker && onAddRemoteProject && !deviceScope && (',
    );
    // 那一项就是不带设备身份的那次调用;它只应出现在本机语境。
    expect(folderPickerPopoverSource).toContain('onAddRemoteProject();');
    // 空态入口不受影响:仍然渲染,且**带**设备身份(否则又变成一个能换设备的入口)。
    const emptyState = folderPickerPopoverSource.slice(
      folderPickerPopoverSource.indexOf('deviceScope && onAddRemoteProject ? ('),
    );
    expect(emptyState.slice(0, emptyState.indexOf(') : ('))).toContain(
      'onAddRemoteProject(deviceScope.deviceId);',
    );
    // 上层仍要在已选设备时下发 onAddRemoteProject —— 入口 1 与空态入口都靠它,
    // 只是那个 Globe 项不再渲染。别顺手把这个 gate 一起收掉。
    expect(newMakerDraftRouteSource).toMatch(
      /hasAnyRemoteTarget \|\|\s*folderPickerDeviceScope\s*\?\s*handleOpenRemoteProject\s*:\s*undefined/,
    );
  });

  // #807 review 第二轮:空列表必须区分「还没拉到」与「拉到了确实没有」。唯一对端被解除配对时
  // 列表会合法变空,若按「非空」gate,回落永远不触发,草稿会永久指着一台已消失的设备。
  it('distinguishes a loaded-empty device snapshot from a not-yet-loaded one', () => {
    expect(controllableDevicesHookSource).toContain(
      'export function useSelectableDevices(): { devices: SelectableDevice[]; loaded: boolean }',
    );
    // 拉取失败(device-link 不可用)的空不作数,不得据此清掉用户选定的设备。
    expect(controllableDevicesHookSource).toContain('setLoaded(false);');
    expect(newMakerDraftRouteSource).toContain('if (!selectableDevicesLoaded) return;');
    expect(newMakerDraftRouteSource).not.toContain('if (selectableDevices.length === 0) return;');
  });

  // #807 review 第二轮:换机器 = 换文件系统,@file/@dir chip 指的是上一台机器的路径。
  it('strips filesystem mention chips when switching devices', () => {
    expect(newMakerDraftRouteSource).toContain(
      'const composerDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);',
    );
    expect(newMakerDraftRouteSource).toContain('text: stripLocalMentionChips(composerDraft.text),');
  });

  // #807 review 第三轮:点已选中的那一行只是确认当前选择,不能有副作用 —— 否则用户点一下
  // 就静默丢掉已选项目和部分已写好的消息(mention chip 被剥、workingDir/extraDirs 被清)。
  it('ignores reselecting the current device before touching either draft store', () => {
    expect(newMakerDraftRouteSource).toContain(
      'if (deviceId === (effectiveDeviceLinkDeviceId ?? null)) return;',
    );
  });

  // #807 review 第三轮:并发删除时恢复不能按 requestId gate —— 删除按钮不禁用,快速删两行会让
  // 第二次重写共享 requestIdRef,第一次的恢复被跳过,那一行会一直从选择器消失(对端其实还在)。
  it('restores concurrently removed rows without gating on the shared request id', () => {
    const tail = deviceLinkProjectsHookSource.slice(
      deviceLinkProjectsHookSource.indexOf('const restored = removedRow;'),
    );
    expect(tail).not.toContain('requestIdRef.current !== requestId');
    // 靠插回前的存在性检查保证幂等,而不是靠版本号。
    expect(deviceLinkProjectsHookSource).toContain(
      'if (current.some((row) => row.path === restored.path)) return;',
    );
  });

  // #807 review 第十三 / 二十三轮:「标着 B 的 A 的项目」这条最初靠「切设备时立刻清空 rows」挡,
  // 但那依赖 effect 先于渲染 —— passive effect 在 paint 之后才跑,于是仍有一帧会把 A 的路径包成
  // 属于 B 的可点击选项(Greptile 抓到)。现在改成结构性保证:行连同归属设备一起存,memo 只在
  // 归属相符时输出。逐帧行为断言在 deviceLinkProjectsConcurrency.test.tsx。
  it('binds loaded rows to their owning device so a mismatch cannot be rendered', () => {
    expect(deviceLinkProjectsHookSource).toContain('const [loaded, setLoaded] = useState<{');
    // 写入必须申明归属 —— 没有「只改 rows 不改归属」的调用形态。
    expect(deviceLinkProjectsHookSource).toContain(
      'const commitRows = useCallback((ownerDeviceId: string | null, next: ExistingRemoteProject[])',
    );
    // memo 的归属守卫:这是把 deviceId 绑进状态的唯一目的。
    expect(deviceLinkProjectsHookSource).toContain('deviceId && loaded.deviceId === deviceId');
    // 请求态也必须绑定归属设备：归属没对上或还没发起时仍算加载中，
    // 避免切设备那一帧闪「没有项目」空态，也避免上一台的失败串过来。
    expect(deviceLinkProjectsHookSource).toContain(
      "requestState.deviceId !== deviceId || requestState.status === 'idle'",
    );
    expect(deviceLinkProjectsHookSource).toContain("loading: status === 'loading'");
  });

  // #807 review 第十四轮:恢复路径不能依赖 React 的调度时机。`setRows(updater)` 的 updater
  // 只在 React 处理更新时才跑,而「删除失败 + 回读失败」的恢复要在两次 await 之间就拿到被移除
  // 的行 —— 从 updater 副作用取值可能读到 undefined(Copilot review),`if (!restored) return`
  // 于是把恢复整个跳过,幻影删除又回来了。改由同步镜像 rowsRef 供数,写入统一走 commitRows。
  it('captures the removed row from a synchronous mirror, not a setState updater side effect', () => {
    expect(deviceLinkProjectsHookSource).toContain('const loadedRef = useRef<{');
    expect(deviceLinkProjectsHookSource).toContain(
      'loadedRef.current = { deviceId: ownerDeviceId, rows: next };',
    );
    // 读镜像时同时校验归属:归属不符说明当前显示的已是别的设备的行,乐观移除会改错列表。
    expect(deviceLinkProjectsHookSource).toContain(
      'const before = loadedRef.current.deviceId === target.deviceId ? loadedRef.current.rows : [];',
    );
    // 被移除的行与位置都从镜像同步算出,不再靠 updater 的副作用赋值。
    expect(deviceLinkProjectsHookSource).toContain(
      'const removedIndex = before.findIndex((row) => row.path === option.path);',
    );
    // 状态只由 commitRows 写(唯一一处 `setLoaded(loadedRef.current)`)。留任何一个裸 setLoaded
    // 就还有一条镜像与状态不同步、或归属未申明的路。
    const bareSet =
      deviceLinkProjectsHookSource.match(/setLoaded\((?!loadedRef\.current\))/g) ?? [];
    expect(bareSet.length).toBe(0);
  });

  // #807 review 第十五轮:picker 换项目必须作废 worktree 的 repo/branch 探测结果。baseRepo
  // 由 WorktreeChipsRow 经 detect-cwd 异步回填(远程还要走隧道),回填前发送不能把 worktree 建到
  // 上一个 repo;sourceBranch 只在为空时才自动填充,用户在 A 上显式选的分支不能跟到 B。
  it('invalidates worktree state when the project picker switches workspaces', () => {
    // 换工作区 = 换 repo,只清掉 repo/branch 探测态;worktreeEnabled 是工作端拥有的用户偏好,
    // 不能因换项目被静默抹掉。
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    const wt = action.slice(action.indexOf('if (deviceChanged || workingDirChanged) {'));
    const block = wt.slice(0, wt.indexOf('      }'));
    expect(block).not.toContain('setWtEnabled(false);');
    expect(block).toContain('setWtBaseRepo(null);');
    expect(block).toContain("setWtSourceBranch('');");
  });

  // #807 review 第十四轮:compact 模式下按钮只剩图标 + 状态点,不渲染设备名 —— aria-label 只报
  // 「设备」的话读屏用户无从得知当前选的是哪台机器。
  it('announces the selected device in the switcher aria-label', () => {
    expect(deviceSwitcherPillSource).toContain(
      "const triggerLabel = `${t('newChat.deviceSwitcher.label')}: ${label}`;",
    );
    expect(deviceSwitcherPillSource).toContain('aria-label={triggerLabel}');
  });

  // #807 review 第十四轮:注释与实现必须一致 —— 早前几轮把「指名设备不在目标里就留空」改对了,
  // 但 JSDoc 还写着 falls back to the first available target,会误导后续维护者改回静默换机器。
  it('documents that an explicitly requested device never falls back', () => {
    expect(addRemoteProjectDialogSource).not.toContain('falls back to the first available target');
    expect(addRemoteProjectDialogSource).toContain('**指名了就只认这一台**');
  });

  // #807 review 第十三轮:同一台机器上换项目不得重置运行配置与引用目录 —— 上一轮只 gate 了
  // mention chip,dlSel 与 extraDirs 仍被无条件打回默认值,用户选的远程模型/来源/权限和加好的
  // 引用目录会静默丢失。
  it('preserves runtime selection and extra dirs when browsing the same device', () => {
    const actionStart = newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback(');
    const action = newMakerDraftRouteSource.slice(
      actionStart,
      newMakerDraftRouteSource.indexOf('const handleRemoteProjectAdded = useCallback(', actionStart),
    );
    // dlSel 只在换设备时重种;同机保留用户选择(下一条断言它还会按新能力重校)。
    expect(action).toContain('if (deviceChanged) {\n          setDlSel(\n');
    // extraDirs 只在换设备、或进入「对话」时清 —— 同机换项目那些目录仍然有效,
    // 不传则 store 保持原值。
    expect(action).toContain(
      '...(deviceChanged || req.workingDir == null ? { extraDirs: [] } : {}),',
    );
    // 但 worktree 的 repo/branch 探测态照常重置 —— 换项目就是换 repo；用户偏好保留。
    expect(action).toContain('if (deviceChanged || workingDirChanged) {');
    expect(action).not.toContain('setWtEnabled(false);');
  });

  // #807 review 第十二轮:in-flight 保护要覆盖**工作区** pill,不只是设备 pill —— 否则用户点了
  // Send 还能从远程项目 X 切到 Y,会话建在 X 里、刚选的 Y 又被 create 后的重置清掉。
  it('disables and guards workspace switching while a send is in flight', () => {
    // 设备、工作区以及本次创建会消费的 worktree 配置都要冻结。
    expect(
      (newMakerDraftRouteSource.match(/disabled=\{wtCreating \|\| sendInFlight\}/g) ?? []).length,
    ).toBe(3);
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleModePickerSelect = useCallback('),
    );
    expect(handler.slice(0, handler.indexOf('handleWorkingDirChange('))).toContain(
      'if (sendInFlightRef.current) return;',
    );
    for (const marker of [
      'const handleWtEnabledChange = useCallback(',
      'const handleWtSourceBranchChange = useCallback(',
    ]) {
      const worktreeHandler = newMakerDraftRouteSource.slice(
        newMakerDraftRouteSource.indexOf(marker),
      );
      expect(worktreeHandler.slice(0, worktreeHandler.indexOf('\n  const ', 1))).toContain(
        'if (sendInFlightRef.current) return;',
      );
    }
  });

  /**
   * ⚠️ 这条的结论在第 29 轮被**推翻**了,保留原委作为记录。
   *
   * 第十二轮我判断「同一台机器上换项目不该剥 mention chip —— 文件系统没变」,并据此加了 gate。
   * 那个判断建立在一个错误前提上:以为 chip 存绝对路径。实际上 ChatInput 把 file/dir chip 的
   * `path` 存成**项目相对**路径(`attrs.path = item.relPath`,源码注释原文「for files/dirs we
   * stash the relative path as-is」),agent chip 是 `.claude/agents/<name>.md`,同样相对。
   *
   * 于是解析基准是 workingDir 而不是文件系统:同机从项目 X 换到 Y,`@src/foo.ts` 会解析到 Y 里的
   * 同名文件。这比换设备更隐蔽 —— `src/index.ts`、`.claude/agents/reviewer.md` 这类路径在同机两个
   * 项目间恰好都存在的概率相当高,agent 于是读到毫不相关的内容而没有任何报错。
   *
   * 现在 chip 按 `deviceChanged || workingDirChanged` 剥;而路径型**附件**(存绝对路径)仍然只在
   * 换设备时丢 —— 原先两件事共用一个条件,所以必然有一边是错的。
   */
  it('strips project-relative mention chips whenever the project changes, not just the device', () => {
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    expect(action).toContain(
      'if (deviceChanged || workingDirChanged) stripProjectRelativeMentions();',
    );
    // 附件是另一个条件 —— 别再把这两件事合回一个 gate。
    expect(action).toContain('if (deviceChanged) dropPathBackedAttachments();');
    // 拆分后的两个函数各自绑住自己的解析基准,注释里写明了理由。
    expect(newMakerDraftRouteSource).toContain('const stripProjectRelativeMentions = useCallback(');
    expect(newMakerDraftRouteSource).toContain('const dropPathBackedAttachments = useCallback(');
    // 旧的合并式 helper 必须消失,否则又会有人按单一条件调它。断言声明与调用两种形态,
    // 而不是裸名字 —— 拆分后的函数注释里会提到这个旧名作为历史记录。
    expect(newMakerDraftRouteSource).not.toContain('const cleanupCrossFilesystemDraftContext');
    expect(newMakerDraftRouteSource).not.toContain('cleanupCrossFilesystemDraftContext()');
  });

  // #807 review 第十二轮:pending 删除集合按设备分层,否则 A 上未结束的 /x 会被当成 B 的待删除项,
  // B 上同名 /x 会被权威列表错误过滤掉。
  it('scopes pending removals per device', () => {
    expect(deviceLinkProjectsHookSource).toContain('useRef<Map<string, Set<string>>>(new Map())');
    expect(deviceLinkProjectsHookSource).toContain(
      'pendingRemovalsRef.current.get(target.deviceId)',
    );
  });

  // #807 review 第十一轮:并发删除时,失败删除的权威回读不能复活另一个仍在飞的乐观删除
  // (B 被复活后,它真的成功时成功路径不再更新状态,于是 B 一直显示到重开 picker)。
  it('preserves other in-flight deletions when a failed removal reloads', () => {
    expect(deviceLinkProjectsHookSource).toContain('pendingRemovalsRef');
    expect(deviceLinkProjectsHookSource).toContain('devicePending.add(option.path);');
    // 减去其它 pending,但不含自己 —— 这次删除失败了,真相里有它就该显示回来。
    expect(deviceLinkProjectsHookSource).toContain('(path) => path !== option.path,');
    // finally 必须清除,否则一次异常会让那条 path 永久被过滤掉。
    expect(deviceLinkProjectsHookSource).toContain('set?.delete(option.path);');
  });

  // #807 review 第十一轮:调用方指名了设备时,弹窗不得回落到别的目标 —— 被指名的那台离线时
  // targets 里没有它,静默落到 targets[0](可能是 SSH 主机或另一台设备)会把草稿切到意外的机器。
  it('never falls back to a different target when a device was explicitly requested', () => {
    expect(addRemoteProjectDialogSource).toContain('if (preferredKey) {');
    expect(addRemoteProjectDialogSource).toContain(
      'setSelectedKey(targets.some((target) => target.key === preferredKey) ? preferredKey : null);',
    );
  });

  // 远程模型目录的 loading / error 与草稿默认值都是创建前置条件：任一路径没就绪
  // 都不能把兜底值提交给对端；真实读取失败还必须告知用户，不能在 loading=false 后放行。
  it('blocks send and goal creation until remote models/defaults are ready, including terminal errors', () => {
    expect(newMakerDraftRouteSource).toContain(
      'capabilitiesError || (deviceProvidersError && !deviceProvidersUnsupported)',
    );
    expect(newMakerDraftRouteSource.match(/remoteModelListStatus !== 'ready'/g)).toHaveLength(2);
    expect(newMakerDraftRouteSource).toContain(
      "toast.error(t('newChat.modelSelector.remoteLoadFailed'))",
    );
    expect(newMakerDraftRouteSource).toContain(
      "throw new Error(t('newChat.modelSelector.remoteLoadFailed'))",
    );
    expect(newMakerDraftRouteSource).toContain("remoteDraftState.status === 'error'");
    expect(newMakerDraftRouteSource).not.toContain('remoteDraftState.loaded');
    expect(newMakerDraftRouteSource).toContain(
      "toast.error(t('ccAgent.draft.remoteDefaultsLoadFailed'))",
    );
    expect(newMakerDraftRouteSource).toContain(
      "throw new Error(t('ccAgent.draft.remoteDefaultsLoadFailed'))",
    );
    expect(newMakerDraftRouteSource).toContain('setRemoteDraftRetryEpoch((value) => value + 1)');
    expect(newMakerDraftRouteSource).toContain("status: unsupported ? 'ready' : 'error'");
    expect(newMakerDraftRouteSource).toContain(
      "if (extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return null;",
    );
  });

  // #807 review 第九轮:设备列表刷新要按请求序号丢弃过期响应。首次加载与两个监听会并发调
  // refresh,REST 响应可能乱序 —— 更早的 listDevices 晚到会把新的权威快照覆盖掉,把刚被解除配对
  // 的设备连同 loaded=true 一起写回来,于是回落认为目标仍有效、picker 也允许再次选中它。
  it('discards superseded device-list refreshes', () => {
    const hook = controllableDevicesHookSource.slice(
      controllableDevicesHookSource.indexOf('export function useSelectableDevices()'),
    );
    const body = hook.slice(0, hook.indexOf('export function useControllableDevices()'));
    expect(body).toContain('const requestId = requestIdRef.current + 1;');
    // 成功与失败两条路径都要 gate,否则过期的失败会误把 loaded 打回 false。
    expect(
      (body.match(/requestIdRef\.current !== requestId/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  // #807 review 第八轮:两处对称性缺口,都是前几轮修复的直接后果。
  it('resets worktree state during the automatic local fallback too', () => {
    // 远程项目开过 worktree、设备随后被解除配对 → wtEnabled/wtBaseRepo 残留 → 下一次本机发送会进
    // worktree 分支,拿上一台设备的仓库路径去建。
    //
    // 回落路径历史上漏得最多(chip、附件、worktree 三态各漏过一次),而且它原先还**隐式**依赖
    // seed effect 的 !isDeviceLinkDraft 分支去清远程运行配置 —— 能跑,但没人能一眼看出为什么。
    // 现在它只是「转移到 本机 + 对话」,所有连带清理由同一个动作按 deviceChanged 推导。
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('selected device is no longer selectable'),
    );
    const body = effect.slice(0, effect.indexOf('  }, ['));
    expect(body).toContain(
      'applyDraftTarget({ deviceId: null, deviceName: null, workingDir: null });',
    );
    // 依赖数组要带上那个动作,否则闭包吃旧的 draft.workingDir / attachments。
    expect(effect.slice(effect.indexOf('  }, ['), effect.indexOf('  }, [') + 200)).toContain(
      'applyDraftTarget',
    );
  });

  it('gates the failed-delete restoration by current device as well', () => {
    // 上一轮为修并发删除去掉了 requestId gate,但没补设备 gate:请求在飞时切到别的设备,
    // 会把 A 的行插进 B 的列表并被标成属于 B —— 选中它就把 A 的路径发给 B。
    const restore = deviceLinkProjectsHookSource.slice(
      deviceLinkProjectsHookSource.indexOf('const restored = removedRow;'),
    );
    expect(restore.slice(0, restore.indexOf('commitRows('))).toContain(
      'if (currentDeviceIdRef.current !== target.deviceId) return;',
    );
  });

  // #807 review 第六轮:发送在途时不能换设备 —— 那次调用的闭包持有旧设备,draft 却切到新设备,
  // 结果会话建在旧设备上并导航过去,同时把刚选的新设备上下文重置掉。
  it('rejects and disables device switching while a send is in flight', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleDeviceChange = useCallback('),
    );
    // ref 而非 state:必须即时可读,不能等下一次渲染。
    expect(handler.slice(0, handler.indexOf('patchDraft('))).toContain(
      'if (sendInFlightRef.current) return;',
    );
    // 同时用同步的 state 禁用 pill(ref 变化不触发渲染)。
    expect(newMakerDraftRouteSource).toContain('disabled={wtCreating || sendInFlight}');
    // ref 与 state 必须一起改,所以赋值统一走 helper。
    expect(newMakerDraftRouteSource).toContain('const markSendInFlight = useCallback(');
    expect(newMakerDraftRouteSource).not.toContain('sendInFlightRef.current = true;');
  });

  // #807 review 第五轮:换设备必须同步失效上一台的远程默认值快照,否则 seed effect 会拿旧
  // capabilities/defaults 种下新设备的 dlSel 并把它记成「已 seed」,新设备真值到达后又被 guard
  // 挡住重种 —— composer 于是向新设备提交上一台的 model / provider / permission。
  it('invalidates the previous device remote-default snapshots before switching', () => {
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    const body = action.slice(0, action.indexOf('      patchDraft({'));
    // 没有 inline 快照(设备 pill / 回落两条路径)且换了设备 → 打回 loading,交给 seed effect。
    const fallback = body.slice(body.indexOf('} else if (deviceChanged) {'));
    expect(fallback).toContain('setDlSel(null);');
    expect(fallback).toContain('dlSeedKeyRef.current = null;');
    expect(fallback).toContain("setRemoteDraftState({ status: 'loading', value: null });");
    // 有 inline 快照(设备域浏览器)则当场 seed,并置 skip flag 避免 effect 再拉一次覆盖掉。
    expect(body).toContain('skipDefaultsRefetchRef.current = true;');
  });

  // #807 review 第四轮:四个死角,都是前几轮修复留下的。
  it('never opens the local picker in a remote scope, even without onAddRemoteProject', () => {
    // 上层按 hasAnyRemoteTarget 下发 onAddRemoteProject,而选中的对端离线且是唯一远程目标时
    // 那个 gate 会变 false —— 判据必须只看 deviceScope,否则又落回本机原生对话框。
    expect(folderPickerPopoverSource).toContain('if (deviceScope) {');
    expect(folderPickerPopoverSource).toContain('onAddRemoteProject?.(deviceScope.deviceId);');
    // 已选定设备时无条件下发入口(设备离线也要能浏览它)。
    expect(newMakerDraftRouteSource).toMatch(
      /hasAnyRemoteTarget \|\|\s*folderPickerDeviceScope\s*\?\s*handleOpenRemoteProject\s*:\s*undefined/,
    );
  });

  it('strips remote mention chips during the automatic local fallback too', () => {
    // 回落时草稿里对着远程机器建的 @file/@dir 必须剥掉,否则下一次本机发送被当成本机路径送进去。
    // 这条以前要求回落 effect **自己**调清理(它绕过了两个显式 handler);现在它走同一个转移动作,
    // 于是「回落 = deviceChanged」这一个事实就同时保证了 chip 与附件都被处理 —— 不必再逐条盯。
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('selected device is no longer selectable'),
    );
    expect(effect.slice(0, effect.indexOf('  }, ['))).toContain(
      'applyDraftTarget({ deviceId: null',
    );
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    expect(action).toContain(
      'if (deviceChanged || workingDirChanged) stripProjectRelativeMentions();',
    );
  });

  it('keeps the last known device rows when listDevices fails', () => {
    // 清空会造成死角:选了远程设备后一次瞬时失败就让 pill 返回 null,而回落 effect 又(正确地)
    // 因为空不权威而不动草稿 —— 草稿仍指着那台设备,UI 上却没有控件能切回本机。
    const catchBlock = controllableDevicesHookSource.slice(
      controllableDevicesHookSource.indexOf('**保留上次已知的设备行**'),
    );
    const untilEnd = catchBlock.slice(0, catchBlock.indexOf('};'));
    expect(untilEnd).toContain('setLoaded(false);');
    expect(untilEnd).not.toContain('setDevices(');
  });

  it('gates the post-delete authoritative reload on device identity, not the shared request id', () => {
    // requestIdRef 被 effect 取数与每次删除共享,快速删两行会让第一次成功的回读被丢弃。
    expect(deviceLinkProjectsHookSource).toContain(
      'if (currentDeviceIdRef.current !== target.deviceId) return;',
    );
  });

  // #807:设备 popover 宽度自适应内容 + 上限截断(2026-07-29 用户裁决)。
  // 不写死固定宽(会无理由地比 trigger 宽),也不绑 trigger 宽度(trigger 只有 80–200px 且随
  // 设备名浮动,绑上去会把设备名 + 状态点 + 离线副文案全挤没)。行内 truncate 负责有限展现。
  it('sizes the device popover to its content with an upper bound, truncating long names', () => {
    expect(deviceSwitcherPillSource).toContain('w-auto min-w-[200px] max-w-[320px]');
    // 截断链路:可收缩的 body + 名字/副文案 truncate + 图标与 check 不参与收缩。
    expect(deviceSwitcherPillSource).toContain('flex min-w-0 flex-1 flex-col items-start');
    expect(deviceSwitcherPillSource).toContain('min-w-0 truncate text-sm font-medium');
  });

  // #807 review 第三轮:能力缓存命中时必须清掉上一目标遗留的 loading —— 漏了会让
  // capabilitiesLoading 永久为 true,而创建页的 send / goal guard 正是看它。
  it('clears inherited loading state when the capability cache hits', () => {
    const hookSource = agentCapabilitiesHookSource.slice(
      agentCapabilitiesHookSource.indexOf('export function useAgentCapabilities('),
    );
    const cachedBranch = hookSource.slice(hookSource.indexOf('const cached = cache.get(key);'));
    const untilReturn = cachedBranch.slice(0, cachedBranch.indexOf('return;'));
    expect(untilReturn).toContain('setLoading(false);');
    expect(untilReturn).toContain('setError(null);');
  });

  // #807 review 第十四轮:被控端 maker:create-session 一返回 sessionId 就是**提交点**。原来两处
  // 远程分支手写 invoke('local-db:sessions:list') + setDeviceSessions 做镜像回流,隧道一抖(被控端
  // DB 刚启动未就绪 / 链路瞬断 / 超时)就抛 —— handleSend 落进外层 catch 报「创建失败」、
  // handleCreateGoal 让 NewGoalDialog 内联报错并保持打开,两者都会让用户重试,于是对端多出第二个
  // 会话、第一个空着永久滞留。回流必须走 refreshRemoteDeviceSessions:它不抛(瞬态退避重试、
  // 永久错误返回 'gave-up'),且认 snapshot epoch、有界快照按 merge 落库。
  it('routes post-create mirror refresh through the non-throwing shared helper', () => {
    // 回流本体现在住在 commitRemoteSessionHandoff 里(见下一条断言:两条路径都只调它),
    // 且是 fire-and-forget —— 见 does not block the handoff on the mirror refresh 那条用例。
    expect(remoteSessionHandoffSource).toContain(
      'void refreshRemoteDeviceSessions(p.deviceId, p.deviceName)',
    );
    // 手写回流必须彻底消失,否则提交点后仍有可抛的一步。
    expect(newMakerDraftRouteSource).not.toContain("'local-db:sessions:list'");
    expect(newMakerDraftRouteSource).not.toContain('setDeviceSessions(');
    // 组件也不该再自己 import 回流函数 —— 它只经共享 helper 使用。issue #1170 之后
    // 有第二个回流触发点(device-link 开协同后要把被控端刚建的 worker session 拉进
    // 镜像),它住在 remoteCollabHandoff 里,同样是 fire-and-forget、同样不在组件内联。
    expect(newMakerDraftRouteSource).not.toContain('refreshRemoteDeviceSessions');
    expect(remoteCollabHandoffSource).toContain('void refreshRemoteDeviceSessions(p.deviceId)');
  });

  // #807 review 第十七轮:归属必须在**回流之前**登记。回流失败(gave-up / superseded)时镜像里
  // 没有这条会话,getSessionDeviceId 返回 undefined,makerApiFor / goalApiFor 就把首条消息与
  // setGoal 发给本机 maker。行为契约本身由 remoteProjectsStore.test.ts 覆盖,这里只钉接线顺序。
  it('pins the remote session origin before refreshing the mirror', () => {
    // 顺序不变量现在只有一处可改。原来这条断言在组件源码上数「pin 出现 2 次」并逐处校验顺序 ——
    // 那锁的是**重复本身**:两处逐字重复的代码,漏改一处不会有任何编译或测试信号,而这三条
    // 不变量恰好各自都曾只在一条路径上被修好过(第 14 / 17 / 20 轮)。收敛之后改锁两件事:
    // ① handoff 内部三步顺序正确;② 两条创建路径都只经 handoff(见下一条)。
    const pinAt = remoteSessionHandoffSource.indexOf(
      'remoteProjectsStore.pinSessionOrigin(p.deviceId, p.remoteSessionId)',
    );
    const rowAt = remoteSessionHandoffSource.indexOf('remoteProjectsStore.mergeDeviceSessions(');
    const refreshAt = remoteSessionHandoffSource.indexOf('void refreshRemoteDeviceSessions(');
    expect(pinAt).toBeGreaterThan(-1);
    // 钉子必须在临时行之前,临时行必须在触发回流之前。
    expect(rowAt).toBeGreaterThan(pinAt);
    expect(refreshAt).toBeGreaterThan(rowAt);
  });

  /**
   * #807 review 第 33 轮 P1:回流**不得**挡在 setPending / navigate 前面。
   *
   * refreshRemoteDeviceSessions 对瞬态错误退避重试,窗口最长约 6.75 秒。原来 handoff `await` 它才
   * 返回,于是这段时间里应用被关掉 → 对端**已经**有了新会话,而用户的首条消息(或目标弹窗里刚写的
   * 内容)还没被 setPending / setPendingGoal 记录下来 → 重开再试就在对端建出第二个任务,第一个空着
   * 滞留;建目标那条还会连同只存在于弹窗内存里的编辑一起丢。
   *
   * 交接本来就不需要等权威快照 —— 临时行(带对端真正分配的 workDir)已经足够让 SessionView 的
   * delayed-create 完成 consumePending。所以 handoff 改为同步返回、回流 fire-and-forget。
   */
  it('does not block the handoff on the mirror refresh', () => {
    // 同步签名:没有 async / 不返回 Promise。
    expect(remoteSessionHandoffSource).toContain(
      'export function commitRemoteSessionHandoff(p: RemoteSessionHandoffParams): void {',
    );
    expect(remoteSessionHandoffSource).not.toContain(
      'export async function commitRemoteSessionHandoff',
    );
    // 回流不被 await。
    expect(remoteSessionHandoffSource).not.toContain('await refreshRemoteDeviceSessions(');
    // 两处调用点都不得 await 它 —— await 一个同步函数不报错,但会把「不要等」这个意图悄悄改回去。
    expect(newMakerDraftRouteSource).not.toContain('await commitRemoteSessionHandoff(');
    // 而 setPending / setPendingGoal 必须在各自的 handoff 之后仍然发生(交接本体没被搬走)。
    const sendPart = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf("logTag: 'draft send'"),
    );
    expect(sendPart.slice(0, sendPart.indexOf('navigate('))).toContain(
      'setPending(remoteSessionId',
    );
    const goalPart = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf("logTag: 'draft goal'"),
    );
    expect(goalPart.slice(0, goalPart.indexOf('navigate('))).toContain(
      'setPendingGoal(remoteSessionId',
    );
  });

  // 替代原先「两处各自都得有 pin + merge + refresh」的三组计数断言。锁的东西没减少反而更强:
  // 那三条不变量的**内容**由上一条断言在 handoff 里钉死,这里只需要保证没有哪条创建路径绕过它。
  // 将来第三条远程创建路径(例如侧边栏直建)漏调 handoff 时,这条会直接失败。
  it('routes every remote create path through the shared handoff', () => {
    const handoffCalls =
      newMakerDraftRouteSource.match(/\n\s+commitRemoteSessionHandoff\(\{/g) ?? [];
    expect(handoffCalls.length).toBe(2);
    // 组件不得自己碰这三步中的任何一步 —— 那就等于又开了一条绕过不变量的路。
    expect(newMakerDraftRouteSource).not.toContain('pinSessionOrigin(');
    expect(newMakerDraftRouteSource).not.toContain('mergeDeviceSessions(');
    expect(newMakerDraftRouteSource).not.toContain('buildProvisionalRemoteSession(');
    // 两处都得把实际提交的 args 交给 handoff:临时行按它组装,不各自再推一遍
    // model / permission / workspaceKind。
    for (const marker of ["logTag: 'draft send'", "logTag: 'draft goal'"]) {
      const callStart = newMakerDraftRouteSource.lastIndexOf(
        'commitRemoteSessionHandoff({',
        newMakerDraftRouteSource.indexOf(marker),
      );
      const callEnd = newMakerDraftRouteSource.indexOf('});', callStart);
      expect(newMakerDraftRouteSource.slice(callStart, callEnd)).toContain('createArgs,');
    }
    // workDir 取 create 响应(纯对话的运行目录由对端分配,控制端猜不到)。
    expect((newMakerDraftRouteSource.match(/workDir: created\?\.workDir,/g) ?? []).length).toBe(2);
  });

  // #807 review 第十七轮:handleSend 的第一个 await 是协同策略重取,它在上锁之前 —— 期间两个
  // pill 仍可点,而本次调用的闭包持有旧设备 / 旧工作区,会话会建在旧目标上。
  it('takes the in-flight lock before the first await in handleSend', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleSend = useCallback('),
    );
    const lockAt = handler.indexOf('markSendInFlight(true);');
    const refreshAt = handler.indexOf('await collabPolicy.refresh()');
    expect(lockAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(lockAt);
    // finally 解锁:早退路径不必各自记得解锁(锁到真正上锁点之间是纯同步代码)。
    expect(handler.slice(lockAt, refreshAt + 400)).toContain('markSendInFlight(false);');
  });

  // #807 review 第十七轮:DESIGN.md §5 只允许 8px / 12px / 9999px 三档,6px 是明文禁止的中间值。
  // 这里取 pill —— §5 把 8px 限定为「小到无法戴 pill 的交互件」,24×24 图标按钮戴 pill 就是正圆。
  it('keeps the row remove affordance on an allowed radius tier', () => {
    expect(folderPickerPopoverSource).not.toContain('rounded-[6px]');
    expect(folderPickerPopoverSource).toContain(
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
    );
  });

  // #807 review 第十七轮:换设备要一并丢掉**路径型**附件。attachment-path-passthrough 之后非图片
  // 附件只把 path 透传给模型,而 rehomeDraftAttachments 只重整图片 —— 上一台机器的路径会随首条
  // 消息发到新设备,读不到、或读到同路径下一个毫不相关的文件。
  it('drops path-backed attachments on every device switch', () => {
    const helper = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const dropPathBackedAttachments = useCallback('),
    );
    const body = helper.slice(0, helper.indexOf('}, ['));
    expect(body).toContain(".filter((f) => f.category !== 'image')");
    expect(body).toContain('attachmentState.removeFile(f.id)');
    // 图片不动:它们走 xdt-image:// 缓存,不依赖对端文件系统。
    expect(body).toContain("t('newChat.deviceSwitcher.attachmentsDropped'");
    // chip 剥离在**另一个**函数里(不同的解析基准,不同的触发条件)。
    expect(body).not.toContain('stripLocalMentionChips');
    expect(newMakerDraftRouteSource).toContain(
      'const stripProjectRelativeMentions = useCallback(() => {',
    );
    // 全文恰好两处非图片过滤,各有明确分工:① 这个换设备时的同步清理;② 第二十四轮加的不变量
    // 收敛 effect(兜住在途摄入等所有入口)。出现第三处就说明又有人在某条路径上手写了一份。
    expect(
      (newMakerDraftRouteSource.match(/\.filter\(\(f\) => f\.category !== 'image'\)/g) ?? [])
        .length,
    ).toBe(2);
    expect(newMakerDraftRouteSource).toContain('「远程草稿绝不携带控制端路径附件」的**收敛器**');
  });

  /**
   * ─── 草稿运行目标的转移:两条主不变量 ────────────────────────────────────────
   *
   * 这两条替代了先前十余条按「路径 × 状态」逐格 pin 的断言。那种写法锁的是矩阵的每一格,
   * 而矩阵本身就是缺陷来源:4 条转移路径 × 9 处连带状态,漏掉一格既不会编译失败也不会有测试
   * 变红,#807 的 review 里约十轮都在补格子(切设备漏 worktree 三态、同机换项目误重置运行配置、
   * 指向设备前忘了作废快照、回落路径两样清理都漏、picker 换项目不作废 worktree……)。
   *
   * 收敛之后只需要锁两件事:① 四条路径都**只声明目标**,不自己做副作用;② 每处连带状态绑对了
   * 它真正依赖的那一半(设备 / 项目)。第五条路径出现时,①会直接失败,而②保证它自动是对的。
   */
  it('routes every draft-target transition through the single action', () => {
    // 五条路径:设备 pill、设备域浏览器选项目、工作区 picker、所选设备失效后的自动回落、
    // “对话”分组导航请求。声明本身是 `= useCallback(` 不匹配这个模式,所以数出来的就是调用点。
    const calls = newMakerDraftRouteSource.match(/applyDraftTarget\(\{/g) ?? [];
    expect(calls.length).toBe(5);
    // 组件里不得再有任何一处手写这些副作用 —— 手写一处就等于又开了一条绕过推导的路。
    // patchDraft 仍可出现(入场清 extraDirs、发送后复位),但不得再带设备字段。
    expect(newMakerDraftRouteSource).not.toContain('deviceLinkDeviceId: deviceId,');
    expect(newMakerDraftRouteSource).not.toContain('deviceLinkDeviceId: target.deviceId,');
    expect(newMakerDraftRouteSource).not.toContain('deviceLinkDeviceId: null,');
    // worktree repo/branch 探测态与三个 evict 只能出现在那个动作里(各 1 处)。
    // 注:`setRemoteDraftState({ loaded: false, … })` 不在此列 —— defaults effect 自己的早返回与
    // 重拉前重置也用它,那是它自身的正常逻辑,不是转移路径的重复实现。
    for (const marker of [
      'setWtBaseRepo(null);',
      'evictDeviceCapabilities(',
      'evictDeviceProviders(',
      'evictDeviceGitSafetySettings(',
    ]) {
      const n = newMakerDraftRouteSource.split(marker).length - 1;
      expect({ marker, n }).toEqual({ marker, n: 1 });
    }
  });

  it('binds each connected state to the half of the target it actually depends on', () => {
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    const body = action.slice(0, action.indexOf('      patchDraft({'));
    // 变化判据本身。
    expect(body).toContain('const deviceChanged = req.deviceId !== prevDeviceId;');
    expect(body).toContain('const workingDirChanged = req.workingDir !== draft.workingDir;');
    // mention chip 存**项目相对**路径 → 设备或项目任一变化都要剥(第 29 轮 P1)。
    expect(body).toContain(
      'if (deviceChanged || workingDirChanged) stripProjectRelativeMentions();',
    );
    // 路径型附件存**绝对**路径 → 只有换设备才失效,同机换项目不该丢用户的附件。
    expect(body).toContain('if (deviceChanged) dropPathBackedAttachments();');
    // 三个无 TTL 快照:绑「指向一台**新**设备」或「用户主动重新验证了这台设备」,
    // **不是**「指向设备就作废」—— 详见下面 does not evict… 那条用例的机制说明。
    expect(body).toContain('if (req.deviceId && (deviceChanged || req.remoteSnapshot)) {');
    expect(body).toContain('evictDeviceCapabilities(req.deviceId);');
    // worktree 三态绑 (设备, 项目) 二元组 = 绑 repo。
    expect(body).toContain('if (deviceChanged || workingDirChanged) {');
    // 判据读 draft.workingDir,必须在依赖数组里,否则闭包比的是上一次渲染的值。
    const deps = action.slice(action.indexOf('    [', action.indexOf('patchDraft({')));
    expect(deps.slice(0, deps.indexOf('  );'))).toContain('draft.workingDir,');
  });

  // #807 review 第十九轮:被控端能力 / 供应商 / Git safety 快照是「拉一次、无 TTL、只在设备下线
  // 才 evict」的,设备一直在线期间装了新模型或改了供应商,控制端不会知道 —— 切回它时 hook 的
  // effect 虽因 deviceId 变化重跑,却直接命中旧缓存,composer 会向它提交已不支持的 model /
  // provider。**每一条**把草稿指向某台被控设备的路径都必须先 evict。
  it('evicts the target device snapshots on every path that points the draft at a device', () => {
    // 本路由的转移路径共用一处 evict;条件见下一条用例(不是「指向设备就作废」)。
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    const evictBlock = action.slice(
      action.indexOf('if (req.deviceId && (deviceChanged || req.remoteSnapshot)) {'),
    );
    expect(evictBlock.slice(0, evictBlock.indexOf('      }'))).toContain(
      'evictDeviceCapabilities(req.deviceId);',
    );
    expect(evictBlock.slice(0, evictBlock.indexOf('      }'))).toContain(
      'evictDeviceProviders(req.deviceId);',
    );
    expect(evictBlock.slice(0, evictBlock.indexOf('      }'))).toContain(
      'evictDeviceGitSafetySettings(req.deviceId);',
    );
    // 设备域浏览器那条额外 prefetch(它允许「目标就是当前设备」,deps 不变 → hook effect 不重跑,
    // 只有 subscriber 能送新数据),且必须排在转移动作**之后** —— 否则刚 prefetch 的又被 evict 掉。
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleRemoteProjectAdded = useCallback('),
    );
    const applyAt = handler.indexOf('applyDraftTarget({');
    const prefetchAt = handler.indexOf('prefetchDeviceCapabilities(target.deviceId)');
    expect(applyAt).toBeGreaterThan(-1);
    expect(prefetchAt).toBeGreaterThan(applyAt);
    // 侧边栏点远程项目进草稿是**另一个组件**的路径,不经本路由的转移动作,自己 evict + prefetch。
    // ⚠️ 这里原来只断言那三行 evict 存在 —— 于是它**保护住了**第 32 轮那个 P1(见下一条用例)。
    expect(sidebarUpperSource).toContain('evictDeviceCapabilities(targetDeviceId);');
    expect(sidebarUpperSource).toContain('evictDeviceProviders(targetDeviceId);');
    expect(sidebarUpperSource).toContain('evictDeviceGitSafetySettings(targetDeviceId);');
  });

  /**
   * #807 review 第 32 轮 P1 —— 与第 30 轮**同一个根因的第三处**,而且我上一轮的测试恰好把它锁住了:
   * 那条断言只要求侧边栏那三行 evict 存在,于是「无条件 evict」被写成了不变量去保护。
   *
   * 规则的完整表述应该是:**capabilities / providers 的 evict 必须配对一次会真正重取的动作** ——
   * 它们 notify `{ status: 'loading' }` 把已挂载的 hook 推进加载态,而 fetch effect 的 deps 是
   * `[agentKind, deviceId]`。配对方式有两种,按 deviceId 是否变化选:
   *   · 换设备 → effect 自己会重跑(applyDraftTarget 走这条);
   *   · deviceId 可能不变 → 必须显式 prefetch(设备域浏览器与侧边栏这两条走这条)。
   *
   * 本仓早有正确范例:useDeviceLinkRemoteProjects 处理 `maker:provider:changed` push 时就是
   * evict 紧跟 prefetch。反之,「设备撤销 / 断开 / 禁用 / hook 卸载」那几处 evict **不需要**配对 ——
   * 那台设备已经不可用,没有「永久 loading」的受害者。
   */
  it('pairs every eviction of a still-usable device with a refetch', () => {
    // ① 侧边栏「+ 新建」:deviceId 可能与当前草稿相同 → 必须显式 prefetch 三个。
    const handler = sidebarUpperSource.slice(
      sidebarUpperSource.indexOf('const handleCreateInProject = useCallback('),
    );
    const body = handler.slice(0, handler.indexOf('navigate('));
    for (const call of [
      'prefetchDeviceCapabilities(targetDeviceId)',
      'prefetchDeviceProviders(targetDeviceId)',
      'prefetchDeviceGitSafetySettings(targetDeviceId)',
    ]) {
      expect(body).toContain(call);
    }
    // prefetch 必须在 evict 之后,否则刚取回的又被作废。
    expect(body.indexOf('prefetchDeviceCapabilities')).toBeGreaterThan(
      body.indexOf('evictDeviceCapabilities'),
    );
    // ② 设备域浏览器:同样可能是同一台设备,三个都要 prefetch(gitSafety 少了会让 Rewind 入口隐藏)。
    const added = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleRemoteProjectAdded = useCallback('),
    );
    const addedHead = added.slice(0, added.indexOf('return;'));
    expect(addedHead).toContain('prefetchDeviceCapabilities(target.deviceId)');
    expect(addedHead).toContain('prefetchDeviceProviders(target.deviceId)');
    expect(addedHead).toContain('prefetchDeviceGitSafetySettings(target.deviceId)');
    // ③ 「设备已不可用」类的 evict 不需要配对 —— 那几处刻意不 prefetch,别被这条规则误改。
    //    这里只锁「本仓存在那个正确范例」,它是这条规则的出处。
    expect(deviceLinkRemoteProjectsSource).toContain('evictDeviceProviders(push.deviceId);');
    expect(deviceLinkRemoteProjectsSource).toContain(
      'void prefetchDeviceProviders(push.deviceId);',
    );
  });

  /**
   * #807 review 第 30 轮 P1 —— 这是**上一轮收敛时我自己引入的回归**,而全量门禁 54 PASS 没抓到:
   * 那时的断言只锁「有没有 evict」,不锁**触发条件**。
   *
   * 机制:evict 不是幂等清理,而是一次有副作用的状态转移 —— `evictDeviceCapabilities` /
   * `evictDeviceProviders` 都会 notify `{ status: 'loading' }`(为了让已挂载的 hook 立刻知道旧
   * 快照失效,否则 provider 新快照先到时会拿旧 capabilities 算 fallback 并覆盖用户偏好)。
   * 它必须有配对的 fetch 才能收敛,而两个 hook 的 effect deps 是 `[agentKind, deviceId]`、
   * **不含项目** —— 于是同一台设备上换个项目时,evict 之后没有任何东西会去重拉:
   * `capabilitiesLoading` 永久为真,send / New Goal 的三重 gate 永久拒绝创建,用户必须切设备
   * 或重进路由才能恢复。功能完全阻塞。
   *
   * 所以这条同时钉住上游那个**事实**(evict 会 notify loading)与下游那条**规则**(因此需要配对
   * fetch):任何一端被改动都会在这里失败,而不是等到用户发不出消息。
   */
  it('does not evict same-device snapshots when only the workspace changes', () => {
    // 上游事实:evict 会把已挂载的 hook 推进 loading 态。
    expect(agentCapabilitiesHookSource).toContain(
      "notifyRemoteCapabilities(deviceId, agentKind, { status: 'loading' });",
    );
    expect(deviceProvidersHookSource).toContain(
      "notifyDeviceProviders(deviceId, { status: 'loading' });",
    );
    // 上游事实:fetch effect 只按 (agentKind, deviceId) 重跑,换项目不会触发它。
    expect(agentCapabilitiesHookSource).toContain('}, [agentKind, deviceId]);');
    expect(deviceProvidersHookSource).toContain('}, [deviceId]);');
    // 下游规则:因此只在「换了设备」或「调用方已带来新快照并会紧接着 prefetch」时才 evict。
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    expect(action).toContain('if (req.deviceId && (deviceChanged || req.remoteSnapshot)) {');
    // 工作区 picker 这条路径既不换设备也不带快照 → 必然不 evict。
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWorkingDirChange = useCallback('),
    );
    const body = handler.slice(0, handler.indexOf('    [applyDraftTarget'));
    expect(body).not.toContain('remoteSnapshot');
    expect(body).not.toContain('evictDevice');
  });

  // #807 review 第二十轮:归属钉子只解决路由,首条消息的交接还要求 SessionView 拿到一条会话行
  // (delayed-create effect 要 `session` 非空且 workingDir 非空)。回流失败、尤其老被控端永久
  // 拿不到 sessions:list 时永远不会有权威快照,那条消息就永久不发,而草稿已经清掉。
  it('seeds a provisional session row so the first message can hand off without the snapshot', () => {
    // 补行这一步同样搬进了 handoff(两条路径都走它,见上)。这里锁它的三条细节:
    // workDir 必须取 create 响应,不能拿草稿的 workingDir 顶替 —— 纯对话的运行目录由对端分配。
    expect(remoteSessionHandoffSource).toContain('workDir: p.workDir,');
    // 缺 workDir 时跳过补行,而不是编一个目录:delayed-create 的门槛正是它非空。
    expect(remoteSessionHandoffSource).toContain('if (p.workDir) {');
    // 用 merge 而非 set:不能把该设备已缓存的其它会话冲掉。
    expect(remoteSessionHandoffSource).toContain('remoteProjectsStore.mergeDeviceSessions(');
    expect(remoteSessionHandoffSource).not.toContain('setDeviceSessions(');
    // 临时行按**实际提交的** args 组装,不再推一遍 model / permission / workspaceKind。
    expect(remoteSessionHandoffSource).toContain('args: p.createArgs,');
  });

  // #807 review 第二十二轮:换设备时的清理只管「切换那一刻已在托盘里」的附件,**先选设备、之后
  // 再拖进来**的路径型附件照样会把控制端绝对路径发到对端。两者一起才是「远程草稿绝不携带控制端
  // 路径附件」这条不变量。
  it('refuses path-backed attachments added after a remote device is selected', () => {
    const guard = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const guardedAttachmentState = useMemo('),
    );
    const body = guard.slice(0, guard.indexOf('}, ['));
    // 本机草稿零开销:直接返回原对象,不包装。
    expect(body).toContain('if (!isDeviceLinkDraft) return attachmentState;');
    // 判据必须与下游**同口径**(第 29 轮 P1):useAttachments 的分类完全不看 MIME —— 先按扩展名
    // categorizeFile,认不出来才 peekFileHeader 按魔数推断。原来这里用 `f.type.startsWith('image/')`,
    // 于是 Electron 给空 / 通用 File.type 时(某些平台与拖拽源如此,重命名过的图片更是必然),
    // 一张下游明明能识别的图片会被拦掉,而且只在远程草稿下如此,用户切回本机就能加。
    // 断言旧代码形态而非裸片段 —— 上面那段注释里会逐字提到它作为历史记录。
    expect(body).not.toContain("incoming.filter((f) => f.type.startsWith('image/'))");
    expect(body).toContain('const ext = extractExt(f.name);');
    expect(body).toContain(
      'const category = ext ? categorizeFile(ext) : categorizeByFilename(f.name);',
    );
    // 认不出类别时**放行**,交给下游的文件头推断 + 收敛器兜底 —— 闸门宁可放过,绝不误拒。
    expect(body).toContain('if (!category) return false;');
    expect(body).toContain("return category !== 'image';");
    expect(body).toContain("t('newChat.deviceSwitcher.attachmentsRemoteUnsupported'");
    // 三个入口(ChatInput + 本路由的拖拽 + 延迟分类的拖拽)都必须走闸门,不能有一个直连原对象。
    expect(newMakerDraftRouteSource).toContain('attachmentState={guardedAttachmentState}');
    expect(
      (newMakerDraftRouteSource.match(/guardedAttachmentState\.addFiles\(/g) ?? []).length,
    ).toBe(2);
    // 唯一一处直连原对象的 addFiles 必须是闸门内部那次(放行的那批);此外一处都不许有。
    expect(
      (newMakerDraftRouteSource.match(/(?<!guarded)attachmentState\.addFiles\(/g) ?? []).length,
    ).toBe(1);
    expect(body).toContain('await attachmentState.addFiles(passed);');
  });

  // #807 review 第二十二轮:ExtraDirsButton 开的是控制端原生目录对话框,选出来的本机路径发到对端
  // 会被静默丢掉、或撞上对端同名的无关目录 —— chip 显示的并不是真实授予的上下文。
  it('hides the reference-directory picker on remote drafts', () => {
    expect(newMakerDraftRouteSource).toContain(
      'onExtraDirsChange={isDeviceLinkDraft ? undefined : handleExtraDirsChange}',
    );
    // 统一建议面板的契约:没有 onExtraDirsChange 就不装配添加/移除引用目录能力。
    expect(chatInputSource).toContain('if (onExtraDirsChange) {');
    expect(chatInputSource).toContain(
      'hasReferenceDirs={!settingsLocked && onExtraDirsChange !== undefined}',
    );
  });

  // #807 review 第二十四轮:`useAttachments.addFiles` 对未知扩展名要先 await peekFileHeader,附件是
  // IPC 回来后才进 state 的 —— 本机草稿下拖入 → 期间切到远程 → 切换清理找不到它 → IPC 回来后被追加,
  // 且那次调用握的是切换前的真 addFiles,绕过闸门。按入口逐个堵已经漏了三次,改成维护不变量。
  it('converges the no-controller-path invariant regardless of which entry added the file', () => {
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('「远程草稿绝不携带控制端路径附件」的**收敛器**'),
    );
    const body = effect.slice(0, effect.indexOf('}, ['));
    expect(body).toContain('if (!isDeviceLinkDraft) return;');
    expect(body).toContain(".filter((f) => f.category !== 'image')");
    expect(body).toContain('attachmentState.removeFile(f.id)');
    // 依赖 attachments 本身(而非整个 attachmentState 对象)才能在附件晚到时重跑。
    expect(effect.slice(effect.indexOf('}, ['), effect.indexOf('}, [') + 160)).toContain(
      'attachmentState.attachments',
    );
  });

  // #807 review 第二十四轮:handleCreateGoal 必须整段持在途锁。上一轮我以为「模态遮罩挡住 pill」就
  // 够了 —— 只考虑了指针输入,AlertDialog 默认拦外部点击但 Esc 照样能关。
  it('holds the in-flight lock for the whole goal creation', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleCreateGoal = useCallback('),
    );
    const head = handler.slice(0, handler.indexOf('let policyEnabled'));
    expect(head).toContain('markSendInFlight(true);');
    expect(head).toContain('try {');
    // finally 释放,覆盖所有 throw / 早退。
    expect(handler.slice(0, handler.indexOf('\n    },'))).toContain('markSendInFlight(false);');
    // 弹窗侧:saving 期间不许 Esc 关掉(别让 UI 假装取消了)。
    expect(newGoalDialogSource).toContain('if (saving) event.preventDefault();');
  });

  /**
   * #807 review 第 31 轮 P1:上一处的锁本身是对的,但**早退方式**错了 —— `return` 会被
   * NewGoalDialog 当成成功。
   *
   * 与第 30 轮那条 evict 同一个模式:同时钉住上游那个事实与下游那条规则,任何一端被改动都会
   * 在这里失败,而不是等到用户的目标文案被静默丢掉。
   */
  it('rejects duplicate goal creation instead of resolving as success', () => {
    // 上游事实:save() 把 `await onCreate(...)` 正常 resolve 一律当成成功 —— 紧接着清 composer
    // 并关掉弹窗;只有抛出才会走 catch 内联显示原因、保住用户已写的 objective。
    const save = newGoalDialogSource.slice(
      newGoalDialogSource.indexOf('const save = async () => {'),
    );
    const saveBody = save.slice(0, save.indexOf('\n  };'));
    expect(saveBody).toContain('await onCreate(trimmed, limits);');
    expect(saveBody).toContain('onCreated?.();');
    expect(saveBody).toContain('onOpenChange(false);');
    expect(saveBody).toContain('} catch (err) {');
    // 下游规则:锁被占用时必须抛,不能 return。
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleCreateGoal = useCallback('),
    );
    const guard = handler.slice(0, handler.indexOf('markSendInFlight(true);'));
    expect(guard).toContain("throw new Error(t('goal.newGoalDialog.busy'));");
    expect(guard).not.toContain('if (sendInFlightRef.current) return;');
    // 抛出必须发生在**上锁之前**,否则 finally 会把仍在跑的那次操作的锁解掉。
    expect(guard.indexOf('throw new Error')).toBeGreaterThan(
      guard.indexOf('if (sendInFlightRef.current)'),
    );
    // 发送路径相反:它返回 false 让 ChatInput 保留草稿(那是它的既定契约,不要跟着改成 throw)。
    const send = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleSend = useCallback('),
    );
    expect(send.slice(0, send.indexOf('if (effectiveCollab.enabled'))).toContain(
      'if (sendInFlightRef.current) return false;',
    );
  });

  // #807 review 第二十五轮:上一轮把「指名设备离线就不回落到别的目标」改对了,但受控 select 的
  // value="" 没有对应 option —— 浏览器会去显示第一个真实 option,而 selectedTarget 仍是 null,
  // 「添加」保持 disabled;只有一个备选目标时点那个已显示的项也不产生 change,弹窗就此卡死。
  it('gives the unselected target state a real placeholder option and a reason', () => {
    expect(addRemoteProjectDialogSource).toContain('{selectedKey === null && (');
    expect(addRemoteProjectDialogSource).toContain('<option value="" disabled>');
    expect(addRemoteProjectDialogSource).toContain(
      "t('newChat.addRemoteProject.selectTargetPlaceholder')",
    );
    // 未选中的原因也要说出来,否则用户只看到一个空下拉。
    expect(addRemoteProjectDialogSource).toContain('const requestedDeviceUnavailable =');
    expect(addRemoteProjectDialogSource).toContain(
      "t('newChat.addRemoteProject.requestedDeviceUnavailable')",
    );
  });

  // #807 review 第二十七轮:同机换项目保留用户已选是对的(第十三轮加的),但这条路径同时把
  // dlSeedKeyRef 记成「该设备已 seed」,后续 capabilities 更新不会再重种 —— 被控端此间删掉了用户
  // 选中的模型 / 不再支持某个 permission 时,失效值会一直留在草稿里:发送被 gate 拦住变成「点了
  // 没反应」,「新建目标」更糟,直接把失效值提交给 maker:create-session。
  it('revalidates a preserved remote selection against the freshly fetched capabilities', () => {
    const action = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const applyDraftTarget = useCallback('),
    );
    const body = action.slice(0, action.indexOf('      patchDraft({'));
    // 同设备分支不能什么都不做 —— 上面刚把 seedKey 记成「已 seed」,后续 capabilities 更新不会
    // 再重种,失效值会一直留着:发送被 gate 拦住变成「点了没反应」,建目标更糟,会直接提交出去。
    expect(body).toContain('} else {');
    expect(body).toContain('setDlSel((prev) =>');
    // 复用既有纯函数做 clamp,不另写一套;把用户当前选择当 remoteDraft 传进去。
    expect(body).toContain('model: prev.model,');
    expect(body).toContain('permissionMode: prev.permissionMode,');
    // 三处调用:换设备重种、同设备按 prev 校准、prev 为空时退回正常 seed。
    expect((body.match(/resolveDeviceLinkDraftDefaults\(/g) ?? []).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('reapplies refreshed regional defaults only while the remote runtime is untouched', () => {
    const seed = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('// seed dlSel:'),
      newMakerDraftRouteSource.indexOf('// 远程草稿展示用:'),
    );
    expect(seed).toContain('shouldReseedDeviceLinkDraftDefaults({');
    expect(seed).toContain('capabilitiesChanged,');
    expect(seed).toContain('if (!capabilities || capabilitiesLoading');
    expect(seed).toContain('controllerTouched: dlRuntimeTouchedRef.current,');
    expect(seed).toContain('remoteModelChosenByUser: remoteDraftState.value?.modelChosenByUser,');
    expect(seed).toContain('modelChosenByUser: true,');
    expect(seed).toContain('current.model,');

    const runtimeHandlers = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleModelDidChange = useCallback('),
      newMakerDraftRouteSource.indexOf('// ─── 用户改 workingDir'),
    );
    // 5 → 6:统一模型选择器(M5)新增 handleUnifiedDraftSelect —— 它同样是一次
    // 控制端对远程运行配置的显式编辑,漏打这个标记的话下一次 capabilities 刷新
    // 会把用户刚选的模型重种回被控端默认。
    expect((runtimeHandlers.match(/dlRuntimeTouchedRef\.current = true;/g) ?? []).length).toBe(6);
  });

  /**
   * 2026-08-17 review 第三轮 G1:统一面板跨引擎选择切了 draft.vendor,但 seed key 还停在
   * 上一个引擎上 —— 下一帧播种 effect 看到「新目标」,按目标引擎的**被控端远程默认值**无条件
   * 重播种,用户刚点选的模型当场被覆盖,建出来的远程任务用的不是他选的模型。
   *
   * 修法:让这次显式选择成为新引擎的 seed —— 前置把 key 推到目标引擎。key 的构造必须与播种
   * effect **逐字一致**,这条断言锁的就是那份一致性(两处各拼一遍必然漂移成「永远判成新目标」
   * 或「永远判不成新目标」)。
   */
  it('advances the device-link seed key to the engine the user just picked', () => {
    const seed = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('// seed dlSel:'),
      newMakerDraftRouteSource.indexOf('// 远程草稿展示用:'),
    );
    // 播种 effect 侧的 key 构造(正本)。
    expect(seed).toContain('const key = `${effectiveDeviceLinkDeviceId}:${capabilityAgentKind}`;');

    const unified = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleUnifiedDraftSelect = useCallback('),
      newMakerDraftRouteSource.indexOf('// ─── 用户改 workingDir'),
    );
    // 选择侧:同一构造,agent 一维换成**目标引擎**(selection.vendor),且必须在 setDlSel 之前。
    expect(unified).toContain(
      'dlSeedKeyRef.current = `${effectiveDeviceLinkDeviceId}:${dbToMakerAgentKind(',
    );
    expect(unified).toContain('normalizeDbAgentKind(selection.vendor),');
    expect(unified.indexOf('dlSeedKeyRef.current =')).toBeLessThan(
      unified.indexOf('setDlSel((prev) => {'),
    );
    // 前置的前提是「控制端已编辑」这枚标记也在(否则同一目标遇上 capabilities 刷新照样重种)。
    expect(unified.indexOf('dlRuntimeTouchedRef.current = true;')).toBeLessThan(
      unified.indexOf('dlSeedKeyRef.current ='),
    );
  });

  // #807 review 第二十七轮:设备菜单行原来只有 hover / disabled 两态,且 outline-none 去掉了浏览器
  // 默认焦点圈 —— 键盘走这个菜单时完全看不出焦点落在哪一行。
  it('shows a token-backed focus ring on device menu rows', () => {
    const row = deviceSwitcherPillSource.slice(
      deviceSwitcherPillSource.indexOf('function DeviceRow('),
    );
    expect(row).toContain(
      'focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
    );
    // 与 pill trigger 同 token(同一控件的键盘表现应一致)。
    expect(deviceSwitcherPillSource).toContain(
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--create-agent-focus-ring)]',
    );
  });

  // #807 review 第二十八轮:本机分支早就用 effectiveSourceIdForModel 校准过来源,device-link 分支
  // 却原样透传 dlSel.providerId。普通发送不受影响(ChatInput 内部会重算),但「新建目标」是直接拿
  // 这个值提交给 maker:create-session 的 —— 被控端把该来源断开后,会把未认证来源写进
  // sessions.provider_id,新目标起不来。校准放在**派生处**,一次覆盖所有消费点。
  it('clamps the device-link provider through the shared resolver, not just the local branch', () => {
    const derive = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const chatInitialProviderId = useMemo<string | null>('),
    );
    const body = derive.slice(0, derive.indexOf('}, ['));
    // 本机分支行为不变。
    expect(body).toContain('if (!isDeviceLinkDraft) return localProviderIdForDraft;');
    // 远程分支按**被控端**目录 + 草稿当前模型复算,用与 main 同源的解析函数。
    expect(body).toContain('effectiveSourceIdForModel(');
    expect(body).toContain('deviceProviders,');
    expect(body).toContain('draftInitialModel,');
    // 反向防回退:不能再出现原样透传。
    expect(newMakerDraftRouteSource).not.toContain(
      'isDeviceLinkDraft\n    ? (deviceLinkInitial?.providerId ?? null)',
    );
  });

  it('keeps recent-folder storage out of project-option selection', () => {
    expect(folderPickerPopoverSource).toContain('projectOptions?: readonly FolderPickerOption[]');
    expect(folderPickerPopoverSource).toContain(
      'const isProjectPicker = projectOptions !== undefined',
    );
    expect(folderPickerPopoverSource).toContain(
      'open && !isProjectPicker ? getRecentFolders() : []',
    );
    expect(worktreeChipsSource).toContain("if (source !== 'project') addRecentFolder(path)");
  });
});

/**
 * 统一模型选择器合并行之后的 **草稿层 id 口径锁**。
 *
 * 数据层把同一模型的多引擎条目合并成一行:行 id 是**归一化 id**,每个引擎真正能发出去的是
 * 各自的 **wireModelId**。草稿层落盘的每一格(lastByVendor.model → createSession)都必须是
 * wire id;归一化 id 一旦漏进来,首条请求就路由到一个目标引擎目录里不存在的模型。
 */
describe('New Maker 草稿的 wire model id 口径', () => {
  it('统一面板选中直接把 wire id 写进 vendor 槽,不做任何 id 加工', () => {
    const handlerStart = newMakerDraftRouteSource.indexOf(
      'const handleUnifiedDraftSelect = useCallback(',
    );
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = newMakerDraftRouteSource.slice(
      handlerStart,
      newMakerDraftRouteSource.indexOf('// ─── 用户改 workingDir', handlerStart),
    );
    // 本地草稿落 lastByVendor(→ createSession)、device-link 草稿落 dlSel —— 两条都用
    // selection.modelId(wire id),一处都不能换成行 id。
    expect((handler.match(/model: selection\.modelId,/g) ?? []).length).toBe(2);
    // 归一化行 id 不进草稿层,连字段都不该出现在写入实参里。
    expect(handler).not.toContain('rowModelId');
  });

  it('收藏锚点按 wire id 判失效,不拿收藏条目的归一化 id 去比', () => {
    // 收藏条目按**归一化行 id** 存(那是行的稳定身份),草稿里放的是 wire id ——
    // 直接比 favorite.modelId 与 draftInitialModel,像 chatgpt/gpt-5.6-luna 这类两者本就
    // 不相等的模型会每次都判成失配,刚点上的收藏立刻掉勾。
    //
    // **有意变更**(Chris 2026-08-19):锚点从组件态改成按引擎分槽持久化
    // (favoriteAnchorMemory),变量名随之从 selectedFavoriteAnchor 变成 draftFavoriteAnchor,
    // 「vendor 也要对得上」那一维由槽键承担(读的永远是当前引擎那一格)。**比的仍然是
    // wire id**,这条锁不变。
    expect(newMakerDraftRouteSource).toContain(
      'draftFavoriteAnchor.wireModelId === draftInitialModel',
    );
    // 来源也是锚点身份(2026-08-19 review P1):同 wire model 跨来源不得误恢复。
    expect(newMakerDraftRouteSource).toContain(
      'draftFavoriteAnchor.providerId === chatInitialProviderId',
    );
    expect(newMakerDraftRouteSource).not.toContain('favorite.modelId !== draftInitialModel');
    // 快照在选中那一刻记下本次写进草稿的 (wire id, 来源)。
    expect(newMakerDraftRouteSource).toContain('wireModelId: selection.modelId,');
    expect(newMakerDraftRouteSource).toContain('providerId: selection.providerId,');
  });

  it('草稿锚点不做「不符即删槽」的清理 effect(持久化后瞬态失配会永久误删)', () => {
    // 2026-08-19 预审 P2-7:draftInitialModel 在 device-link seed 到达前有瞬态窗口,
    // 清理 effect 会拿暂用值把持久化槽永久删掉;派生「不符不亮」已足够,显式选择仍清槽。
    expect(newMakerDraftRouteSource).not.toContain(
      "setDraftFavoriteAnchor(normalizeDbAgentKind(draft.vendor), null)",
    );
  });

  it('六条建会话成功路径都把草稿锚点延续到会话槽,且用各分支实际提交的 model/providerId', () => {
    // carryDraftFavoriteAnchorToSession(Chris 2026-08-19):草稿选了收藏、发送建会话后,
    // 会话面板必须还勾在那一条上。调用点 = SSH / device-link 远程发送 / 本地发送 /
    // 新建目标(本地) / Goal(本地) / **Goal(device-link 远端)**,共 6 处;
    // 少一处 = 那条路建出来的会话锚点丢失(远端 Goal 正是 review 抓到的遗漏)。
    const carryCalls =
      newMakerDraftRouteSource.match(/carryDraftFavoriteAnchorToSession\(/g) ?? [];
    // 恰好 6 处调用(定义是 `= useCallback(`,不带同名左括号,不计入)。
    expect(carryCalls.length).toBe(6);
    // SSH 分支用 ssh 侧解析的提交值(≠ draftInitialModel)。
    expect(newMakerDraftRouteSource).toContain(
      'carryDraftFavoriteAnchorToSession(newSession.id, draftVendor, sshModel, sshProviderId)',
    );
    // 两条 device-link 远程分支(发送 / Goal)都用 createArgs 里实际提交的 model
    // (被控端目录校准后的值),各自出现在 remoteSessionId 之后。
    expect(
      (newMakerDraftRouteSource.match(
        /carryDraftFavoriteAnchorToSession\(\s*remoteSessionId,\s*persistedAgentKind,\s*createArgs\.model,/g,
      ) ?? []).length,
    ).toBe(2);
  });
});
