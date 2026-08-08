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
  ],
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: () => null,
  // pi-host 的 import 图经 anthropic-compat-proxy-host → local-proxy-external-auth 触及这些
  // 对外代理 token 存取器;此处只需惰性桩(该用例不涉及对外代理)。
  readLocalProxyExternalToken: () => null,
  writeLocalProxyExternalToken: () => true,
  readLocalProxyCodexExternalToken: () => null,
  writeLocalProxyCodexExternalToken: () => true,
}));

import { desktopPiAuthAdapter } from '../pi-host.js';

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
});
