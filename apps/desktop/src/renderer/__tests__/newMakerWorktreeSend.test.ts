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

  it('clears starting when the first-message draft is restored after a send-before-start failure', () => {
    const restore = source.indexOf('const restoreFirstMessageDraft = () => {');
    const clearStarting = source.indexOf('clearSessionStarting(newSession.id)', restore);
    const restoreEnd = source.indexOf('};', source.indexOf('emitAutoTitlePreviewCleared(newSession.id)', restore));
    expect(restore).toBeGreaterThan(-1);
    expect(clearStarting).toBeGreaterThan(restore);
    expect(clearStarting).toBeLessThan(restoreEnd);
  });

  it('lets a confirmed-ineligible directory create a plain session while keeping the ON memory', () => {
    // 2026-08-07 裁决:探测成功且确认不合格(非 git / 无 git / 已在 worktree 内)时,
    // 勾选记忆不生效——发送 / Goal 门、worktree 副作用分支全部按普通会话放行;
    // confirmedIneligible === null(探测中 / 失败)必须仍走 fail closed。
    // Send 门与 Goal 门各有一处放行条件;Goal 的本地 worktree 使用点同样排除。
    expect(
      source.match(/&& selectedWorktree\.confirmedIneligible !== true/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    // device-link 预创建两条路径(Send / Goal)同样不得对确认不合格目录发起 worktree:create。
    expect(source).toContain('wt.confirmedIneligible !== true');
    // 确认态来源:WorktreeChipsRow 的探测回包,null 表示未确认。
    expect(source).toContain('const [wtConfirmedIneligible, setWtConfirmedIneligible]');
    expect(source).toContain('onConfirmedIneligibleChange={handleWtConfirmedIneligibleChange}');
  });

  it('keeps the first message as a session draft when background worktree creation fails', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const failedCard = source.indexOf("status: 'failed'", worktreeCreate);
    const restoreHelper = source.indexOf('const restoreFirstMessageDraft');
    const saveDraft = source.indexOf('restoreFirstMessageDraft();', failedCard);
    const restoreText = source.indexOf('plainTextToTiptapDoc(builtInSkillIntent ? builtInSkillDraftMessage : message)', restoreHelper);

    expect(worktreeCreate).toBeGreaterThan(-1);
    expect(failedCard).toBeGreaterThan(worktreeCreate);
    expect(restoreHelper).toBeGreaterThan(-1);
    expect(saveDraft).toBeGreaterThan(failedCard);
    expect(restoreText).toBeGreaterThan(restoreHelper);
    const draftSnapshot = source.indexOf('const preNavDraft = getComposerDraft(');
    expect(draftSnapshot).toBeGreaterThan(-1);
    expect(draftSnapshot).toBeLessThan(restoreHelper);
    expect(source.slice(draftSnapshot, restoreHelper)).toContain(
      'const preNavDraftDoc = opts?.recoveryDraftDoc ?? preNavDraft?.text ?? null;',
    );
    expect(source.slice(restoreHelper, restoreText)).toContain('text: preNavDraftDoc ??');
    expect(source.slice(restoreHelper, source.indexOf('emitAutoTitlePreviewCleared(newSession.id)', restoreHelper))).toContain(
      'browserComments: rehomedComments',
    );
    expect(source.slice(restoreHelper, failedCard)).toContain(
      'rewriteBrowserCommentsFromRehomedFiles(',
    );
    expect(source.slice(restoreHelper, failedCard)).toContain(
      'excludeCommentScreenshots(rehomedFiles, rehomedComments)',
    );
  });

  it('does not make the new worktree path the next New Maker default project', () => {
    expect(source).not.toContain('patchDraft({ workingDir: newDir })');
  });

  it('uses the current checkout as the safe source when branch discovery is not ready', () => {
    // Remote two-step creation (built-in and plugin engines) moved to precreateRemoteDraftWorktree,
    // whose 'HEAD' fallback is exercised in remotePrecreatedWorktree.test.ts.
    expect(source.match(/sourceBranch: wt\.sourceBranch\.trim\(\) \|\| 'HEAD'/g)).toHaveLength(1);
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
    const remoteSessionId = source.search(/const remoteSessionId\s*=\s*created\.sessionId/);
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

  // Reconnect/default preservation is exercised through the production hooks
  // in remoteDraftDefaultsCache.test.tsx, rather than source ordering.

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

  it('guards worktree handoff before slash commands can start in the base directory', () => {
    // Cross-entry race guard: hardware sends can bypass the composer button. A slash
    // command must not dispatch before the original input has reached the worktree.
    const handleSend = sessionViewSource.indexOf('const handleSend = useCallback(');
    const sendGuard = sessionViewSource.indexOf('if (sessionHandoffPreparing) return false;', handleSend);
    const dispatch = sessionViewSource.indexOf('await maybeDispatchDesktopSlashCommand(', handleSend);
    expect(sendGuard).toBeGreaterThan(handleSend);
    expect(dispatch).toBeGreaterThan(sendGuard);
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
