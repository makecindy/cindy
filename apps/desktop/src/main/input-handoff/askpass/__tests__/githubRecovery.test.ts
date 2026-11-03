import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost.js';
import { createGithubAuthRecovery, type GithubAuthRecoveryDeps } from '../githubRecovery.js';
import type { AuthRecoveryRequest } from '../host.js';

// Unit: recovery entry + real visibility policy. Old askpass always opened the
// credential flow; these fixtures cover unavailable connections and in-flight changes.
const request: AuthRecoveryRequest = {
  sessionId: 'task', prompt: "Username for 'https://github.com': ",
  asker: { program: 'git', command: 'git push origin main', gitOrigin: 'https://github.com' },
};
function harness() {
  const ghost = {
    manifest: { schemaVersion: 3, id: 'cindy-github', name: 'GitHub', version: '1.0.0', kind: 'chip', entry: 'index.js',
      tools: [{ name: 'list_tools' }, { name: 'call_tool' }] },
    dir: '/tmp/cindy-github', namespace: null, enabled: true,
    trust: { level: 'cindy-official', publisherSigned: true, publisherVerified: true, reviewed: true },
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
  const state = { owner: 'owner:1' as string | null, context: { workingDir: '/project', remoteHostId: null as string | null },
    plugins: [ghost], disabled: false, available: true, trusted: true, ready: true };
  const connected = vi.fn(async () => true);
  const deps: GithubAuthRecoveryDeps = {
    ownerKey: () => state.owner,
    sessionContext: async () => state.context,
    listGhosts: () => state.plugins,
    isDisabledForWorkdir: () => state.disabled,
    isAvailableForActiveSession: () => state.available,
    isTrusted: (candidate) => state.trusted && candidate.trust?.level === 'cindy-official',
    setupReady: () => state.ready,
    connected,
  };
  return { state, ghost, connected, recover: createGithubAuthRecovery(deps) };
}

describe('GitHub authentication recovery', () => {
  it('returns an actionable plugin route and an explicit native-Git escape without credentials', async () => {
    const h = harness();
    const result = await h.recover(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).toContain('ghost_info({"ghost_id":"cindy-github","namespace":null})');
    expect(result).toContain('CINDY_INPUT_HANDOFF_PREFER_TERMINAL=1');
    expect(result).not.toContain('/project');
    expect(result).not.toContain('owner:1');
  });

  it.each([
    { name: 'sudo', asker: { ...request.asker, program: 'sudo' as const } },
    { name: 'unverified transport', asker: { ...request.asker, gitOrigin: undefined } },
    { name: 'other transport', asker: { ...request.asker, gitOrigin: 'https://git.example' } },
    { name: 'redirected challenge', prompt: "Password for 'https://git.example':" },
    { name: 'lookalike domain', prompt: "Username for 'https://github.com.example':" },
    { name: 'GitHub in userinfo', prompt: "Username for 'https://github.com@git.example':" },
    { name: 'HTTP', prompt: "Username for 'http://github.com':" },
    { name: 'nonstandard port', prompt: "Username for 'https://github.com:8443':" },
  ])('keeps the original flow for $name', async (change) => {
    const h = harness();
    expect(await h.recover({ ...request, ...change })).toBeNull();
    expect(h.connected).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'unavailable', 'unapproved', 'untrusted', 'setup-required', 'missing', 'ambiguous', 'remote', 'no-owner', 'no-workdir', 'no-tools'])
    ('does not suggest an unusable plugin: %s', async (reason) => {
      const h = harness();
      if (reason === 'disabled') h.state.disabled = true;
      if (reason === 'unavailable') h.state.available = false;
      if (reason === 'unapproved') h.ghost.approval = { state: 'legacy-unapproved' };
      if (reason === 'untrusted') h.state.trusted = false;
      if (reason === 'setup-required') h.state.ready = false;
      if (reason === 'missing') h.state.plugins = [];
      if (reason === 'ambiguous') h.state.plugins.push({ ...h.ghost, namespace: 'acme', dir: '/tmp/_ns/acme/cindy-github' });
      if (reason === 'remote') h.state.context.remoteHostId = 'ssh-host';
      if (reason === 'no-owner') h.state.owner = null;
      if (reason === 'no-workdir') h.state.context.workingDir = '';
      if (reason === 'no-tools') h.ghost.manifest.tools = [];
      expect(await h.recover(request)).toBeNull();
      expect(h.connected).not.toHaveBeenCalled();
    });

  it('does not equate setup=ready or a failed probe with a working connection', async () => {
    const h = harness();
    h.connected.mockResolvedValue(false);
    expect(await h.recover(request)).toBeNull();
    h.connected.mockRejectedValue(new Error('synthetic private authentication details'));
    expect(await h.recover(request)).toBeNull();
  });

  it.each(['owner', 'disabled', 'reinstalled', 'workdir', 'setup', 'trust'])
    ('discards a successful probe when %s changes in flight', async (change) => {
      const h = harness();
      h.connected.mockImplementation(async () => {
        if (change === 'owner') h.state.owner = 'owner:2';
        if (change === 'disabled') h.state.disabled = true;
        if (change === 'reinstalled') h.ghost.approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
        if (change === 'workdir') h.state.context = { workingDir: '/another', remoteHostId: null };
        if (change === 'setup') h.state.ready = false;
        if (change === 'trust') h.ghost.trust = undefined;
        return true;
      });
      expect(await h.recover(request)).toBeNull();
    });
});
