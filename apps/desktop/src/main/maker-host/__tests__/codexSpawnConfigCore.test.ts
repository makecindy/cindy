import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexSpawnConfig } from '../codexSpawnConfigCore.js';
import { prepareCodexBrowserCompanion } from '../codex-browser-companion.js';

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [] }), getActiveCatalogRevision: () => 1,
}));
vi.mock('../subagent-model-settings-store.js', () => ({
  readSubagentModelSettings: () => ({ codexSmartSubagentRouting: false }),
}));
vi.mock('../codex-smart-subagent-routing.js', () => ({
  prepareCodexSmartSubagentConfig: vi.fn(), codexSmartSubagentRoutingSignature: vi.fn(),
  selectCodexSmartSubagentCandidates: vi.fn(),
}));
vi.mock('../codex-custom-provider-route.js', () => ({
  deriveCodexCustomProviderRoutes: () => [],
  buildCodexCustomProviderArgs: () => ({ extraArgs: [], extraEnv: {} }),
  registerCodexScopedCustomProviderRoutes: () => vi.fn(),
  toCodexCustomProviderHostRoutes: () => [],
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
