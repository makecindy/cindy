import { describe, expect, it, vi } from 'vitest';
import {
  buildMessageEditAttachments,
  commitMessageEditRewind,
  mergeMessageEditDraft,
  messageEditErrorText,
} from '@/session/messageEdit';
import {
  composerDocumentProjectedText,
  emptyComposerDocument,
  textComposerDocument,
  type ComposerDocument,
} from '@/session/composerDocument';

// §3.2: edit-last-message on mobile must use the same host contract as the desktop
// edit box. A dropped requireLatestUser would let the host soft-delete newer turns;
// retrying a non-running failure would re-run a non-idempotent rewind; reusing a
// message's host references as phone uploads would make the outbox demand local bytes.
describe('commitMessageEditRewind', () => {
  it('waits out the stop tail and binds the latest-message guard plus a conversation-only preview', async () => {
    const rewindCommit = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('turn still running'), { code: 'SESSION_RUNNING' }))
      .mockResolvedValueOnce({ id: 's1' });

    await expect(commitMessageEditRewind({
      rewindCommit,
      allowFileRestore: false,
      sleep: async () => undefined,
    })).resolves.toEqual({ id: 's1' });

    expect(rewindCommit).toHaveBeenCalledTimes(2);
    expect(rewindCommit).toHaveBeenLastCalledWith({ requireLatestUser: true, allowFileRestore: false });
  });

  it('does not retry once the host says the message is no longer the latest', async () => {
    const error = new Error('[REWIND_TARGET_NOT_LATEST] newer user message');
    const rewindCommit = vi.fn().mockRejectedValue(error);

    await expect(commitMessageEditRewind({ rewindCommit, sleep: async () => undefined })).rejects.toBe(error);
    expect(rewindCommit).toHaveBeenCalledTimes(1);
    expect(rewindCommit).toHaveBeenCalledWith({ requireLatestUser: true });
    expect(messageEditErrorText(error)).toBeTruthy();
  });

  it('stops retrying when the edit is abandoned while waiting for the stop', async () => {
    let current = true;
    const running = Object.assign(new Error('running'), { code: 'SESSION_RUNNING' });
    const rewindCommit = vi.fn().mockRejectedValue(running);

    await expect(commitMessageEditRewind({
      rewindCommit,
      stillCurrent: () => current,
      sleep: async () => { current = false; },
    })).rejects.toBe(running);
    expect(rewindCommit).toHaveBeenCalledTimes(1);
  });
});

describe('buildMessageEditAttachments', () => {
  it('resends the original host references instead of phone uploads', () => {
    expect(buildMessageEditAttachments([
      { kind: 'image', name: 'shot.png', uri: 'xdt-image://s1/shot.png', mimeType: 'image/png', previewable: false },
      { kind: 'image', name: 'pasted', uri: 'data:image/jpeg;base64,QUJD', mimeType: 'image/jpeg', previewable: true },
      { kind: 'file', name: 'spec.md', path: '/Users/me/repo/spec.md', previewable: false },
    ], 'edit:m1')).toEqual([
      expect.objectContaining({
        id: 'edit:m1:0', category: 'image', url: 'xdt-image://s1/shot.png', path: 'xdt-image://s1/shot.png',
      }),
      expect.objectContaining({
        id: 'edit:m1:1', category: 'image', base64: 'QUJD', path: 'clipboard://message-edit-2', ext: '.jpg',
      }),
      expect.objectContaining({ id: 'edit:m1:2', name: 'spec.md', path: '/Users/me/repo/spec.md', category: 'text' }),
    ]);
  });
});

// 回退提交后页面已离场:任务草稿库终态只能由库内状态推导。旧补丁用「发送是否受理」推导,
// 离场受理时库里仍是暂存草稿,再追加一次就复制两遍。
describe('mergeMessageEditDraft', () => {
  const stash = textComposerDocument('原草稿');
  const replacement = textComposerDocument('改后的消息');
  const text = (doc: ComposerDocument) => composerDocumentProjectedText(doc);

  it('keeps one copy of the stashed draft when the left-behind send never cleared it', () => {
    expect(text(mergeMessageEditDraft({ stored: stash, stash, replacement: null }))).toBe('原草稿');
  });

  it('restores the stash after a send that did clear the store', () => {
    expect(text(mergeMessageEditDraft({ stored: emptyComposerDocument(), stash, replacement: null }))).toBe('原草稿');
  });

  it('keeps the unsent replacement ahead of the stash, once each', () => {
    expect(text(mergeMessageEditDraft({ stored: stash, stash, replacement }))).toBe('改后的消息\n\n原草稿');
  });

  it('keeps a quote-only stash that has no projected text', () => {
    const quoteOnly: ComposerDocument = {
      version: 1,
      nodes: [{ type: 'quote', quote: { text: '引用内容' } } as ComposerDocument['nodes'][number]],
    };
    expect(mergeMessageEditDraft({ stored: null, stash: quoteOnly, replacement: null }).nodes).toHaveLength(1);
  });
});
