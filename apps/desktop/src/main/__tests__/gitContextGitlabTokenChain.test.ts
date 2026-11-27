import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGitlabTokenChain } from '../git-context/gitlabTokenChain';
import {
  createGlabCliTokenSource,
  glabConfigPaths,
  parseGlabConfigHosts,
  type GlabTokenResult,
} from '../git-context/glabCliTokenSource';

function glab(result: GlabTokenResult) {
  return {
    readTokenDetailed: vi.fn(async () => result),
    rejectToken: vi.fn(),
    invalidateNegativeCache: vi.fn(),
  };
}

describe('GitLab token chain', () => {
  it('prefers the GitLab plugin connection over local glab for the same host', async () => {
    const source = glab({ ok: true, token: 'glab-token' });
    const pluginToken = vi.fn((host: string) => (host === 'git.example.com' ? 'plugin-token' : null));
    const chain = createGitlabTokenChain({ glab: source, pluginToken });
    await expect(chain.readTokenDetailed('Git.Example.com')).resolves.toEqual({ ok: true, token: 'plugin-token' });
    expect(pluginToken).toHaveBeenCalledWith('git.example.com');
    expect(source.readTokenDetailed).not.toHaveBeenCalled();
  });

  it('falls back to local glab when the plugin has no connection for that host', async () => {
    const pluginToken = vi.fn((host: string) => (host === 'git.example.com' ? 'plugin-token' : null));
    const chain = createGitlabTokenChain({ glab: glab({ ok: true, token: 'glab-token' }), pluginToken });
    await expect(chain.readTokenDetailed('other.example.com')).resolves.toEqual({ ok: true, token: 'glab-token' });
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

  it('a rejected plugin token is retired for a while, falling back to glab without rejecting glab', async () => {
    let now = 1_000;
    const source = glab({ ok: false, reason: 'glab-missing' });
    const chain = createGitlabTokenChain({ glab: source, pluginToken: () => 'plugin-token', now: () => now });
    await expect(chain.readTokenDetailed('git.example.com')).resolves.toEqual({ ok: true, token: 'plugin-token' });
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

describe('glab config host discovery', () => {
  it('extracts HTTPS hosts from glab config.yml and filters out unauthenticated or HTTP-only entries', async () => {
    const yaml = [
      'git_protocol: ssh',
      'hosts:',
      '  gitlab.com:',
      '    api_protocol: https',
      '    token:',
      '  Git.Example.com:',
      '    user: dash',
      '    use_keyring: true',
      '  plain.internal.test:',
      '    api_protocol: http',
      '    token: glpat-plain',
      'editor: vim',
    ].join('\n');
    expect(parseGlabConfigHosts(yaml)).toEqual(['gitlab.com', 'git.example.com']);

    const source = createGlabCliTokenSource({
      configuredHosts: () => parseGlabConfigHosts(yaml),
      exec: ((_bin: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        const host = args[args.indexOf('--host') + 1];
        cb(null, host === 'git.example.com' ? 'glpat-live-token\n' : '\n');
      }) as never,
    });
    await expect(source.listLoggedInHosts()).resolves.toEqual(['git.example.com']);
  });

  it('resolves platform config paths via path.join and honors GLAB_CONFIG_DIR', () => {
    const home = path.join('Users', 'tester');
    expect(glabConfigPaths('darwin', home, { GLAB_CONFIG_DIR: path.join(home, 'custom-glab') })).toEqual([
      path.join(home, 'custom-glab', 'config.yml'),
    ]);
    expect(glabConfigPaths('darwin', home, {})).toContain(
      path.join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml'),
    );
    expect(glabConfigPaths('win32', home, { APPDATA: path.join(home, 'AppData', 'Roaming') })).toContain(
      path.join(home, 'AppData', 'Roaming', 'glab-cli', 'config.yml'),
    );
  });
});
