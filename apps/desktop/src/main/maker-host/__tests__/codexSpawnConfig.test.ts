/** #10523 — unit: production spawn materialization must not freeze a direct
 * endpoint or discard selected provider routes after failed/in-flight warmup.
 * Existing proxy-host tests cover listener state, not this configuration boundary.
 * Separate file because it injects host ports, with no sockets or Agent binaries. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { createCodexSpawnConfig } from '../codexSpawnConfigCore.js';
import { setActiveCatalog } from '../active-catalog.js';

vi.mock('../codex-browser-companion.js', () => ({
  prepareCodexBrowserCompanion: async () => null,
  resolveCodexBrowserCompanionSpawnConfig: () => ({ extraArgs: [], codexBrowserUseAvailable: false }),
}));

type Ports = Parameters<typeof createCodexSpawnConfig>[0];
type Context = Parameters<ReturnType<typeof createCodexSpawnConfig>>[1];
const provider = buildUserProvider({ id: 'fixture-provider', name: 'Fixture', runtimes: { codex: {
  baseUrl: 'https://provider.invalid/v1', wireProtocol: 'openai-responses', supportsImageGeneration: true,
  models: [{ id: 'fixture-model', name: 'Fixture model' }],
} } });

function fixture() {
  let ready = false;
  const warmup = vi.fn(async () => {});
  const endpoint = vi.fn(() => ready ? 'http://127.0.0.1:12345' : 'https://fallback.invalid/v1');
  const release = vi.fn(async () => {});
  const ports: Ports = {
    binaryPath: process.execPath, getCodexHome: () => process.cwd(),
    getCodexExtraSpawnConfig: vi.fn(async () => ({ extraArgs: [], extraEnv: {}, bridge: null, bridgeServerNames: [] })),
    broadcastCodexRuntimeRoute: async () => {}, readClaudeApiKey: () => 'fake-key',
    isReplacedCindyGatewayKey: () => false, hasCodexOAuthLogin: async () => false,
    listProviders: async () => [], getDesktopSelectableCatalog: () => BUNDLED_CATALOG,
    resolveDesktopModelContextProviderId: () => null,
    prepareRemote: vi.fn(async () => ({ extraArgs: ['remote'], extraEnv: {} })),
    readSubagentOAuth: async () => ({ accessToken: 'fake-token', accountId: null, canDispatch: () => false }),
    proxy: {
      setCodexProxyAuthInjection: () => {}, setCodexProxyGatewayKeyReader: () => {}, setCodexSubagentOAuthReader: () => {},
      ensureCodexProxyReady: warmup, ensureCodexControlPlaneProxyReady: warmup, ensureCodexCustomContextProxyReady: warmup,
      isCodexProxyHandleReady: () => ready, isCodexControlPlaneProxyHandleReady: () => ready,
      isCodexCustomContextProxyHandleReady: () => ready,
      getCodexProxyEndpoint: endpoint, getCodexControlPlaneProxyEndpoint: endpoint, getCodexCustomContextProxyEndpoint: endpoint,
      releaseCodexCustomContextProxy: release, setCodexAppliedCustomProviderRoutes: vi.fn(),
    },
  };
  return { prepare: createCodexSpawnConfig(ports), ports, warmup, endpoint, release, ready: () => { ready = true; } };
}

describe('Codex launch requires its local route', () => {
  beforeEach(() => { setActiveCatalog({ ...BUNDLED_CATALOG, providers: [provider] }); });

  it.each<Context>([
    { credentialMode: 'gateway-key' },
    { credentialMode: 'oauth-bearer' },
    { credentialMode: 'provider-oauth' },
    { credentialMode: 'gateway-key', hostPurpose: 'control-plane' },
    { credentialMode: 'gateway-key', hostPurpose: 'review' },
    { credentialMode: 'gateway-key', accountHostKey: 'account-fixture' },
    { credentialMode: 'gateway-key', localAuthPolicy: 'isolated', hostScopeKey: 'scope-fixture' },
    { credentialMode: 'gateway-key', accountHostKey: 'guest-fixture', deviceHostedGuestProviderId: provider.id, deviceHostedGuestSessionId: 'guest' },
  ])('rejects not-ready configuration as fatal: %j', async ctx => {
    const f = fixture();
    await expect(f.prepare([], ctx)).rejects.toMatchObject({ codexSpawnConfigFatal: true });
    expect(f.endpoint).not.toHaveBeenCalled();
    if (ctx.accountHostKey || ctx.localAuthPolicy === 'isolated') expect(f.release).toHaveBeenCalledOnce();
  });

  it('waits for warmup, then freezes the ready endpoint and selected custom route', async () => {
    const f = fixture();
    let complete!: () => void;
    f.warmup.mockImplementationOnce(() => new Promise(resolve => { complete = () => { f.ready(); resolve(); }; }));
    let settled = false;
    const pending = f.prepare([], { credentialMode: 'gateway-key' }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(f.warmup).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(f.endpoint).not.toHaveBeenCalled();
    complete();
    const config = await pending;
    expect(config.codexProxyActive).toBe(true);
    expect(config.extraArgs.join(' ')).toContain('http://127.0.0.1:12345');
    expect(config.codexCustomProviderRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: provider.id })]));
    expect(config.extraArgs.join(' ')).not.toContain('fallback.invalid');
  });

  it('can retry materialization after failure without losing the selected route', async () => {
    const f = fixture();
    await expect(f.prepare([], { credentialMode: 'gateway-key' })).rejects.toMatchObject({ codexSpawnConfigFatal: true });
    f.ready();
    const config = await f.prepare([], { credentialMode: 'gateway-key' });
    expect(config.codexProxyActive).toBe(true);
    expect(config.codexCustomProviderRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: provider.id })]));
  });

  it('leaves remote materialization independent of the local proxy', async () => {
    const f = fixture();
    expect(await f.prepare([], { remoteHostId: 'remote-fixture', credentialMode: 'gateway-key' })).toEqual({ extraArgs: ['remote'], extraEnv: {} });
    expect(f.warmup).not.toHaveBeenCalled();
  });
});
