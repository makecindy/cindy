// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discard: vi.fn(), currentId: 'draft-1' as string | null }));
vi.mock('../../provisionalDraftTask', () => ({
  provisionalDraftTaskId: () => mocks.currentId,
  discardProvisionalDraftTask: async (shouldDiscard: () => boolean = () => true) => {
    if (shouldDiscard()) mocks.discard();
  },
}));

import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import {
  armDetachedVoiceDraftPersist,
  clearArmedDetachedVoiceDraft,
  settleArmedDetachedVoiceDraft,
} from '@/components/new-chat/composerSendOwnership';
import { useProvisionalDraftEmptyCleanup } from '../useProvisionalDraftEmptyCleanup';

const draftKey = 'provisional-cleanup-test';
let titlePreview: unknown = 'default';
const refreshTitle = vi.fn(() => { titlePreview = getDraft(draftKey)?.text ?? null; });
function save(text: string) {
  saveDraft(draftKey, { text: plainTextToTiptapDoc(text), attachments: [] }, { silent: true });
}
function mount() {
  return renderHook(() => useProvisionalDraftEmptyCleanup(draftKey, refreshTitle));
}

// Unit regression for the 2026-10-23 report: voice preview was visible while
// the saved editor document was empty. The lifecycle tests never mounted the
// draft-content subscriber or advanced its empty timer. This hook needs jsdom;
// the non-React provisional task tests remain in their existing node file.
describe('provisional draft empty cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.currentId = 'draft-1';
    clearDraft(draftKey);
  });
  afterEach(() => {
    cleanup();
    clearArmedDetachedVoiceDraft();
    clearDraft(draftKey);
    vi.useRealTimers();
  });

  it('keeps the task throughout recording and refinement despite empty editor saves', () => {
    const { result } = mount();
    act(() => {
      result.current.armEmptyCheck(60_000);
      result.current.onVoiceBusyChange(true);
      save('');
      vi.advanceTimersByTime(120_000);
    });
    expect(mocks.discard).not.toHaveBeenCalled();
    act(() => {
      save('Recognized words');
      result.current.onVoiceBusyChange(false);
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('removes an empty task once voice input ends without any content', () => {
    const { result } = mount();
    act(() => {
      result.current.onVoiceBusyChange(true);
      save('');
      result.current.onVoiceBusyChange(false);
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending empty cleanup when typing resumes, but still handles explicit clearing', () => {
    mount();
    act(() => {
      save('');
      vi.advanceTimersByTime(900);
      save('Continue typing');
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).not.toHaveBeenCalled();
    act(() => {
      clearDraft(draftKey);
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.discard).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('handles navigation while voice busy is %s', (busy) => {
    const { result, unmount } = mount();
    act(() => {
      result.current.onVoiceBusyChange(busy);
      save('');
    });
    unmount();
    expect(mocks.discard).toHaveBeenCalledTimes(busy ? 0 : 1);
  });

  // PR #6956 review: unmount stops the React subscriber, so exercise the real
  // detached persistence completion too. Empty ASR must remove only its source
  // task; text or a replacement task must survive (unit, fake timers).
  it.each([
    { text: '', replacement: false, discarded: 1 },
    { text: 'Recognized words', replacement: false, discarded: 0 },
    { text: '', replacement: true, discarded: 0 },
  ])('settles detached voice: $text, replacement=$replacement', ({ text, replacement, discarded }) => {
    const { result, unmount } = mount();
    act(() => result.current.onVoiceBusyChange(true));
    armDetachedVoiceDraftPersist(draftKey, '', result.current.onVoiceDetached());
    unmount();
    expect(mocks.discard).not.toHaveBeenCalled();
    // PR #6956's second review: detached completion must refresh the source
    // preview after saving, and must leave a replacement task's title alone.
    titlePreview = 'default';
    if (replacement) mocks.currentId = 'draft-2';
    settleArmedDetachedVoiceDraft(text);
    expect(mocks.discard).toHaveBeenCalledTimes(discarded);
    expect(titlePreview).toEqual(replacement ? 'default' : text ? plainTextToTiptapDoc(text) : null);
  });
});
