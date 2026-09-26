import { describe, expect, it, vi } from 'vitest';
import { githubConnection } from '../git-context/githubConnection';

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
