import { describe, expect, it, vi } from 'vitest';

import {
  decideCodexProviderThreadRelink,
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

  it('recognizes implicit XD Codex routes after credential identity resolution', () => {
    const implicitXd = { providerId: null, model: 'codex/gpt-5.6-sol' };
    const subscription = { providerId: 'openai', model: 'gpt-5.6-sol' };

    expect(decideCodexProviderThreadRelink(implicitXd, subscription)).toBe('relink');
    expect(decideCodexProviderThreadRelink(subscription, implicitXd)).toBe('relink');
    expect(
      decideCodexProviderThreadRelink({ providerId: null, model: 'ambiguous-model' }, subscription),
    ).toBe('unresolved');
  });
});

describe('relinkCodexProviderThread', () => {
  it.each([
    {
      name: 'implicit XD to OpenAI',
      source: { ...source, providerId: null, model: 'codex/gpt-5.6-sol' },
      target,
    },
    {
      name: 'OpenAI to implicit XD fixed-effort model',
      source: {
        ...source,
        sdkSessionId: 'thread-openai',
        providerId: 'openai',
        model: 'gpt-5.6-sol',
      },
      target: {
        model: 'codex/gpt-5.6-sol',
        providerId: null,
        effort: null,
        fastMode: true,
      },
    },
  ])('forks and CAS-commits the complete route for $name', async ({ source, target }) => {
    const cleanup = vi.fn(async () => {});
    const fork = vi.fn(async () => ({ newSdkSessionId: 'thread-replacement', cleanup }));
    const commit = vi.fn(async () => true);

    expect(decideCodexProviderThreadRelink(source, target)).toBe('relink');
    await expect(
      relinkCodexProviderThread(
        { readSource: vi.fn(async () => source), fork, commit },
        { sessionId: 'session-implicit-provider', target },
      ),
    ).resolves.toEqual({
      previousSdkSessionId: source.sdkSessionId,
      newSdkSessionId: 'thread-replacement',
    });

    expect(fork).toHaveBeenCalledWith({
      sourceSdkSessionId: source.sdkSessionId,
      sourceModel: source.model,
      sourceProviderId: source.providerId,
      workingDir: source.workingDir,
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-implicit-provider',
      source,
      newSdkSessionId: 'thread-replacement',
      target,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

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
    const cleanup = vi.fn(async () => {});
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => source),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai', cleanup })),
          commit: vi.fn(async () => false),
        },
        { sessionId: 'session-1', target },
      ),
    ).rejects.toThrow(/superseded/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves the database error when replacement cleanup also fails', async () => {
    const databaseError = new Error('route CAS failed');
    const cleanup = vi.fn(async () => {
      throw new Error('replacement cleanup failed');
    });
    await expect(
      relinkCodexProviderThread(
        {
          readSource: vi.fn(async () => source),
          fork: vi.fn(async () => ({ newSdkSessionId: 'thread-openai', cleanup })),
          commit: vi.fn(async () => {
            throw databaseError;
          }),
        },
        { sessionId: 'session-1', target },
      ),
    ).rejects.toBe(databaseError);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
