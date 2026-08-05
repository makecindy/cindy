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
    const worktreeBranch = source.indexOf('if (!isRemoteProjectDraft && wt.enabled) {');
    const createSession = source.indexOf('const newSession = await createSession', worktreeBranch);
    const touchUserSend = source.indexOf('sessionService.touchUserSend', createSession);
    // worktree 创建期的视觉反馈走 worktreeCreationStore(由 CCAgentSessionView 底部
    // workingDir chip 行订阅渲染),不再插 chat-stream SystemCard。
    const statusCard = source.indexOf("worktreeCreationStore.set(newSession.id", touchUserSend);
    const navigate = source.indexOf('navigate(`/cc-agent/$' + '{newSession.id}`', statusCard);
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate', navigate);

    expect(worktreeBranch).toBeGreaterThan(-1);
    expect(createSession).toBeGreaterThan(worktreeBranch);
    expect(touchUserSend).toBeGreaterThan(createSession);
    expect(statusCard).toBeGreaterThan(touchUserSend);
    expect(navigate).toBeGreaterThan(statusCard);
    expect(worktreeCreate).toBeGreaterThan(navigate);
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

  it('does not auto-send if the prepared session is no longer active', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const latestSession = source.indexOf('const latestSession = await sessionService.get(newSession.id)', worktreeCreate);
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
    const sendGuard = sessionViewSource.indexOf('if (worktreePreparing) return false', worktreePreparing);
    const overlayLock = sessionViewSource.indexOf('worktreePreparing && smoothedBranchName', sendGuard);

    expect(hookSubscription).toBeGreaterThan(-1);
    expect(rawDerive).toBeGreaterThan(hookSubscription);
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
