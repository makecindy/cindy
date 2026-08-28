import { describe, expect, it, vi } from 'vitest';

import {
  CodexProviderThreadRelinkCompensationRequiredError,
  commitCodexProviderThreadRelinkWithBoundaryGuard,
  relinkCodexProviderThread,
  rollbackPersistedCodexRuntimeSelection,
} from '../codexProviderThreadRelink.js';

describe('relinkCodexProviderThread', () => {
  it('atomically restores thread and route when teardown follows route persistence', async () => {
    let persisted = {
      sdkSessionId: 'thread-new' as string | null,
      model: 'gpt-5.6-sol',
      providerId: 'openai' as string | null,
      effort: 'xhigh',
      fastMode: true,
    };
    const restore = vi.fn(async ({ expected, previous }) => {
      if (JSON.stringify(persisted) !== JSON.stringify(expected)) return false;
      persisted = previous;
      return true;
    });

    // Simulate teardown beginning during a later projection await, after both writes landed.
    await Promise.resolve();
    await expect(
      rollbackPersistedCodexRuntimeSelection({
        previous: {
          sdkSessionId: 'thread-old',
          model: 'deepseek/deepseek-v4-pro',
          providerId: 'xd',
          effort: 'high',
          fastMode: false,
        },
        appliedRoute: {
          model: 'gpt-5.6-sol',
          providerId: 'openai',
          effort: 'xhigh',
          fastMode: true,
        },
        relinkReceipt: {
          previousSdkSessionId: 'thread-old',
          newSdkSessionId: 'thread-new',
        },
        restore,
      }),
    ).resolves.toBe(true);

    expect(restore).toHaveBeenCalledOnce();
    expect(persisted).toEqual({
      sdkSessionId: 'thread-old',
      model: 'deepseek/deepseek-v4-pro',
      providerId: 'xd',
      effort: 'high',
      fastMode: false,
    });
  });

  it.each(['account switch', 'teardown', 'client epoch change'])(
    'rolls back a CAS when %s happens while the write is awaiting',
    async () => {
      let boundaryCurrent = true;
      let sdkSessionId = 'thread-old';
      const rollback = vi.fn(async () => {
        if (sdkSessionId !== 'thread-new') return false;
        sdkSessionId = 'thread-old';
        return true;
      });

      await expect(
        commitCodexProviderThreadRelinkWithBoundaryGuard({
          isBoundaryCurrent: () => boundaryCurrent,
          commit: async () => {
            sdkSessionId = 'thread-new';
            boundaryCurrent = false;
            return true;
          },
          rollback,
        }),
      ).resolves.toBe(false);

      expect(rollback).toHaveBeenCalledOnce();
      expect(sdkSessionId).toBe('thread-old');
    },
  );

  it('hands off a retryable receipt when post-commit boundary rollback fails', async () => {
    let boundaryCurrent = true;
    let sdkSessionId = 'thread-old';
    const rollback = vi
      .fn(async () => false)
      .mockRejectedValueOnce(new Error('sqlite temporarily unavailable'))
      .mockImplementationOnce(async () => {
        if (sdkSessionId !== 'thread-new') return false;
        sdkSessionId = 'thread-old';
        return true;
      });
    let caught: unknown;

    try {
      await relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => ({ sdkSessionId: 'thread-old', workingDir: null })),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-new' })),
          commit: () =>
            commitCodexProviderThreadRelinkWithBoundaryGuard({
              isBoundaryCurrent: () => boundaryCurrent,
              commit: async () => {
                sdkSessionId = 'thread-new';
                boundaryCurrent = false;
                return true;
              },
              rollback,
            }),
        },
        {
          sessionId: 'session-1',
          sourceModel: 'codex/gpt-5.6-sol',
          sourceProviderId: 'xd',
          isCurrent: () => boundaryCurrent,
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexProviderThreadRelinkCompensationRequiredError);
    const receipt = (caught as CodexProviderThreadRelinkCompensationRequiredError).receipt;
    expect(receipt).toMatchObject({
      previousSdkSessionId: 'thread-old',
      newSdkSessionId: 'thread-new',
    });
    expect(sdkSessionId).toBe('thread-new');
    await expect(receipt.rollback()).resolves.toBe(true);
    expect(sdkSessionId).toBe('thread-old');
    expect(rollback).toHaveBeenCalledTimes(2);
  });

  it('treats a post-commit rollback CAS miss as a newer winner without a handoff', async () => {
    let boundaryCurrent = true;
    const rollback = vi.fn(async () => false);
    let caught: unknown;

    try {
      await relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => ({ sdkSessionId: 'thread-old', workingDir: null })),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-new' })),
          commit: () =>
            commitCodexProviderThreadRelinkWithBoundaryGuard({
              isBoundaryCurrent: () => boundaryCurrent,
              commit: async () => {
                boundaryCurrent = false;
                return true;
              },
              rollback,
            }),
        },
        {
          sessionId: 'session-1',
          sourceModel: 'codex/gpt-5.6-sol',
          sourceProviderId: 'xd',
          isCurrent: () => boundaryCurrent,
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CodexProviderThreadRelinkCompensationRequiredError);
    expect((caught as Error).message).toMatch(/superseded/);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('forks a provider-neutral history and CAS-relinks the Cindy session', async () => {
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-openai' }));
    const commit = vi.fn(async () => true);
    const onCommitted = vi.fn();

    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => ({
            sdkSessionId: 'thread-xd',
            workingDir: '/work',
          })),
          fork,
          commit,
          onCommitted,
        },
        {
          sessionId: 'session-1',
          sourceModel: 'codex/gpt-5.6-sol',
          sourceProviderId: 'xd',
        },
      ),
    ).resolves.toEqual({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
    });

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: 'thread-xd',
      sourceModel: 'codex/gpt-5.6-sol',
      sourceProviderId: 'xd',
      workingDir: '/work',
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      expectedSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
    });
    expect(onCommitted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
    });
  });

  it('keeps the restart tuple on the source route until fork and atomic commit complete', async () => {
    let persisted = {
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'medium',
      fastMode: false,
    };
    let releaseFork!: () => void;
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    const fork = vi.fn(async () => {
      await forkGate;
      return { newSdkSessionId: 'thread-openai' };
    });
    const relinking = relinkCodexProviderThread(
      {
        readSource: vi.fn(async () => ({
          sdkSessionId: persisted.sdkSessionId,
          workingDir: null,
        })),
        fork,
        commit: vi.fn(async ({ expectedSdkSessionId, newSdkSessionId }) => {
          if (
            persisted.sdkSessionId !== expectedSdkSessionId ||
            persisted.model !== 'codex/gpt-5.6-sol' ||
            persisted.providerId !== 'xd' ||
            persisted.effort !== 'medium' ||
            persisted.fastMode !== false
          ) {
            return false;
          }
          persisted = {
            sdkSessionId: newSdkSessionId,
            model: 'gpt-5.6-sol',
            providerId: 'openai',
            effort: 'xhigh',
            fastMode: true,
          };
          return true;
        }),
      },
      {
        sessionId: 'session-1',
        sourceModel: 'codex/gpt-5.6-sol',
        sourceProviderId: 'xd',
      },
    );

    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce());
    // Simulated process exit here restarts with a source provider and its own source thread.
    expect(persisted).toEqual({
      sdkSessionId: 'thread-xd',
      model: 'codex/gpt-5.6-sol',
      providerId: 'xd',
      effort: 'medium',
      fastMode: false,
    });

    releaseFork();
    await relinking;
    expect(persisted).toEqual({
      sdkSessionId: 'thread-openai',
      model: 'gpt-5.6-sol',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
    });
  });

  it('does nothing when the Cindy session has no native thread yet', async () => {
    const fork = vi.fn();
    const commit = vi.fn();

    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => ({ sdkSessionId: null, workingDir: '/work' })),
          fork,
          commit,
        },
        {
          sessionId: 'session-1',
          sourceModel: 'codex/gpt-5.6-sol',
          sourceProviderId: 'xd',
        },
      ),
    ).resolves.toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when another owner replaces the thread before CAS commit', async () => {
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => ({
            sdkSessionId: 'thread-xd',
            workingDir: null,
          })),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai' })),
          commit: vi.fn(async () => false),
        },
        {
          sessionId: 'session-1',
          sourceModel: 'codex/gpt-5.6-sol',
          sourceProviderId: 'xd',
        },
      ),
    ).rejects.toThrow(/superseded/);
  });

  it('passes the pending generation guard into the CAS commit', async () => {
    const isCurrent = vi.fn(() => true);
    const commit = vi.fn(async () => true);

    await relinkCodexProviderThread(
      {
        readSource: vi.fn(async () => ({ sdkSessionId: 'thread-old', workingDir: null })),
        fork: vi.fn(async () => ({ newSdkSessionId: 'thread-new' })),
        commit,
      },
      {
        sessionId: 'session-1',
        sourceModel: 'gpt-5.6-sol',
        sourceProviderId: 'openai',
        isCurrent,
      },
    );

    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      expectedSdkSessionId: 'thread-old',
      newSdkSessionId: 'thread-new',
      isCurrent,
    });
  });

  it('uses the source thread identity when the route store already contains the target', async () => {
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-gateway' }));

    await relinkCodexProviderThread(
      {
        readSource: vi.fn(async () => ({ sdkSessionId: 'thread-openai', workingDir: null })),
        fork,
        commit: vi.fn(async () => true),
      },
      {
        sessionId: 'session-1',
        sourceModel: 'deepseek/deepseek-v4-pro',
        sourceProviderId: 'deepseek',
        sourceThreadModelProviderId: 'cindy_openai',
      },
    );

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: 'thread-openai',
      sourceModel: 'deepseek/deepseek-v4-pro',
      sourceProviderId: 'openai',
    });
  });
});
