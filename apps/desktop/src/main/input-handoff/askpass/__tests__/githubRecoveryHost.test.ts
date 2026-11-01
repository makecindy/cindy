import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost.js';
import type { ActiveAppSession } from '../../../appSessionState.js';
import { CINDY_OFFICIAL_GHOST_TRUST } from '../../../cindy-brain/GhostManager.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from '../../../profile/profileRegistryModel.js';
import { resolveGithubAuthRecovery } from '../githubRecoveryHost.js';
import type { AuthRecoveryRequest } from '../host.js';

// Unit: exercise the production wiring and real githubConnection with a synthetic
// fetch. Policy tests alone cannot prove credential precedence or owner isolation.
const h = vi.hoisted(() => ({
  owner: 1, mode: 'cloud' as ActiveAppSession['mode'], dataOwnerId: 'test-owner' as string | null,
  boundary: false, ghost: null as InstalledGhost | null,
  readGh: vi.fn<() => Promise<string | null>>(), readSecret: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: h.mode, dataOwnerId: h.dataOwnerId, generation: h.owner }),
  activeOwnerScopeKey: () => JSON.stringify([h.mode, h.dataOwnerId, h.owner]),
  isAppSessionBoundaryPending: () => h.boundary,
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => h.ghost ? [h.ghost] : [] }),
  getGhostSetupAssessment: () => ({ state: 'ready' }),
  isGhostAvailableForActiveSession: () => true,
}));
vi.mock('../../../cindy-brain/ghostWorkdirPrefs.js', () => ({ isGhostDisabledForWorkdir: () => false }));
vi.mock('../../../localDb/ipc/sessions.js', () => ({
  getSessionFsSnapshot: async () => ({ workingDir: '/project', remoteHostId: null }),
}));
vi.mock('../../../git-context/ghCliTokenSource.js', () => ({
  getSharedGhCliTokenSource: () => ({ readToken: h.readGh }),
}));
vi.mock('../../../maker-host/outbound-fetch.js', () => ({ outboundFetch: h.fetch }));
vi.mock('../../../secrets/providerSecretStore.js', () => ({ readGhostSecret: h.readSecret }));

const request: AuthRecoveryRequest = {
  sessionId: 'task', prompt: "Password for 'https://someone@github.com':",
  asker: { program: 'git', command: 'git push origin main', gitOrigin: 'https://github.com' },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 1; h.mode = 'cloud'; h.dataOwnerId = 'test-owner'; h.boundary = false;
  h.ghost = {
    manifest: { schemaVersion: 3, id: 'cindy-github', name: 'GitHub', version: '1.0.0', kind: 'chip', entry: 'index.js',
      tools: [{ name: 'list_tools' }, { name: 'call_tool' }], network: { hosts: ['api.github.com'], secrets: [{
        key: 'test_gh_connection', source: 'gh-cli', label: 'GitHub',
        inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'] },
      }] } },
    dir: '/tmp/cindy-github', namespace: null, namespaceState: 'confirmed', enabled: true,
    trust: { ...CINDY_OFFICIAL_GHOST_TRUST },
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  } as InstalledGhost;
  h.readGh.mockResolvedValue('synthetic-gh-token');
  h.readSecret.mockReturnValue('synthetic-pat');
  h.fetch.mockImplementation(async () => new Response(JSON.stringify({ login: 'test-user' }), { status: 200 }));
});

describe('GitHub recovery host wiring', () => {
  it('uses the saved gh login and exposes only recovery guidance', async () => {
    const result = await resolveGithubAuthRecovery(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).not.toContain('synthetic-gh-token');
    expect(result).not.toContain('test-user');
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-gh-token' }), redirect: 'error',
    }));
  });

  it('falls back only to the selected installation and its declared secret key', async () => {
    h.readGh.mockResolvedValue(null);
    const result = await resolveGithubAuthRecovery(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).not.toContain('synthetic-pat');
    expect(h.readSecret).toHaveBeenCalledWith('cindy-github', 'test_gh_connection');
    expect(h.fetch).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-pat' }),
    }));
  });

  it.each(['untrusted', 'unknown-contract', 'owner-boundary'])('does not read credentials for %s', async (reason) => {
    if (reason === 'untrusted') h.ghost!.trust = undefined;
    if (reason === 'unknown-contract') h.ghost!.manifest.network = undefined;
    if (reason === 'owner-boundary') h.boundary = true;
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.readGh).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not use an old-owner credential after an asynchronous read', async () => {
    h.readGh.mockImplementation(async () => { h.owner = 2; return 'synthetic-old-token'; });
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  it('retains the original authentication flow on rejection without exposing response bodies', async () => {
    h.fetch.mockImplementation(async () => new Response('synthetic private rejection', { status: 401 }));
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
  });

  // PR #6349: a successful /user probe must not redirect to an instance that
  // networkSlot rejects before reading either credential source.
  it.each(['organization', 'pending', 'unconfirmed'] as const)('rejects %s instances before reading credentials', async (identity) => {
    if (identity === 'organization') {
      h.ghost!.namespace = 'acme';
      h.ghost!.dir = '/tmp/_ns/acme/cindy-github';
    } else {
      h.ghost!.namespaceState = identity;
      if (identity === 'pending') delete h.ghost!.namespace;
    }
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.readGh).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unconfirmed'] as const)('drops a credential if namespace becomes %s during the read', async (state) => {
    h.readGh.mockImplementation(async () => {
      h.ghost!.namespaceState = state;
      return 'synthetic-stale-token';
    });
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  // Direct/BYOK plugins are available to local profiles; signed-out startup is
  // a different state and must never read a profile's credentials.
  it('offers recovery for a local profile using its existing GitHub connection', async () => {
    h.mode = 'local'; h.dataOwnerId = LOCAL_PROFILE_DATA_OWNER_ID;
    const result = await resolveGithubAuthRecovery(request);
    expect(result).toContain('CINDY_AUTH_ALTERNATIVE_AVAILABLE');
    expect(result).not.toContain(LOCAL_PROFILE_DATA_OWNER_ID);
    expect(result).not.toContain('synthetic-gh-token');
  });

  it('does not probe while signed out', async () => {
    h.mode = 'signed-out'; h.dataOwnerId = null;
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.readGh).not.toHaveBeenCalled();
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('discards a local-profile credential when a cloud profile becomes active', async () => {
    h.mode = 'local'; h.dataOwnerId = LOCAL_PROFILE_DATA_OWNER_ID;
    h.readGh.mockImplementation(async () => {
      h.mode = 'cloud'; h.dataOwnerId = 'test-owner'; h.owner += 1;
      return 'synthetic-local-token';
    });
    expect(await resolveGithubAuthRecovery(request)).toBeNull();
    expect(h.readGh).toHaveBeenCalledOnce();
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
