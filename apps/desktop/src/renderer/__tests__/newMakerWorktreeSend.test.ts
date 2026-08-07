import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('NewMakerDraftRoute worktree send flow', () => {
  it('enters a real session before creating the worktree in the background', () => {
    // 发送门已保证用户勾选时资格就绪；副作用分支仍以勾选 + baseRepo 双重防御。
    const worktreeBranch = source.indexOf(
      'if (!isRemoteProjectDraft && wt.enabled && wt.baseRepo) {',
    );
    const createSession = source.indexOf('const newSession = await createSession', worktreeBranch);
    const touchUserSend = source.indexOf('sessionService.touchUserSend', createSession);
    // worktree 创建期的视觉反馈走 worktreeCreationStore(由 CCAgentSessionView 底部
    // workingDir chip 行订阅渲染),不再插 chat-stream SystemCard。
    const statusCard = source.indexOf('worktreeCreationStore.set(newSession.id', touchUserSend);
    const navigate = source.indexOf('navigate(`/cc-agent/$' + '{newSession.id}`', statusCard);
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate', navigate);

    expect(worktreeBranch).toBeGreaterThan(-1);
    expect(createSession).toBeGreaterThan(worktreeBranch);
    expect(touchUserSend).toBeGreaterThan(createSession);
    expect(statusCard).toBeGreaterThan(touchUserSend);
    expect(navigate).toBeGreaterThan(statusCard);
    expect(worktreeCreate).toBeGreaterThan(navigate);
  });

  it('never silently downgrades an explicit worktree request to a normal session', () => {
    const selected = source.indexOf('const selectedWorktree = { ...wtRef.current };');
    const guard = source.indexOf(
      'if (selectedWorkingDir && !isRemoteProjectDraft && selectedWorktree.enabled) {',
      selected,
    );
    const markInFlight = source.indexOf('markSendInFlight(true);', guard);
    const guardedSource = source.slice(guard, markInFlight);

    expect(selected).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(selected);
    expect(markInFlight).toBeGreaterThan(guard);
    expect(guardedSource).toContain('!selectedWorktree.baseRepo');
    expect(guardedSource).toContain('!selectedWorktree.branchPreferenceReady');
    expect(guardedSource).toContain('selectedWorktree.supportsRecoveryKeyDiscard !== true');
    expect(guardedSource).toContain('return false;');
  });

  it('keeps the first message as a session draft when background worktree creation fails', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const failedCard = source.indexOf("status: 'failed'", worktreeCreate);
    const restoreHelper = source.indexOf('const restoreFirstMessageDraft');
    const saveDraft = source.indexOf('restoreFirstMessageDraft();', failedCard);
    const restoreText = source.indexOf('plainTextToTiptapDoc(message)', restoreHelper);

    expect(worktreeCreate).toBeGreaterThan(-1);
    expect(failedCard).toBeGreaterThan(worktreeCreate);
    expect(restoreHelper).toBeGreaterThan(-1);
    expect(saveDraft).toBeGreaterThan(failedCard);
    expect(restoreText).toBeGreaterThan(restoreHelper);
  });

  it('does not make the new worktree path the next New Maker default project', () => {
    expect(source).not.toContain('patchDraft({ workingDir: newDir })');
  });

  it('uses the current checkout as the safe source when branch discovery is not ready', () => {
    expect(source.match(/sourceBranch: wt\.sourceBranch\.trim\(\) \|\| 'HEAD'/g)).toHaveLength(2);
    expect(source).not.toContain("sourceBranch: wt.sourceBranch.trim() || 'main'");
  });

  it('uses the shared Cindy branch helper and adopts the authoritative created branch', () => {
    const previewBranch = source.indexOf('let branchName = getBranchName(name);');
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate', previewBranch);
    const authoritativeBranch = source.indexOf('branchName = resp.meta.branch;', worktreeCreate);
    const creatingStateRefresh = source.indexOf("status: 'creating'", authoritativeBranch);

    expect(source).not.toContain('`xdt/${name}`');
    expect(previewBranch).toBeGreaterThan(-1);
    expect(authoritativeBranch).toBeGreaterThan(worktreeCreate);
    expect(creatingStateRefresh).toBeGreaterThan(authoritativeBranch);
  });

  it('treats remote session creation as committed before the shared non-blocking handoff', () => {
    const remoteSessionId = source.search(/const remoteSessionId\s*=\s*presetSessionId/);
    const commitPoint = source.indexOf('remoteSessionId 到手就是**提交点**', remoteSessionId);
    const handoff = source.indexOf('commitRemoteSessionHandoff({', commitPoint);
    const pendingHandoff = source.indexOf('setPending(remoteSessionId', handoff);

    expect(remoteSessionId).toBeGreaterThan(-1);
    expect(commitPoint).toBeGreaterThan(remoteSessionId);
    expect(handoff).toBeGreaterThan(commitPoint);
    expect(pendingHandoff).toBeGreaterThan(handoff);
    expect(source).not.toContain("'local-db:sessions:list'");
  });

  it('settles an older remote cleanup obligation before creating another worktree', () => {
    const remoteBranch = source.indexOf('if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {');
    const recovery = source.indexOf(
      'await recoverPendingRemotePrecreatedWorktrees({',
      remoteBranch,
    );
    const retainedGuard = source.indexOf('!recovery.storageReadable', recovery);
    const reservationGuard = source.indexOf(
      'const reservationRecorded = await registerPendingRemotePrecreatedWorktree(',
      retainedGuard,
    );
    const worktreeCreate = source.indexOf("'worktree:create'", retainedGuard);
    const ledgerRegistration = source.indexOf(
      'createRemoteSessionWithPrecreatedWorktree({',
      worktreeCreate,
    );

    expect(recovery).toBeGreaterThan(remoteBranch);
    expect(source.slice(recovery, worktreeCreate)).toContain(
      '!recovery.storageReadable || recovery.retained > 0',
    );
    expect(retainedGuard).toBeGreaterThan(recovery);
    expect(reservationGuard).toBeGreaterThan(retainedGuard);
    expect(worktreeCreate).toBeGreaterThan(reservationGuard);
    expect(worktreeCreate).toBeGreaterThan(retainedGuard);
    const createRequest = source.lastIndexOf(
      'const createRequest: RemoteWorktreeCreateRequest = {',
      worktreeCreate,
    );
    expect(createRequest).toBeGreaterThan(reservationGuard);
    expect(source.slice(createRequest, worktreeCreate)).toContain('recoveryKey,');
    expect(ledgerRegistration).toBeGreaterThan(worktreeCreate);
    expect(source.slice(ledgerRegistration, ledgerRegistration + 220)).toContain('deviceId,');
  });

  it('fences every remote create side effect by the data-owner generation', () => {
    const ownerCapture = source.indexOf('const dataOwnerAtSend = getDataOwnerGeneration();');
    const currentCheck = source.indexOf('const isCurrentDataOwner = () =>', ownerCapture);
    const invokeWrapper = source.indexOf('const invokeRemote = async', currentCheck);
    const recoveryFence = source.indexOf('isCurrent: isCurrentDataOwner,', invokeWrapper);
    const helperFence = source.indexOf('isCurrent: isCurrentDataOwner,', recoveryFence + 1);
    const handoffFence = source.indexOf('if (!isCurrentDataOwner()) {', helperFence);
    const handoff = source.indexOf('commitRemoteSessionHandoff({', handoffFence);
    const silentCatch = source.indexOf(
      'if (isRemotePrecreatedWorktreeOwnerChangedError(err)) return;',
      handoff,
    );

    expect(ownerCapture).toBeGreaterThan(-1);
    expect(currentCheck).toBeGreaterThan(ownerCapture);
    expect(invokeWrapper).toBeGreaterThan(currentCheck);
    expect(recoveryFence).toBeGreaterThan(invokeWrapper);
    expect(helperFence).toBeGreaterThan(recoveryFence);
    expect(handoffFence).toBeGreaterThan(helperFence);
    expect(handoff).toBeGreaterThan(handoffFence);
    expect(silentCatch).toBeGreaterThan(handoff);
  });

  it('retries remote draft defaults after the relay or selected workstation reconnects', () => {
    const epochHook = source.indexOf('useDeviceLinkReconnectEpoch(');
    const defaultsFetch = source.indexOf("'maker:get-new-maker-defaults'", epochHook);
    const effectDependencies = source.indexOf('remoteDraftRefreshEpoch,', defaultsFetch);
    const transientPreserve = source.indexOf(
      'value: unsupported ? null : previous.value',
      defaultsFetch,
    );

    expect(epochHook).toBeGreaterThan(-1);
    expect(defaultsFetch).toBeGreaterThan(epochHook);
    expect(effectDependencies).toBeGreaterThan(defaultsFetch);
    expect(transientPreserve).toBeGreaterThan(defaultsFetch);
  });

  it('does not auto-send if the prepared session is no longer active', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const latestSession = source.indexOf(
      'const latestSession = await sessionService.get(newSession.id)',
      worktreeCreate,
    );
    const inactiveGuard = source.indexOf("latestSession?.status !== 'active'", latestSession);
    const restoreDraft = source.indexOf('restoreFirstMessageDraft();', inactiveGuard);
    const sendMessage = source.indexOf('makerChatStore.sendMessage(', restoreDraft);

    expect(latestSession).toBeGreaterThan(worktreeCreate);
    expect(inactiveGuard).toBeGreaterThan(latestSession);
    expect(restoreDraft).toBeGreaterThan(inactiveGuard);
    expect(sendMessage).toBeGreaterThan(restoreDraft);
  });

  it('locks the session composer while the background worktree is still preparing', () => {
    // worktreePreparing 从 worktreeCreationStore 读 status==='creating'(经 1.6s
    // 平滑中间态 smoothedWorktreeCreating 派生),下游用作 sendGuard;输入区的
    // "锁定"由 WorktreeCreatingOverlay 顶替 ChatInput 实现(早期是
    // disabled={worktreePreparing} prop,已重构为 overlay 三元)。
    const hookSubscription = sessionViewSource.indexOf('useWorktreeCreation(sessionId)');
    const rawDerive = sessionViewSource.indexOf(
      "worktreeCreation?.status === 'creating'",
      hookSubscription,
    );
    const worktreePreparing = sessionViewSource.indexOf(
      'const worktreePreparing = smoothedWorktreeCreating',
      rawDerive,
    );
    // sendGuard 现在读合并后的 sessionHandoffPreparing —— 「会话正在准备」多了一档
    // (device-link 远程交接,见 remoteHandoffPreparing),两档必须共用同一个
    // 下游判据,否则又是「同一语义两处判定」。worktree 这一档仍是它的组成项。
    const preparingMerge = sessionViewSource.indexOf(
      'const sessionHandoffPreparing = worktreePreparing || remoteHandoffPreparing;',
      worktreePreparing,
    );
    const sendGuard = sessionViewSource.indexOf(
      'if (sessionHandoffPreparing) return false',
      preparingMerge,
    );
    const overlayLock = sessionViewSource.indexOf(
      'worktreePreparing && smoothedBranchName',
      sendGuard,
    );

    expect(hookSubscription).toBeGreaterThan(-1);
    expect(rawDerive).toBeGreaterThan(hookSubscription);
    expect(preparingMerge).toBeGreaterThan(worktreePreparing);
    expect(worktreePreparing).toBeGreaterThan(rawDerive);
    expect(sendGuard).toBeGreaterThan(worktreePreparing);
    expect(overlayLock).toBeGreaterThan(sendGuard);
  });

  it('ignores desktop slash command broadcasts for other mounted session panes', () => {
    const subscription = sessionViewSource.indexOf('onDesktopCommandTriggered((payload) => {');
    const sessionGuard = sessionViewSource.indexOf('payload.sessionId !== sessionId', subscription);
    const helpBranch = sessionViewSource.indexOf("payload.command === 'help'", sessionGuard);

    expect(subscription).toBeGreaterThan(-1);
    expect(sessionGuard).toBeGreaterThan(subscription);
    expect(helpBranch).toBeGreaterThan(sessionGuard);
  });
});
