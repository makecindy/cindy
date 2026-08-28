import { describe, expect, it, vi } from 'vitest';

import { relinkCodexProviderThread } from '../codexProviderThreadRelink.js';

describe('relinkCodexProviderThread', () => {
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
