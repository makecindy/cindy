import { describe, expect, it, vi } from 'vitest';

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
        pi: { baseUrl: 'https://private-xai.example/v1', models: [{ id: 'private-grok' }] },
      },
    },
  ],
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: (providerId: string) =>
    providerId === 'xai' ? 'legacy-custom-key' : null,
}));
vi.mock('../grok-oauth-login.js', () => ({ hasGrokOAuthLogin: () => false }));

import { desktopPiAuthAdapter, resolvePiNativeProviders } from '../pi-host.js';

describe('Pi pure BYOM auth without a Cindy account', () => {
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
    expect(await desktopPiAuthAdapter.getState({ providerId: 'xai' })).toMatchObject({
      authenticated: true,
      identity: 'Legacy custom xAI',
    });
  });

  it('restores a legacy xai session from the custom endpoint startup snapshot', async () => {
    const resolved = await resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'private-grok',
    });

    expect(resolved.providers).toContainEqual(
      expect.objectContaining({
        id: 'xai',
        baseUrl: 'https://private-xai.example/v1',
        models: [expect.objectContaining({ id: 'private-grok' })],
      }),
    );
    expect(Object.values(resolved.env)).toContain('legacy-custom-key');
  });
});
