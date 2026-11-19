import { describe, expect, it, vi } from 'vitest';
import { connectGithubSignInResult, githubConnection } from '../git-context/githubConnection';

describe('GitHub account verification', () => {
  it('verifies the selected credential without returning secrets or unrelated user data', async () => {
    const fallback = vi.fn(() => 'fake-fallback');
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ login: 'test-user', email: 'private' })),
    );
    expect(
      await githubConnection({
        readGh: async () => 'fake-gh',
        readFallback: fallback,
        fetch: fetcher,
      }),
    ).toEqual({ status: 'connected', source: 'gh-cli', login: 'test-user' });
    expect(fallback).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it('uses the fallback only when no local credential is available', async () => {
    expect(
      await githubConnection({
        readGh: async () => null,
        readFallback: () => 'fake',
        fetch: async () => new Response('{"login":"test"}'),
      }),
    ).toEqual({ status: 'connected', source: 'token', login: 'test' });
    const fetcher = vi.fn();
    expect(
      await githubConnection({
        readGh: async () => null,
        readFallback: () => null,
        fetch: fetcher,
      }),
    ).toEqual({ status: 'missing' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('silently rechecks network failures and prompts only when the credential is rejected', async () => {
    const readConnection = vi.fn<Parameters<typeof connectGithubSignInResult>[2]['readConnection']>();
    const openSignIn = vi.fn(() => true);
    const connect = () => connectGithubSignInResult('github', false, { readConnection, openSignIn });
    readConnection.mockResolvedValueOnce({ status: 'network' }).mockResolvedValueOnce({ status: 'connected', login: 'octo', source: 'gh-cli' });
    expect(await connect()).toMatchObject({ ok: true });
    readConnection.mockResolvedValue({ status: 'network' });
    expect(await connect()).toMatchObject({ connection: 'network', signInOpened: false });
    readConnection.mockResolvedValueOnce({ status: 'forbidden' });
    expect(await connect()).toMatchObject({ connection: 'forbidden', signInOpened: false });
    expect(openSignIn).not.toHaveBeenCalled();
    readConnection.mockResolvedValueOnce({ status: 'auth' });
    expect(await connect()).toMatchObject({ signInOpened: true });
  });

  // Unit regression for PR #11413: a real 429 from /user must not trigger the
  // transient-network recheck or prompt the user to replace their credential.
  it('reports HTTP 429 after a single credential check', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));
    const openSignIn = vi.fn(() => true);
    const result = await connectGithubSignInResult('github', false, {
      readConnection: () => githubConnection({
        readGh: async () => 'fake-gh',
        readFallback: () => null,
        fetch: fetcher,
      }),
      openSignIn,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'GITHUB_ACCESS_FORBIDDEN',
      signInOpened: false,
    });
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [500, 'network'],
  ] as const)('classifies HTTP %s without exposing its body', async (code, status) => {
    expect(
      await githubConnection({
        readGh: async () => 'fake',
        readFallback: () => null,
        fetch: async () => new Response('private server message', { status: code }),
      }),
    ).toEqual({ status, source: 'gh-cli' });
  });
});
