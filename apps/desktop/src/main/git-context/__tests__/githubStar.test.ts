import { describe, expect, it, vi } from 'vitest';
import { createGithubStar } from '../githubStar';

// Unit: fixed-repository read/write and account fence. No previous Star endpoint existed.
// Minimum inputs: 204/404, missing credentials, rejected request, owner switch during token read.
describe('Cindy GitHub Star', () => {
  function setup(status = 204) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => url === 'https://api.github.com/user'
      ? new Response(JSON.stringify({ login: 'test-user' }))
      : new Response(null, { status }));
    const readToken = vi.fn(async (): Promise<string | null> => 'fake-test-token');
    const owner = vi.fn((): string | null => 'owner:1');
    return { fetch, readToken, owner, service: createGithubStar({ fetch, readToken, owner }) };
  }
  it('only writes the fixed repository when star is explicitly invoked', async () => {
    const h = setup();
    expect(await h.service.check()).toBe(true);
    expect(h.fetch.mock.calls[1]).toEqual([
      'https://api.github.com/user/starred/makecindy/cindy',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    ]);
    expect(await h.service.star()).toBe(true);
    expect(h.fetch.mock.calls[2]).toEqual([
      'https://api.github.com/user/starred/makecindy/cindy', expect.objectContaining({ method: 'PUT' }),
    ]);
  });
  it.each([401, 403, 404, 500])('distinguishes unavailable checks from an unstarred account (%s)', async status => {
    expect(await setup(status).service.check()).toBe(status === 404 ? false : null);
  });
  it('does not request GitHub when signed out or credentials are absent', async () => {
    const h = setup();
    h.owner.mockReturnValue(null);
    expect(await h.service.star()).toBeNull();
    h.owner.mockReturnValue('owner:1');
    h.readToken.mockResolvedValue(null);
    expect(await h.service.check()).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])('does not offer Star when GitHub login verification fails (%s)', async status => {
    const h = setup(404);
    h.fetch.mockResolvedValue(new Response(null, { status }));
    expect(await h.service.check()).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
  });
  it('requires a verified account identity, not merely a stored token', async () => {
    const h = setup(404);
    h.fetch.mockResolvedValue(new Response('{}'));
    expect(await h.service.check()).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not write with credentials obtained across an owner switch', async () => {
    const h = setup();
    h.readToken.mockImplementation(async () => { h.owner.mockReturnValue('owner:2'); return 'fake'; });
    expect(await h.service.star()).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('does not expose errors or claim a failed request succeeded', async () => {
    const h = setup();
    h.fetch.mockRejectedValue(new Error('secret remote response'));
    expect(await h.service.star()).toBeNull();
  });
});
