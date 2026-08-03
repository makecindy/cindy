import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: vi.fn((text: string) => ({ type: 'doc', text })),
  resetDraftWorkspaceTargets: vi.fn(),
  patchDraft: vi.fn(),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: mocks.saveDraft,
  plainTextToTiptapDoc: mocks.plainTextToTiptapDoc,
}));
vi.mock('@/features/cc-agent/NewMakerDraftRoute', () => ({
  NEW_MAKER_DRAFT_KEY: 'new-maker',
}));
vi.mock('@/state/newMakerDraft', () => ({
  resetDraftWorkspaceTargets: mocks.resetDraftWorkspaceTargets,
  patchDraft: mocks.patchDraft,
}));

import { prefillContactsAiSessionDraft } from '../contacts/startContactsAiSession';

beforeEach(() => vi.clearAllMocks());

describe('prefillContactsAiSessionDraft', () => {
  it('标记一次性通讯录意图，供实际发送阶段按最终 vendor 和 workingDir 重校验', () => {
    prefillContactsAiSessionDraft('manage contacts');

    expect(mocks.saveDraft).toHaveBeenCalledWith('new-maker', {
      text: { type: 'doc', text: 'manage contacts' },
      attachments: [],
      entryIntent: 'contacts-ai-management',
    });
    expect(mocks.resetDraftWorkspaceTargets).toHaveBeenCalledOnce();
    expect(mocks.patchDraft).toHaveBeenCalledWith({ entryIntent: 'contacts-ai-management' });
    expect(mocks.resetDraftWorkspaceTargets.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.patchDraft.mock.invocationCallOrder[0],
    );
  });
});
