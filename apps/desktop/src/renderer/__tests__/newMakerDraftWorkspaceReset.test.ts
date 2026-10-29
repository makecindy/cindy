// @vitest-environment jsdom

/**
 * resetDraftWorkspaceTargets —— 「另起一段干净对话」的共享复位入口。
 *
 * 所有预填入口(/issue、通讯录引导、发送后复位)都走它。这里钉住它真的清干净:
 * 尤其 extraDirs —— 那是单次草稿的**目录读取授权**,漏掉会让新会话悄悄继承对无关
 * 本地目录的访问权(#1103 review:两个入口各自手写字段清单,都漏了它)。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetForTest,
  getDraft,
  patchCollab,
  patchDraft,
  resetDraftWorkspaceTargets,
} from '@/state/newMakerDraft';

beforeEach(() => {
  __resetForTest();
});

describe('resetDraftWorkspaceTargets', () => {
  it('清空额外目录授权', () => {
    patchDraft({ workingDir: '/Users/someone/project', extraDirs: ['/Users/someone/secrets'] });
    expect(getDraft().extraDirs).toEqual(['/Users/someone/secrets']);

    resetDraftWorkspaceTargets();
    expect(getDraft().extraDirs).toEqual([]);
  });

  it('清空工作目录和远程目标,并显式消费本次协同选择', () => {
    patchDraft({ workingDir: '/Users/someone/project' });
    patchDraft({ remoteHostId: 'host-1' });
    patchCollab({ enabled: true });
    patchDraft({ workingDir: '/Users/someone/project', deviceLinkDeviceId: 'dev-1' });

    resetDraftWorkspaceTargets();
    const draft = getDraft();
    expect(draft.workingDir).toBeNull();
    expect(draft.remoteHostId).toBeNull();
    expect(draft.deviceLinkDeviceId).toBeNull();
    expect(draft.deviceLinkDeviceName).toBeNull();
    expect(draft.collab.enabled).toBe(false);
  });

  it('不动模型 / agent 层偏好 —— 那是「我常用哪个」的记忆,与「这次跑在哪」正交', () => {
    patchDraft({ vendor: 'codex', workingDir: '/tmp/x', extraDirs: ['/tmp/y'] });
    const vendorBefore = getDraft().vendor;
    const lastByVendorBefore = getDraft().lastByVendor;

    resetDraftWorkspaceTargets();
    expect(getDraft().vendor).toBe(vendorBefore);
    expect(getDraft().lastByVendor).toEqual(lastByVendorBefore);
  });

  it('幂等:已经是干净对话态时再调一次没有副作用', () => {
    resetDraftWorkspaceTargets();
    const first = getDraft();
    resetDraftWorkspaceTargets();
    expect(getDraft()).toEqual(first);
  });
});

// #7631 unit: external draft admission must actually clear prior directory access.
// Existing tests call reset directly, so they would miss a handoff that forgot the call.
// Minimum: empty composer + old project/extra/write dirs + one confirmed external request.
it('external handoff clears old workspace authority through the production admission path', async () => {
  const { setDataOwnerGeneration, getDataOwnerGeneration } =
    await import('@/contexts/dataOwnerGeneration');
  const { clearDraft, setComposerDraftOwner } = await import('@/lib/composerDraftStore');
  const { NEW_MAKER_DRAFT_KEY } = await import('@/features/cc-agent/newMakerDraftKeys');
  const { acceptExternalTaskDraft, clearExternalTasks, getExternalTask, requestExternalTask } =
    await import('@/features/external-task/externalTaskHandoff');
  const previousOwner = getDataOwnerGeneration();
  setDataOwnerGeneration('handoff-workspace-guard', 1);
  setComposerDraftOwner('handoff-workspace-guard');
  clearDraft(NEW_MAKER_DRAFT_KEY);
  patchDraft({
    workingDir: '/old-project',
    extraDirs: ['/old-reference'],
    writableDirs: ['/old-write'],
  });
  try {
    requestExternalTask({
      type: 'external-task',
      request: {
        id: 'workspace-guard',
        expires: Date.now() + 60_000,
        question: 'Help with this app',
      },
    });
    expect(acceptExternalTaskDraft(getExternalTask()!, 'Help with this app', 'References')).toBe(
      true,
    );
    expect(getDraft().workingDir).toBeNull();
    expect(getDraft().extraDirs).toEqual([]);
    expect(getDraft().writableDirs).toEqual([]);
    expect(getDraft().remoteHostId).toBeNull();
    expect(getDraft().deviceLinkDeviceId).toBeNull();
  } finally {
    clearDraft(NEW_MAKER_DRAFT_KEY);
    clearExternalTasks();
    setDataOwnerGeneration(previousOwner.dataOwnerId, previousOwner.generation);
    setComposerDraftOwner(previousOwner.dataOwnerId);
  }
});
