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
        { sessionId: 'session-1', model: 'gpt-5.6-sol', providerId: 'openai' },
      ),
    ).resolves.toEqual({
      previousSdkSessionId: 'thread-xd',
      newSdkSessionId: 'thread-openai',
    });

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: 'thread-xd',
      model: 'gpt-5.6-sol',
      providerId: 'openai',
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
        { sessionId: 'session-1', model: 'gpt-5.6-sol', providerId: 'openai' },
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
        { sessionId: 'session-1', model: 'gpt-5.6-sol', providerId: 'openai' },
      ),
    ).rejects.toThrow(/superseded/);
  });
});
