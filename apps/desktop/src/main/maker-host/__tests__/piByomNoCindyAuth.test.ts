import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loggedIn: false, proxyReady: true, sharedSkillRefreshes: 0 }));
const ensureLocalReady = vi.hoisted(() => vi.fn());
const ensureProxyReady = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../local-model-runtime/preflight.js', () => ({
  ensureManagedOllamaReadyForSession: ensureLocalReady,
}));

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
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'local-model' }],
        },
      },
    },
    {
      id: 'openrouter-oauth',
      name: 'OpenRouter OAuth',
      auth: { method: 'oauth', oauth: { authorizeUrl: 'https://openrouter.ai/auth' } },
      runtimes: {
        pi: {
          baseUrl: 'https://openrouter.ai/api/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'google/gemini-test', api: 'openai-completions' }],
        },
      },
    },
    {
      id: 'xai',
      name: 'Legacy custom xAI',
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: 'https://private-xai.example/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'private-grok' }, { id: 'grok-4.6' }],
        },
      },
    },
  ],
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  migrateInstalledGhostSecretAliases: vi.fn(() => true),
  readCustomProviderKey: (providerId: string) =>
    providerId === 'xai' ? 'legacy-custom-key' : null,
}));
vi.mock('../grok-oauth-login.desktop.js', () => ({
  hasGrokOAuthLogin: () => state.loggedIn,
  getGrokAccessToken: async () => 'grok-test-token',
  peekGrokAccessToken: () => (state.loggedIn ? 'grok-test-token' : null),
  recoverGrokAuthAfterRejection: async () => 'superseded' as const,
}));
vi.mock('../anthropic-compat-proxy-host.js', () => ({
  getClaudeEndpoint: () => 'http://127.0.0.1:18765',
  isAnthropicCompatProxyHandleReady: () => state.proxyReady,
  ensureAnthropicCompatProxyReady: ensureProxyReady,
}));

import { desktopPiAuthAdapter, resolvePiNativeProviders } from '../pi-host.js';

describe('Pi pure BYOM auth without a Cindy account', () => {
  beforeEach(() => {
    state.loggedIn = false;
    state.proxyReady = true;
    state.sharedSkillRefreshes = 0;
    ensureLocalReady.mockReset();
    ensureProxyReady.mockReset();
  });

  it.each(['cindy-local-llamacpp', 'cindy-local-ollama'])('starts %s on demand during local Pi provider resolution only', async providerId => {
    await resolvePiNativeProviders({ workingDir: '/tmp/project', providerId, model: 'local-model' });
    expect(ensureLocalReady).toHaveBeenCalledWith(expect.objectContaining({ providerId, remoteHostId: null }));
    ensureLocalReady.mockClear();
    await resolvePiNativeProviders({ workingDir: '/tmp/project', providerId, model: 'local-model', purpose: 'preview' });
    expect(ensureLocalReady).not.toHaveBeenCalled();
    await resolvePiNativeProviders({ workingDir: '/remote/project', providerId, model: 'local-model', remoteHostId: 'remote-1' });
    expect(ensureLocalReady).not.toHaveBeenCalled();
  });

  it('fails closed when an official SuperGrok route has no local compat proxy', async () => {
    state.proxyReady = false;
    await expect(resolvePiNativeProviders({
      workingDir: '/tmp/project',
      providerId: 'xai',
      model: 'grok-4.6',
    })).rejects.toThrow('local compatibility proxy is not ready');
  });

  // #10523, unit: actual desktop Pi resolver must wait for warmup, reject a
  // gateway without the proxy, and preserve independently usable BYOM routes.
  it('waits for proxy warmup and recovers a gateway route on a later attempt', async () => {
    state.proxyReady = false;
    const ctx = { workingDir: process.cwd(), providerId: 'xd', model: 'fixture-model' };
    await expect(resolvePiNativeProviders(ctx)).rejects.toThrow('requires the local compatibility proxy');
    let complete!: () => void;
    ensureProxyReady.mockImplementationOnce(() => new Promise(resolve => { complete = () => { state.proxyReady = true; resolve(); }; }));
    let settled = false;
    const pending = resolvePiNativeProviders(ctx).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(ensureProxyReady).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    complete();
    await expect(pending).resolves.toHaveProperty('providers');
  });

  it('keeps native keyless BYOM, preview and remote routes usable without the proxy', async () => {
    state.proxyReady = false;
    ensureProxyReady.mockImplementation(async () => { throw new Error('unrelated proxy startup'); });
    const ctx = { workingDir: process.cwd(), providerId: 'local-keyless', model: 'local-model' };
    const result = await resolvePiNativeProviders(ctx);
    expect(result.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'local-keyless', baseUrl: 'http://127.0.0.1:11434/v1' })]));
    expect(ensureProxyReady).not.toHaveBeenCalled();
    await resolvePiNativeProviders({ ...ctx, purpose: 'preview' });
    await resolvePiNativeProviders({ ...ctx, remoteHostId: 'remote-fixture' });
    expect(ensureProxyReady).not.toHaveBeenCalled();
  });

  it.each([
    { providerId: null, model: 'local-model' },
    { providerId: 'openrouter-oauth', model: 'google/gemini-test' },
  ])('does not replace the selected proxy route with a native default: %j', async route => {
    state.proxyReady = false;
    await expect(resolvePiNativeProviders({ workingDir: process.cwd(), ...route }))
      .rejects.toThrow('requires the local compatibility proxy');
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
        id: 'xai',
        sourceProviderId: 'xai',
        baseUrl: 'http://127.0.0.1:18765/v1',
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

  it('does not give remote OAuth Pi a local proxy endpoint', async () => {
    const resolved = await resolvePiNativeProviders({
      workingDir: '/remote/project',
      remoteHostId: 'remote-1',
      providerId: 'openrouter-oauth',
      model: 'google/gemini-test',
    });
    expect(resolved.providers.some((provider) => provider.id.includes('openrouter-oauth'))).toBe(false);
    expect(resolved.providers.some((provider) =>
      provider.baseUrl?.includes('127.0.0.1:18765') && !provider.hostProxyForward)).toBe(false);
  });
});
