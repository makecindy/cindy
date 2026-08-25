// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';

describe('cleanupStagedChatAttachmentFiles', () => {
  let cleanupStagedChatAttachments: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanupStagedChatAttachments = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { cleanupStagedChatAttachments },
    });
  });

  it('cleans private draft copies without deleting historical shared paths', () => {
    cleanupStagedChatAttachmentFiles([
      { path: 'C:\\cache\\draft.bin' },
      { path: 'C:\\cache\\draft.bin' },
      { path: 'C:\\cache\\history.bin', cachePathShared: true },
      { path: 'C:\\cache\\preview.png' },
    ]);

    expect(cleanupStagedChatAttachments).toHaveBeenCalledWith(['C:\\cache\\draft.bin']);
  });

  it('does not call Main when every staged path is shared', () => {
    cleanupStagedChatAttachmentFiles([
      { path: 'C:\\cache\\history.bin', cachePathShared: true },
    ]);

    expect(cleanupStagedChatAttachments).not.toHaveBeenCalled();
  });
});
