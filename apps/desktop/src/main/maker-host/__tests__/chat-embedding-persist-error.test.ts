import { describe, expect, it } from 'vitest';

import { createIpcError } from '../../../shared/ipc-errors.js';
import { rethrowChatEmbeddingPersistError } from '../chat-embedding-persist-error.js';

describe('rethrowChatEmbeddingPersistError', () => {
  it('forwards an existing IPC error unchanged', () => {
    const original = createIpcError(
      'PRECONDITION_FAILED',
      'Chat embedding setting belongs to a stale account session.',
    );
    expect(() =>
      rethrowChatEmbeddingPersistError(original, 'Failed to save chat embedding settings'),
    ).toThrow(original);
  });

  it('rewrites filesystem failures to a stable INTERNAL code without leaking the path', () => {
    const leakedPath =
      '/Users/example/Library/Application Support/Cindy/owners/abc/chat-embedding-settings.json';
    try {
      rethrowChatEmbeddingPersistError(
        new Error(`ENOENT: no such file or directory, unlink '${leakedPath}'`),
        'Failed to reset chat embedding settings',
      );
      throw new Error('expected persist error to be rewritten');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: 'INTERNAL' });
      expect((error as Error).message).toBe('[INTERNAL] Failed to reset chat embedding settings');
      expect((error as Error).message).not.toContain(leakedPath);
      expect((error as Error).message).not.toContain('ENOENT');
    }
  });
});
