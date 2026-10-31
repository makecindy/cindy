import { describe, expect, it, vi } from 'vitest';
import {
  buildMessageEditAttachments,
  commitMessageEditRewind,
  messageEditErrorText,
} from '@/session/messageEdit';

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
