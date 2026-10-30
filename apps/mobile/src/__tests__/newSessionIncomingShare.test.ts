import { expect, it, vi } from 'vitest';
import { appendNewSessionSharedText, openNewSessionPluginPalette, patchNewSessionDraft } from '@/session/newSessionForm';
import { clearNewSessionAttachmentsForDeviceChange } from '@/session/newSessionAttachmentCleanup';
import { newSessionAttachment, newSessionDraft } from './fixtures/newSession';
import type { NewSessionDraft } from '@/session/newSession';
import type { RemoteSerializedAttachment } from '@/session/types';

// Unit: a share may finish uploading before the first computer is selected.
// Preserve those bytes on initial/same-host selection, discard only on a real switch.
const discard = vi.hoisted(() => vi.fn());
vi.mock('@/session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: discard }));

it.each([['', false], ['new-host', false], ['old-host', true]] as const)(
  'preserves initial shares with previous host %s (discard=%s)', (previousDeviceId, shouldDiscard) => {
    discard.mockClear();
    const shared = newSessionAttachment({ id: 'shared-attachment' });
    let attachments: RemoteSerializedAttachment[] = [shared];
    const pending = new Set(['pending-share']);
    const retained = new Set([shared.id]);
    const annotations = new Set([shared.id]);
    clearNewSessionAttachmentsForDeviceChange({
      previousDeviceId, nextDeviceId: 'new-host', attachments,
      getToken: async () => 'token', discardAllPendingUploads: () => pending.clear(),
      releaseUploadedSources: ids => ids.forEach(id => retained.delete(id)),
      setAttachments: next => { attachments = next; }, setMediaAssetAttachments: () => {},
      setAttachmentPreviews: () => {}, forgetAllAnnotations: () => annotations.clear(),
      setAttachmentError: () => {},
    });
    expect(discard).toHaveBeenCalledTimes(shouldDiscard ? 1 : 0);
    expect(attachments).toEqual(shouldDiscard ? [] : [shared]);
    expect([...pending]).toEqual(shouldDiscard ? [] : ['pending-share']);
    expect([...retained]).toEqual(shouldDiscard ? [] : [shared.id]);
    expect([...annotations]).toEqual(shouldDiscard ? [] : [shared.id]);
  },
);

it('keeps shared text when opening plugins without typing first', () => {
  let draft = newSessionDraft({ firstMessage: 'Existing instruction' });
  const firstMessageRef = { current: draft.firstMessage };
  const editRecoveredDraft = vi.fn();
  const target = {
    firstMessageRef, creatingRef: { current: false }, editRecoveredDraft,
    voiceDictionaryLearningTrackerRef: { current: null },
    setDraft: (update: NewSessionDraft | ((current: NewSessionDraft) => NewSessionDraft)) => {
      draft = typeof update === 'function' ? update(draft) : update;
    },
  };
  appendNewSessionSharedText(target, 'Shared webpage instruction');
  const selection = { current: { start: 0, end: 0 } };
  openNewSessionPluginPalette({
    firstMessageRef, patchDraft: patch => patchNewSessionDraft(target, patch),
    firstMessageSelectionRef: selection, setFirstMessageSelection: () => {}, focusComposer: () => {},
  });
  expect(draft.firstMessage).toContain('Existing instruction\n\nShared webpage instruction');
  expect(firstMessageRef.current).toBe(draft.firstMessage);
  expect(selection.current).toEqual({ start: draft.firstMessage.length, end: draft.firstMessage.length });
  expect(editRecoveredDraft).toHaveBeenCalledWith({ firstMessage: draft.firstMessage });
});
