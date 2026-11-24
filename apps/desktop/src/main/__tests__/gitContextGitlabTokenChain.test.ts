import { describe, expect, it, vi } from 'vitest';
import { createGitlabTokenChain } from '../git-context/gitlabTokenChain';
import type { GlabTokenResult } from '../git-context/glabCliTokenSource';

function glab(result: GlabTokenResult) {
  return {
    readTokenDetailed: vi.fn(async () => result),
    rejectToken: vi.fn(),
    invalidateNegativeCache: vi.fn(),
  };
}

describe('GitLab token chain', () => {
  it('prefers the local glab sign-in', async () => {
    const pluginToken = vi.fn(() => 'plugin-token');
    const chain = createGitlabTokenChain({ glab: glab({ ok: true, token: 'glab-token' }), pluginToken });
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: true, token: 'glab-token' });
    expect(pluginToken).not.toHaveBeenCalled();
  });

  it('falls back to the GitLab plugin connection for the same host', async () => {
    const pluginToken = vi.fn((host: string) => (host === 'git.example.com' ? 'plugin-token' : null));
    const chain = createGitlabTokenChain({ glab: glab({ ok: false, reason: 'glab-missing' }), pluginToken });
    await expect(chain.readTokenDetailed('Git.Example.com')).resolves.toEqual({ ok: true, token: 'plugin-token' });
    expect(pluginToken).toHaveBeenCalledWith('git.example.com');
    await expect(chain.readTokenDetailed('other.example.com')).resolves.toEqual({ ok: false, reason: 'glab-missing' });
  });

  it('keeps the glab reason when neither source has an account, and ignores resolver errors', async () => {
    const chain = createGitlabTokenChain({
      glab: glab({ ok: false, reason: 'glab-not-logged-in' }),
      pluginToken: () => {
        throw new Error('vault locked');
      },
    });
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: false, reason: 'glab-not-logged-in' });
  });

  it('never consults the plugin for a host that is not a valid GitLab host', async () => {
    const pluginToken = vi.fn(() => 'plugin-token');
    const chain = createGitlabTokenChain({ glab: glab({ ok: false, reason: 'no-token' }), pluginToken });
    await expect(chain.readTokenDetailed('not a host')).resolves.toEqual({ ok: false, reason: 'no-token' });
    expect(pluginToken).not.toHaveBeenCalled();
  });

  it('a rejected plugin token is retired for a while without touching glab', async () => {
    let now = 1_000;
    const source = glab({ ok: false, reason: 'glab-missing' });
    const chain = createGitlabTokenChain({ glab: source, pluginToken: () => 'plugin-token', now: () => now });
    await chain.readTokenDetailed('git.example.com');
    chain.rejectToken('git.example.com');
    expect(source.rejectToken).not.toHaveBeenCalled();
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: false, reason: 'glab-missing' });
    now += 31_000;
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: true, token: 'plugin-token' });
    chain.rejectToken('git.example.com');
    chain.invalidateNegativeCache();
    expect(source.invalidateNegativeCache).toHaveBeenCalled();
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: true, token: 'plugin-token' });
  });

  it('a rejected glab token is reported to glab', async () => {
    const source = glab({ ok: true, token: 'glab-token' });
    const chain = createGitlabTokenChain({ glab: source, pluginToken: () => null });
    await chain.readTokenDetailed('git.example.com');
    chain.rejectToken('git.example.com');
    expect(source.rejectToken).toHaveBeenCalledWith('git.example.com');
  });
});
