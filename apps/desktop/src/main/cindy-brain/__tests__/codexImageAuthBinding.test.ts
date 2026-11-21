
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPooledCodexImageChannel, getCodexImageAuthBinding, setCodexImageAuthBinding } from '../codexImageAuthBinding.js';

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

  it('checks the selected pool and dispatches with its leased account', async () => {
    const providerId = 'openai-sub-12345678';
    const model = `${providerId}/gpt-image-2`;
    const readLegacyAuth = vi.fn();
    let readyProvider = 'openai';
    const hasPoolAuth = vi.fn(id => id === readyProvider);
    const auth = {
      getAuth: vi.fn(async () => ({ accessToken: 'fake-pool-token', accountId: 'fake-pool-account' })),
      assertDispatchable: vi.fn(),
      onAuthFailure: vi.fn(),
      release: vi.fn(),
    };
    const acquirePoolAuth = vi.fn(async () => auth);
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: 'fixture' }] }));
    setCodexImageAuthBinding({ hasPoolAuth, acquirePoolAuth, getAuth: readLegacyAuth, onAuthFailure: vi.fn() });
    const channel = createPooledCodexImageChannel(providerId, { fetchImplementation });

    expect(channel.ready()).toBe(false);
    expect(hasPoolAuth).toHaveBeenCalledWith(providerId);
    readyProvider = providerId;
    expect(channel.ready()).toBe(true);
    await expect(channel.generateImage({ model, prompt: 'fixture' })).resolves.toEqual({
      data: [{ b64_json: 'fixture' }],
    });
    expect(acquirePoolAuth).toHaveBeenCalledExactlyOnceWith(providerId, model);
    expect(fetchImplementation).toHaveBeenCalledWith(expect.stringContaining('/codex/images/generations'),
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer fake-pool-token', 'ChatGPT-Account-Id': 'fake-pool-account',
      }) }));
    expect(readLegacyAuth).not.toHaveBeenCalled();
    expect(auth.release).toHaveBeenCalledOnce();

    auth.assertDispatchable.mockImplementation(() => { throw new Error('Account moved'); });
    await expect(channel.generateImage({ model, prompt: 'fixture' })).rejects.toThrow('Account moved');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(auth.release).toHaveBeenCalledTimes(2);
  });

});
