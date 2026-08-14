import { beforeEach, describe, expect, it, vi } from 'vitest';

const grokOAuth = vi.hoisted(() => ({ loggedIn: false }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-byom-auth-test',
  },
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => null,
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
vi.mock('../grok-oauth-login.js', () => ({ hasGrokOAuthLogin: () => grokOAuth.loggedIn }));

import { desktopPiAuthAdapter, resolvePiNativeProviders } from '../pi-host.js';

describe('Pi pure BYOM auth without a Cindy account', () => {
  beforeEach(() => {
    grokOAuth.loggedIn = false;
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
    grokOAuth.loggedIn = true;
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'grok-4.6',
      resumeSessionId: '/tmp/pi/official-session.jsonl',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'xai',
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
    grokOAuth.loggedIn = true;
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
