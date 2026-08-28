import { describe, expect, it, vi } from 'vitest';

import {
  isXdOpenAiCodexProviderTransition,
  relinkCodexProviderThread,
} from '../codexProviderThreadRelink.js';

const source = {
  sdkSessionId: 'thread-xd',
  workingDir: '/work',
  model: 'codex/gpt-5.6-sol',
  providerId: 'xd',
  effort: 'xhigh',
  fastMode: true,
};

const target = {
  model: 'gpt-5.6-sol',
  providerId: 'openai',
  effort: 'high',
  fastMode: false,
};

describe('isXdOpenAiCodexProviderTransition', () => {
  it('accepts only the two intended credential-family directions', () => {
    expect(isXdOpenAiCodexProviderTransition('xd', 'openai')).toBe(true);
    expect(isXdOpenAiCodexProviderTransition('openai', 'xd')).toBe(true);
    expect(isXdOpenAiCodexProviderTransition('xd', 'xai')).toBe(false);
    expect(isXdOpenAiCodexProviderTransition(null, 'openai')).toBe(false);
    expect(isXdOpenAiCodexProviderTransition('openai', 'openai')).toBe(false);
  });
});

describe('relinkCodexProviderThread', () => {
  it('forks with source credentials and CAS-commits the full target route', async () => {
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-openai' }));
    const commit = vi.fn(async () => true);

    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => source), fork, commit },
        { sessionId: 'session-1', target },
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
      source,
      newSdkSessionId: 'thread-openai',
      target,
    });
  });

  it('does not fork when the task has no persisted native thread', async () => {
    const fork = vi.fn();
    const commit = vi.fn();
    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => ({ ...source, sdkSessionId: null })), fork, commit },
        { sessionId: 'session-1', target },
      ),
    ).resolves.toBeNull();
    expect(fork).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when the source tuple is superseded before CAS commit', async () => {
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => source),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai' })),
          commit: vi.fn(async () => false),
        },
        { sessionId: 'session-1', target },
      ),
    ).rejects.toThrow(/superseded/);
  });
});
