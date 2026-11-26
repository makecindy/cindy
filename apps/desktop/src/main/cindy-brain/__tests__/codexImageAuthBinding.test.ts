
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountCodexImageChannel, getCodexImageAuthBinding, setCodexImageAuthBinding } from '../codexImageAuthBinding.js';

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
    const provider = {
      ...BUNDLED_CATALOG.providers.find(candidate => candidate.id === 'openai')!,
      id: providerId, subscriptionPool: 'openai' as const,
    };
    const readLegacyAuth = vi.fn();
    let readyProvider = 'openai';
    const hasPoolImageAuth = vi.fn(id => id === readyProvider);
    const auth = {
      getAuth: vi.fn(async () => ({ accessToken: 'fake-pool-token', accountId: 'fake-pool-account' })),
      assertDispatchable: vi.fn(),
      onAuthFailure: vi.fn(),
      release: vi.fn(),
    };
    const acquireAuth = vi.fn(async () => auth);
    const fetchImplementation = vi.fn(async (
      _url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1], guard?: () => void,
    ) => {
      guard?.();
      return Response.json({ data: [{ b64_json: 'fixture' }] });
    });
    setCodexImageAuthBinding({ hasPoolImageAuth, acquireAuth, getAuth: readLegacyAuth, onAuthFailure: vi.fn() });
    const channel = createAccountCodexImageChannel(providerId, () => provider, { fetchImplementation });

    expect(channel.ready()).toBe(false);
    expect(hasPoolImageAuth).toHaveBeenCalledWith(providerId);
    readyProvider = providerId;
    expect(channel.ready()).toBe(true);
    await expect(channel.generateImage({ model, prompt: 'fixture' })).resolves.toEqual({
      data: [{ b64_json: 'fixture' }],
    });
    expect(acquireAuth).toHaveBeenCalledExactlyOnceWith(providerId, model, false);
    expect(fetchImplementation).toHaveBeenCalledWith(expect.stringContaining('/codex/images/generations'),
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer fake-pool-token', 'ChatGPT-Account-Id': 'fake-pool-account',
      }) }), expect.any(Function));
    expect(readLegacyAuth).not.toHaveBeenCalled();
    expect(auth.release).toHaveBeenCalledOnce();

    auth.assertDispatchable.mockImplementation(() => { throw new Error('Account moved'); });
    await expect(channel.generateImage({ model, prompt: 'fixture' })).rejects.toThrow('Account moved');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(auth.release).toHaveBeenCalledTimes(2);
  });

});
