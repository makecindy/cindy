import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupStagedChatAttachmentFiles } from '@/lib/chatAttachmentStageCleanup';

const cleanupStagedChatAttachments = vi.fn(async () => undefined);
let previousWindow: typeof globalThis.window | undefined;

beforeAll(() => {
  previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { cleanupStagedChatAttachments } },
  });
});

afterAll(() => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

beforeEach(() => {
  cleanupStagedChatAttachments.mockClear();
});

describe('cleanupStagedChatAttachmentFiles', () => {
  it('does not delete a staged path shared with a queued message', () => {
    cleanupStagedChatAttachmentFiles([
      { path: 'C:\\cache\\owned.bin', stagedPathShared: true },
      { path: 'C:\\cache\\draft.bin' },
    ]);

    expect(cleanupStagedChatAttachments).toHaveBeenCalledWith(['C:\\cache\\draft.bin']);
  });
});
