import { describe, expect, it, vi } from 'vitest';

import { createVerifiedResumeSession } from '../resumeSessionProvider.js';

describe('createVerifiedResumeSession', () => {
  it('materializes the implicit DeepSeek provider before Maker resumes a historical null route', async () => {
    const opts = {
      id: 'historical-deepseek-task',
      resumeSessionId: 'codex-thread-id',
      agentKind: 'codex' as const,
      model: 'deepseek-v4-flash',
      providerId: null,
    };
    const resolveImplicitUserProvider = vi.fn(async () => 'deepseek');
    const createSession = vi.fn(async (received: typeof opts) => ({ id: received.id }));

    await expect(createVerifiedResumeSession(opts, true, {
      resolveImplicitUserProvider,
      createSession,
    })).resolves.toEqual({ id: 'historical-deepseek-task' });

    expect(resolveImplicitUserProvider).toHaveBeenCalledWith('codex', 'deepseek-v4-flash');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek',
    }));
    expect(resolveImplicitUserProvider.mock.invocationCallOrder[0]).toBeLessThan(
      createSession.mock.invocationCallOrder[0]!,
    );
  });

  it('does not reinterpret a new session or an explicit provider route', async () => {
    const resolveImplicitUserProvider = vi.fn(async () => 'deepseek');
    const createSession = vi.fn(async (opts: {
      agentKind: 'codex';
      model: string;
      providerId: string | null;
    }) => opts.providerId);

    await expect(createVerifiedResumeSession({
      agentKind: 'codex',
      model: 'deepseek-v4-flash',
      providerId: null,
    }, false, {
      resolveImplicitUserProvider,
      createSession,
    })).resolves.toBeNull();
    await expect(createVerifiedResumeSession({
      agentKind: 'codex',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek-secondary',
    }, true, {
      resolveImplicitUserProvider,
      createSession,
    })).resolves.toBe('deepseek-secondary');

    expect(resolveImplicitUserProvider).not.toHaveBeenCalled();
  });
});
