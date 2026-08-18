import { describe, expect, it, vi } from 'vitest';

import {
  CodexThreadRotationSupersededError,
  createCodexThreadRotationPreparer,
} from '../codexThreadRotation.js';

describe('createCodexThreadRotationPreparer', () => {
  const snapshot = {
    sessionId: 'session-1',
    sourceSdkSessionId: 'thread-old',
    sourceModel: 'deepseek-v4',
    sourceProviderId: 'deepseek',
    workingDir: '/work',
  };

  it('forks the full Codex history and atomically rebinds the session', async () => {
    const forkSdkSession = vi.fn(async () => ({
      newSdkSessionId: 'thread-new',
      uuidMap: new Map(),
    }));
    const replaceSdkSessionIdIfCurrent = vi.fn(async () => true);
    const prepare = createCodexThreadRotationPreparer({
      maker: { forkSdkSession },
      replaceSdkSessionIdIfCurrent,
    });

    const prepared = await prepare(snapshot);

    expect(forkSdkSession).toHaveBeenCalledWith('codex', {
      sourceSdkSessionId: 'thread-old',
      model: 'deepseek-v4',
      providerId: 'deepseek',
      workingDir: '/work',
      upToMessageId: undefined,
      stripEncryptedReasoning: true,
    });
    expect(replaceSdkSessionIdIfCurrent).toHaveBeenCalledWith(
      'session-1',
      'thread-old',
      'thread-new',
    );
    expect(prepared.newSdkSessionId).toBe('thread-new');
  });

  it('reports a superseded rotation when a newer lifecycle changed the session binding', async () => {
    const prepare = createCodexThreadRotationPreparer({
      maker: {
        forkSdkSession: vi.fn(async () => ({
          newSdkSessionId: 'thread-new',
          uuidMap: new Map(),
        })),
      },
      replaceSdkSessionIdIfCurrent: vi.fn(async () => false),
    });

    await expect(prepare(snapshot)).rejects.toBeInstanceOf(
      CodexThreadRotationSupersededError,
    );
  });

  it('rolls the database binding back if closing the old live session fails', async () => {
    const replaceSdkSessionIdIfCurrent = vi
      .fn<(sessionId: string, expected: string, next: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    const prepare = createCodexThreadRotationPreparer({
      maker: {
        forkSdkSession: vi.fn(async () => ({
          newSdkSessionId: 'thread-new',
          uuidMap: new Map(),
        })),
      },
      replaceSdkSessionIdIfCurrent,
    });

    const prepared = await prepare(snapshot);
    await prepared.rollback();

    expect(replaceSdkSessionIdIfCurrent).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'thread-new',
      'thread-old',
    );
  });
});
