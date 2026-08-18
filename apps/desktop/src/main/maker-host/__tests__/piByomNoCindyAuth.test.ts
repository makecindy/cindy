import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loggedIn: false, sharedSkillRefreshes: 0 }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-byom-auth-test',
  },
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
  desktopClaudeAuthAdapter: {
    ensureSharedGlobalSkills: async () => {
      state.sharedSkillRefreshes += 1;
    },
  },
  desktopCodexAuthAdapter: { getState: async () => ({ authenticated: false }) },
}));
vi.mock('../custom-provider-header-secrets.js', () => ({
  listCustomProvidersWithSecureHeaders: async () => [
    {
      id: 'local-keyless',
      name: 'Local keyless',
      auth: { method: 'none' },
      runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'local-model' }] } },
    },
    {
      id: 'xai',
      name: 'Legacy custom xAI',
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: 'https://private-xai.example/v1',
          models: [{ id: 'private-grok' }, { id: 'grok-4.6' }],
        },
      },
    },
  ],
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: (providerId: string) =>
    providerId === 'xai' ? 'legacy-custom-key' : null,
}));
vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: () => state.loggedIn,
  getGrokAccessToken: async () => 'grok-test-token',
  peekGrokAccessToken: () => (state.loggedIn ? 'grok-test-token' : null),
  recoverGrokAuthAfterRejection: async () => 'superseded' as const,
}));

import { desktopPiAuthAdapter, resolvePiNativeProviders } from '../pi-host.js';

describe('Pi pure BYOM auth without a Cindy account', () => {
  beforeEach(() => {
    state.loggedIn = false;
    state.sharedSkillRefreshes = 0;
  });

  it('refreshes local shared skills before provider resolution and skips remote homes', async () => {
    await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'local-keyless',
      model: 'local-model',
    });
    expect(state.sharedSkillRefreshes).toBe(1);

    await resolvePiNativeProviders({
      workingDir: '/remote/project',
      remoteHostId: 'remote-1',
      providerId: 'local-keyless',
      model: 'local-model',
    });
    expect(state.sharedSkillRefreshes).toBe(1);
  });

  it('authenticates the native provider and only uses an inert gateway placeholder', async () => {
    expect(await desktopPiAuthAdapter.getState({ providerId: 'local-keyless' })).toMatchObject({
      authenticated: true,
      identity: 'Local keyless',
    });
    expect(await desktopPiAuthAdapter.getAuthEnv({ providerId: 'local-keyless' })).toEqual({
      CINDY_PI_API_KEY: 'cindy-pi-provider-auth-placeholder',
    });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'xd' })).toMatchObject({
      authenticated: false,
      errorReason: 'cindy_gateway_key_unavailable',
    });
  });

  it('keeps a legacy custom xai credential usable without a SuperGrok login', async () => {
    expect(await desktopPiAuthAdapter.getState({ providerId: 'custom:xai' })).toMatchObject({
      authenticated: true,
      identity: 'Legacy custom xAI',
    });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'xai' })).toEqual({
      authenticated: false,
      errorReason: 'xai_oauth_unavailable',
    });
  });

  it('keeps an official xai resume on SuperGrok when a custom provider has the same model', async () => {
    state.loggedIn = true;
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'grok-4.6',
      resumeSessionId: '/tmp/pi/official-session.jsonl',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'cindy-byom-xai',
        sourceProviderId: 'xai',
        baseUrl: expect.not.stringContaining('private-xai.example'),
      }),
    );
    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'custom:xai',
        baseUrl: 'https://private-xai.example/v1',
      }),
    );
  });

  it('restores a migrated custom:xai session from its saved endpoint after SuperGrok is connected', async () => {
    state.loggedIn = true;
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'custom:xai',
      model: 'private-grok',
      resumeSessionId: '/tmp/pi/legacy-custom-session.jsonl',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'custom:xai',
        baseUrl: 'https://private-xai.example/v1',
        models: expect.arrayContaining([expect.objectContaining({ id: 'private-grok' })]),
      }),
    );
    expect(Object.values(resolved.env)).toContain('legacy-custom-key');
  });
});
