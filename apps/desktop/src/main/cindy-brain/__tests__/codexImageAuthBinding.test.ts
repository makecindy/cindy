
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCodexImageAuthBinding, setCodexImageAuthBinding } from '../codexImageAuthBinding.js';

afterEach(() => setCodexImageAuthBinding(null));

describe('codexImageAuthBinding', () => {
  it('fail closed before assembly and returns the statically injected callbacks', async () => {
    expect(() => getCodexImageAuthBinding()).toThrow('not configured');

    const getAuth = vi.fn(async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }));
    const onAuthFailure = vi.fn(async () => true);
    setCodexImageAuthBinding({ getAuth, onAuthFailure });

    await expect(getCodexImageAuthBinding().getAuth()).resolves.toEqual({
      accessToken: 'fake-token',
      accountId: 'fake-account',
    });
    expect(getAuth).toHaveBeenCalledOnce();
    await getCodexImageAuthBinding().onAuthFailure({
      status: 401,
      body: 'token_invalidated',
      failedAccessToken: 'fake-token',
    });
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });
});
