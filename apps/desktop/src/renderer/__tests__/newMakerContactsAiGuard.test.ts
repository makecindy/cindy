import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../features/cc-agent/NewMakerDraftRoute.tsx', import.meta.url),
  'utf8',
).replaceAll('\r', '');
const sessionViewSource = readFileSync(
  new URL('../features/cc-agent/CCAgentSessionView.tsx', import.meta.url),
  'utf8',
).replaceAll('\r', '');

function sliceBetween(start: string, end: string): string {
  const startAt = source.indexOf(start);
  expect(startAt).toBeGreaterThan(-1);
  const endAt = source.indexOf(end, startAt);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('New Maker contacts AI guard wiring', () => {
  it('新建目标在任何 session / runtime 副作用前复用发送 guard', () => {
    const handler = sliceBetween(
      'const handleCreateGoal = useCallback(',
      'const handleBeforeVoiceInputStart = useCallback(',
    );
    const authAt = handler.indexOf('await vendorAuthGate.checkAndConfirm(authVendor');
    const guardAt = handler.indexOf('await checkContactsAiSessionBeforeSend({');
    const remoteCreateAt = handler.indexOf(".invoke(deviceId, 'maker:create-session'");
    const localCreateAt = handler.indexOf('const newSession = await createSession({');

    expect(authAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(authAt);
    expect(remoteCreateAt).toBeGreaterThan(guardAt);
    expect(localCreateAt).toBeGreaterThan(guardAt);
    expect(handler.slice(guardAt, remoteCreateAt)).toContain(
      'entryIntent: entryIntentAtGoalCreate',
    );
    expect(handler.slice(guardAt, remoteCreateAt)).toContain(
      'isLocalTarget: !isDeviceLinkDraft && !effectiveRemoteHostId',
    );
    expect(handler.slice(guardAt, remoteCreateAt)).toContain(
      'throw new Error(t(contactsAiSessionBlockMessageKey(contactsBlockReason)))',
    );
    expect(handler.slice(authAt, remoteCreateAt)).toContain(
      'if (!isCurrentGoalDataOwner()) return;',
    );
    expect(
      handler.slice(authAt, remoteCreateAt).match(/if \(!isCurrentGoalDataOwner\(\)\) return;/g),
    ).toHaveLength(2);

    // 失败在上面的 throw 结束；远端和本地各自都只在创建并启动目标后消费一次性意图。
    expect(handler.indexOf('resetDraftWorkspaceAfterSend()')).toBeGreaterThan(remoteCreateAt);
    expect(handler.lastIndexOf('resetDraftWorkspaceAfterSend()')).toBeGreaterThan(localCreateAt);
  });

  it('本地 worktree 延迟到 source branch 的真实 newDir 再校验', () => {
    const send = sliceBetween(
      'const handleSend = useCallback(',
      '// 首页「新建目标」:精简本地 create 路径',
    );
    expect(send).toContain("entryIntentAtSend === 'contacts-ai-management'");
    expect(send).toContain('selectedWorktree.enabled &&');
    expect(send).toContain('Boolean(selectedWorktree.baseRepo)');
    expect(send).toContain('if (!deferContactsCheckUntilLocalWorktree) {');

    const worktree = send.slice(send.indexOf('const newDir = resp.meta.path;'));
    const guardAt = worktree.indexOf('await checkContactsAiSessionBeforeSend({');
    const updateAt = worktree.indexOf('await sessionService.update(newSession.id');
    const sendAt = worktree.indexOf('await makerChatStore.sendMessage(');

    expect(guardAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(guardAt);
    expect(sendAt).toBeGreaterThan(updateAt);
    expect(worktree.slice(guardAt, updateAt)).toContain('workingDir: newDir');
    expect(worktree.slice(guardAt, updateAt)).toContain('restoreFirstMessageDraft();');
    expect(worktree.slice(guardAt, updateAt)).toContain('return;');
  });

  it('session handoff 保留意图，并在恢复后的已有会话发送前再次校验', () => {
    const remoteProject = sliceBetween(
      'const handleRemoteProjectAdded = useCallback(',
      '// ─── 切 vendor',
    );
    expect(remoteProject).toContain('const existingDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY)');
    expect(remoteProject).toContain(
      'saveComposerDraft(newSession.id, {\n            ...existingDraft,',
    );

    const send = sliceBetween(
      'const handleSend = useCallback(',
      '// 首页「新建目标」:精简本地 create 路径',
    );
    expect(send).toContain('...(entryIntentAtSend ? { entryIntent: entryIntentAtSend } : {}),');

    const sessionSend = sessionViewSource.slice(
      sessionViewSource.indexOf('const handleSend = useCallback('),
      sessionViewSource.indexOf('const handleStopSession = useCallback('),
    );
    const authAt = sessionSend.indexOf('await vendorAuthGate.checkAndConfirm(authVendor');
    const guardAt = sessionSend.indexOf('await checkContactsAiSessionBeforeSend({');
    const dispatchAt = sessionSend.indexOf('const dispatch =');
    expect(authAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(authAt);
    expect(dispatchAt).toBeGreaterThan(guardAt);
    expect(sessionSend.slice(guardAt, dispatchAt)).toContain(
      'getComposerDraft(sessionId)?.entryIntent',
    );
    expect(sessionSend.slice(guardAt, dispatchAt)).toContain(
      'isLocalTarget: !remoteDeviceId && !session?.remoteHostId',
    );
    expect(sessionSend.slice(guardAt, dispatchAt)).toContain('return false;');
  });

  it('worktree 校验失败前不清除通讯录入口意图', () => {
    const send = sliceBetween(
      'const handleSend = useCallback(',
      '// 首页「新建目标」:精简本地 create 路径',
    );
    const navigateAt = send.indexOf('navigate(`/cc-agent/${newSession.id}`');
    const newDirAt = send.indexOf('const newDir = resp.meta.path;', navigateAt);
    const deferredResetAt = send.indexOf(
      'if (\n                  deferContactsCheckUntilLocalWorktree &&',
      newDirAt,
    );
    const blockAt = send.indexOf('if (contactsBlockReason) {', newDirAt);

    expect(navigateAt).toBeGreaterThan(-1);
    expect(send.slice(navigateAt, newDirAt)).toContain(
      'if (!deferContactsCheckUntilLocalWorktree) resetDraftWorkspaceAfterSend();',
    );
    expect(blockAt).toBeGreaterThan(newDirAt);
    expect(deferredResetAt).toBeGreaterThan(blockAt);
  });
});
