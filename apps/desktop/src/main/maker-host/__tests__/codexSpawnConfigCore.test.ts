import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { setActiveCatalog } from '../active-catalog.js';
import { createCodexSpawnConfig } from '../codexSpawnConfigCore.js';
import { prepareCodexBrowserCompanion } from '../codex-browser-companion.js';

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../subagent-model-settings-store.js', () => ({
  readSubagentModelSettings: () => ({ codexSmartSubagentRouting: false }),
}));
vi.mock('../codex-smart-subagent-routing.js', () => ({
  prepareCodexSmartSubagentConfig: vi.fn(), codexSmartSubagentRoutingSignature: vi.fn(),
  selectCodexSmartSubagentCandidates: vi.fn(),
}));
vi.mock('../codex-custom-context-catalog.js', () => ({
  prepareCodexGuestModelCatalog: async () => ({ extraArgs: [] }),
  prepareCodexCustomContextCatalog: vi.fn(),
}));
vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: vi.fn(), resolveModelCompactionPct: vi.fn(),
}));
vi.mock('../catalog-to-descriptors.js', () => ({ resolveModelDefaultContextWindow: vi.fn() }));
vi.mock('../codex-browser-companion.js', () => ({
  prepareCodexBrowserCompanion: vi.fn(),
  resolveCodexBrowserCompanionSpawnConfig: (value: { extraArgs: string[] } | null) => ({
    extraArgs: value?.extraArgs ?? [], codexBrowserUseAvailable: value !== null,
  }),
}));

const localMcpArgs = ['-c', 'mcp_servers.local_slow.url="http://127.0.0.1:9/mcp"'];
const browserArgs = ['-c', 'mcp_servers.node_repl.command="local-browser"'];

function fixture() {
  const buildSessionMcpConfig = vi.fn(() => ({ 'mcp_servers.local_slow.enabled': true }));
  const getCodexExtraSpawnConfig = vi.fn(async () => ({
    extraArgs: localMcpArgs, extraEnv: { LOCAL_MCP_TOKEN: 'fixture-only' },
    bridge: null, bridgeServerNames: ['local_slow'], buildSessionMcpConfig,
  }));
  const scopedReady = vi.fn(() => true);
  const release = vi.fn(async () => {});
  const prepare = createCodexSpawnConfig({
    binaryPath: 'unused-test-binary', getCodexHome: () => 'unused-test-home',
    getCodexExtraSpawnConfig,
    broadcastCodexRuntimeRoute: vi.fn(async () => {}),
    readClaudeApiKey: () => null, isReplacedCindyGatewayKey: () => false,
    hasCodexOAuthLogin: async () => true, listProviders: async () => [],
    getDesktopSelectableCatalog: () => ({ version: 'fixture', providers: [] }),
    resolveDesktopModelContextProviderId: vi.fn(), prepareRemote: vi.fn(),
    readSubagentOAuth: async () => ({ accessToken: 'fixture-only', accountId: 'fixture', canDispatch: () => true }),
    proxy: {
      setCodexProxyAuthInjection: vi.fn(), setCodexProxyGatewayKeyReader: vi.fn(),
      setCodexSubagentOAuthReader: vi.fn(), setCodexAppliedCustomProviderRoutes: vi.fn(),
      ensureCodexCustomContextProxyReady: vi.fn(async () => {}),
      isCodexCustomContextProxyHandleReady: scopedReady,
      releaseCodexCustomContextProxy: release,
      ensureCodexControlPlaneProxyReady: vi.fn(async () => {}),
      ensureCodexProxyReady: vi.fn(async () => {}),
      isCodexControlPlaneProxyHandleReady: () => true, isCodexProxyHandleReady: () => true,
      getCodexCustomContextProxyEndpoint: () => 'http://127.0.0.1:9',
      getCodexControlPlaneProxyEndpoint: () => 'http://127.0.0.1:9',
      getCodexProxyEndpoint: () => 'http://127.0.0.1:9',
    },
  });
  return { prepare, getCodexExtraSpawnConfig, buildSessionMcpConfig, scopedReady, release };
}

const guest = {
  credentialMode: 'oauth-bearer' as const, accountHostKey: 'guest-host',
  deviceHostedGuestProviderId: 'openai', deviceHostedGuestSessionId: 'guest-session',
};

// Production entry: shared Desktop / Node Host spawn factory. The hosted adapter
// tests stub this factory and missed process-level local MCP initialization before
// the thread isolation gate. A single slow local MCP can block mcpServerStatus/list
// even though the guest will only use its controller's tunnel. Unit tier: no IO.
describe('Codex spawn MCP ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveCatalog({ ...BUNDLED_CATALOG, providers: [] });
    vi.mocked(prepareCodexBrowserCompanion).mockResolvedValue({
      status: 'ready', extraArgs: browserArgs, version: 'fixture', startupTimeoutMs: 10_000,
      browserClientPath: 'unused-browser-client',
    });
  });

  it('does not provision local MCP credentials or browser processes for a shared guest', async () => {
    const f = fixture();
    const result = await f.prepare([], guest);
    expect(result.extraArgs.some(arg => arg.startsWith('mcp_servers.'))).toBe(false);
    expect(result.extraEnv).not.toHaveProperty('LOCAL_MCP_TOKEN');
    expect(result.buildSessionMcpConfig).toBeUndefined();
    expect(result.codexBrowserUseAvailable).toBe(false);
    expect(f.getCodexExtraSpawnConfig).not.toHaveBeenCalled();
    expect(prepareCodexBrowserCompanion).not.toHaveBeenCalled();
    expect(result.codexProxyActive).toBe(true);
    await result.onHostRetired?.();
    expect(f.release).toHaveBeenCalledWith('guest-host');
  });

  it('preserves the owner task MCP bridge and browser configuration', async () => {
    const f = fixture();
    const result = await f.prepare([], { credentialMode: 'oauth-bearer' });
    expect(result.extraArgs).toEqual(expect.arrayContaining([...localMcpArgs, ...browserArgs]));
    expect(result.extraEnv).toHaveProperty('LOCAL_MCP_TOKEN', 'fixture-only');
    expect(result.buildSessionMcpConfig).toBe(f.buildSessionMcpConfig);
    expect(result.codexBrowserUseAvailable).toBe(true);
    // The per-host preparation must not mutate the shared bridge snapshot.
    expect(localMcpArgs).not.toContain(browserArgs[1]);
  });

  it('keeps Review hosts free of local MCP provisioning', async () => {
    const f = fixture();
    const result = await f.prepare([], { hostPurpose: 'review', credentialMode: 'oauth-bearer' });
    expect(result.extraArgs.some(arg => arg.startsWith('mcp_servers.'))).toBe(false);
    expect(f.getCodexExtraSpawnConfig).not.toHaveBeenCalled();
    expect(prepareCodexBrowserCompanion).not.toHaveBeenCalled();
  });

  it('still fails closed and releases the guest proxy when it is unavailable', async () => {
    const f = fixture();
    f.scopedReady.mockReturnValue(false);
    await expect(f.prepare([], guest)).rejects.toMatchObject({ codexSpawnConfigFatal: true });
    expect(f.release).toHaveBeenCalledOnce();
  });
});

// #10523 unit: the real spawn factory must wait for routing or fail before a
// fallback endpoint is frozen. Listener-only tests missed this config boundary.
type Ports = Parameters<typeof createCodexSpawnConfig>[0];
type Context = Parameters<ReturnType<typeof createCodexSpawnConfig>>[1];
const provider = buildUserProvider({ id: 'fixture-provider', name: 'Fixture', runtimes: { codex: {
  baseUrl: 'https://provider.invalid/v1', wireProtocol: 'openai-responses', supportsImageGeneration: true,
  models: [{ id: 'fixture-model', name: 'Fixture model' }],
} } });

function routeFixture() {
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
  beforeEach(() => {
    setActiveCatalog({ ...BUNDLED_CATALOG, providers: [provider] });
    vi.mocked(prepareCodexBrowserCompanion).mockResolvedValue({
      status: 'ready', extraArgs: [], version: 'fixture', startupTimeoutMs: 10_000,
      browserClientPath: 'unused-browser-client',
    });
  });

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
    const f = routeFixture();
    await expect(f.prepare([], ctx)).rejects.toMatchObject({ codexSpawnConfigFatal: true });
    expect(f.endpoint).not.toHaveBeenCalled();
    if (ctx.accountHostKey || ctx.localAuthPolicy === 'isolated') expect(f.release).toHaveBeenCalledOnce();
  });

  it('waits for warmup, then freezes the ready endpoint and selected custom route', async () => {
    const f = routeFixture();
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
    const f = routeFixture();
    await expect(f.prepare([], { credentialMode: 'gateway-key' })).rejects.toMatchObject({ codexSpawnConfigFatal: true });
    f.ready();
    const config = await f.prepare([], { credentialMode: 'gateway-key' });
    expect(config.codexProxyActive).toBe(true);
    expect(config.codexCustomProviderRoutes).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: provider.id })]));
  });

  it('leaves remote materialization independent of the local proxy', async () => {
    const f = routeFixture();
    expect(await f.prepare([], { remoteHostId: 'remote-fixture', credentialMode: 'gateway-key' })).toEqual({ extraArgs: ['remote'], extraEnv: {} });
    expect(f.warmup).not.toHaveBeenCalled();
  });
});
