/**
 * Host vs desktop: the Claude auth adapter behind the loopback proxy.
 *
 *   DesktopClaudeAuthAdapter and the Host's proxy adapter (apps/host/src/agent/runtime.ts
 *   createClaudeGatewayAuth with a proxy) read the same facts here: gateway key, Claude
 *   Code login and its binding, proxy readiness, SuperGrok logins and subscription
 *   account kinds. For every source × credential mode × model they must return the same
 *   state and the same spawn environment: what maker-core's buildClaudeEnv makes of the
 *   adapter's environment and the engine endpoint (the loopback proxy once ready, else the
 *   upstream), so the Claude Code login branch that drops ANTHROPIC_BASE_URL is compared too.
 *   The allowed differences, only while the proxy is ready: where the desktop CLI carries the
 *   public provider placeholder, the Host CLI carries its runtime secret; where the desktop CLI
 *   carries the gateway key, the Host CLI carries its gateway secret, which the Host proxy swaps
 *   for the key current when each request arrives (GATEWAY_SECRET_CELLS lists them). A Host
 *   secret always comes with the loopback address. When the proxy did not start, both carry the
 *   desktop's values to the upstream. The effective one-shot request (getOneShotAuth, else the
 *   adapter's key on the engine endpoint, as maker-core's oneShot) matches the same way, so
 *   neither side's one-shot request uses the subscription.
 *   Facts are synthetic; no CLI, network or real credential store is used.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthAdapter, AuthAdapterOptions, AuthState } from '@cindy/maker-core';
import { buildClaudeEnv } from '../../../../../../packages/maker-core/src/agents/claude-code/env-builder.js';
import { resolveEffectiveCredentialModeFromAuthSource } from '../../../../../../packages/maker-core/src/agents/credential-mode.js';

const h = vi.hoisted(() => ({
  nativeLogin: true,
  bound: true,
  gatewayKey: 'sk-xd-gateway' as string | null,
  proxyReady: true,
  networkEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890' } as Record<string, string>,
  accounts: new Map<string, 'claude' | 'xai'>([['xai-acct', 'xai'], ['claude-acct', 'claude']]),
  grokLogins: new Map<string, string>(),
  gatewayEndpoint: 'https://gateway.test',
}));

vi.mock('../provider-presentation-store.js', () => ({
  retainInvalidatedProviderPresentation: vi.fn(),
  retainProviderPresentationAfterAuthChange: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/xdt-test-userdata-nonexistent', getAppPath: () => '/tmp/xdt-test-app', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => true },
  shell: { openExternal: async () => { throw new Error('Unexpected browser request'); } },
}));
vi.mock('../managed-skills.js', () => ({ listCindyManagedSkills: async () => [], cindyManagedSkillRoots: async () => [] }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../nativeProviderAuthBinding.js', async (original) => ({
  ...(await original<typeof import('../nativeProviderAuthBinding.js')>()),
  isNativeProviderAuthRevoked: () => false,
  isNativeProviderAuthBound: () => h.bound,
}));
vi.mock('../claude-native-auth.js', () => ({
  hasClaudeNativeLogin: () => h.bound && h.nativeLogin,
  hasClaudeNativeLoginUnbound: () => h.nativeLogin,
}));
// The desktop's readClaudeNativeLogin: the binding, then the CLI's own status.
vi.mock('../claude-native-connection.js', () => ({
  readClaudeNativeLogin: async () => (h.bound && h.nativeLogin ? { loggedIn: true, email: 'user@example.test' } : null),
  disconnectClaudeNativeLogin: async () => {},
}));
vi.mock('../claude-native-cli.desktop.js', () => ({ claudeCliNetworkEnv: async () => ({ ...h.networkEnv }) }));
vi.mock('../claude-legacy-config-migration.js', () => ({ ensureLegacyClaudeConfigMigrated: async () => {} }));
vi.mock('../subscription-account-kind.js', async (original) => {
  const actual = await original<typeof import('../subscription-account-kind.js')>();
  const kind = (id?: string | null) => (id ? h.accounts.get(id) ?? null : null);
  return {
    ...actual,
    subscriptionAccountKind: kind,
    isClaudeSubscriptionProviderId: (id?: string | null) => id === 'anthropic' || kind(id) === 'claude',
    isXaiSubscriptionProviderId: (id?: string | null) => id === 'xai' || kind(id) === 'xai',
  };
});
// The desktop's real subscriptionAccountState reads these two.
vi.mock('../grok-oauth-login.desktop.js', async (original) => ({
  ...(await original<typeof import('../grok-oauth-login.desktop.js')>()),
  hasGrokOAuthLogin: (id: string) => h.grokLogins.has(id),
  grokAccountIdentity: (id: string) => h.grokLogins.get(id),
}));
vi.mock('../../secrets/providerSecretStore.js', async (original) => ({
  ...(await original<typeof import('../../secrets/providerSecretStore.js')>()),
  getProviderSecretStore: () => ({ get: () => h.gatewayKey, remove: () => ({ success: true }) }),
}));
vi.mock('../shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: async () => ({ warnings: [], persistentWarnings: [] }),
  prepareSharedProjectSkillLinks: async () => ({ warnings: [] }),
  sharedGlobalSkillLinksFingerprint: async () => 'test',
  shouldProjectToClaudeSkills: async () => true,
  markClaudeSessionObserved: () => {},
  resetClaudeSessionObservedForTest: () => {},
  SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE: 'sync disabled',
}));
vi.mock('../built-in-skills.js', () => ({
  prepareBuiltInSkills: async () => ({ descriptors: [], projectionSafe: true, warnings: [] }),
  refreshBuiltInSharedSkillLinks: async () => ({ warnings: [] }),
  refreshBuiltInClaudeSkillLinks: async () => ({ warnings: [] }),
  resolveBundledSystemSkillsRoot: () => '/tmp/cindy-bundled-system-skills',
}));
vi.mock('../anthropic-compat-proxy-host.js', () => ({ isAnthropicCompatProxyHandleReady: () => h.proxyReady }));
// Both sides' claudeUpstreamEndpoint read the effective gateway endpoint.
vi.mock('../../model-access/effectiveEndpoint.js', async (original) => ({
  ...(await original<typeof import('../../model-access/effectiveEndpoint.js')>()),
  effectiveXdGatewayBaseUrl: () => h.gatewayEndpoint,
}));

import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY, DesktopClaudeAuthAdapter } from '../auth-adapters.js';

const HOST_SECRET = 'host-runtime-secret-fixture';
const HOST_GATEWAY_SECRET = 'host-gateway-secret-fixture';
const NO_FOLD = '<no fold>';
const PROXY_URL = 'http://127.0.0.1:4545';
/** The engine endpoint on both sides (getClaudeEndpoint): the proxy once ready, else the upstream. */
const engineEndpoint = () => (h.proxyReady ? PROXY_URL : h.gatewayEndpoint);
const runtimeConfig = { get endpoint() { return engineEndpoint(); } };
type Adapter = {
  getState(opts?: AuthAdapterOptions): Promise<AuthState>;
  getAuthEnv(opts?: AuthAdapterOptions): Promise<Record<string, string>>;
  getOneShotAuth?(): Promise<{ apiKey: string; baseURL?: string } | null>;
};
let host: Adapter;
const desktop: Adapter = new DesktopClaudeAuthAdapter();

beforeAll(async () => {
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostRuntime = '../../../../../host/src/agent/runtime.ts';
  const { createClaudeGatewayAuth } = (await import(/* @vite-ignore */ hostRuntime)) as {
    createClaudeGatewayAuth(...args: unknown[]): Adapter;
  };
  const gateway = { get credential() { return h.gatewayKey; }, endpoint: 'https://gateway.test' };
  const cli = {
    readClaudeCliLoginStatus: async () => ({ loggedIn: h.nativeLogin }),
    claudeCliNetworkEnv: async () => ({ ...h.networkEnv }),
  };
  const proxy = { isReady: () => h.proxyReady, endpoint: engineEndpoint, inboundSecret: () => HOST_SECRET,
    gatewayInboundSecret: () => HOST_GATEWAY_SECRET };
  const grok = { hasGrokOAuthLogin: (id: string) => h.grokLogins.has(id), grokAccountIdentity: (id: string) => h.grokLogins.get(id) };
  host = createClaudeGatewayAuth(gateway, async () => { throw new Error('Unexpected direct route'); }, cli, proxy, grok);
}, 120_000);

/** The allowed differences, folded to common tokens. */
const placeholder = (env: Record<string, string>, own: string, gatewayKey: string) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k !== 'ANTHROPIC_API_KEY' ? v
    : v === own ? '<proxy placeholder>' : v === gatewayKey ? '<gateway key via the proxy>' : v]));

/**
 * Source and credential mode of every cell where the desktop CLI spawns with the gateway key (with
 * or without a Claude Code login, for every model): every source but a retired Claude account, with
 * no credential mode or the gateway-key mode, except a SuperGrok account without a mode, which only
 * starts on its own login. There the Host CLI carries its gateway secret.
 */
const GATEWAY_SECRET_CELLS = ['- -', '- gateway-key', 'anthropic -', 'anthropic gateway-key', 'cindy -', 'cindy gateway-key',
  'cprov-custom -', 'cprov-custom gateway-key', 'openai -', 'openai gateway-key', 'xai-acct gateway-key',
  'xd -', 'xd gateway-key'];

const facts = [] as Array<{ gatewayKey: string | null; nativeLogin: boolean; bound: boolean; proxyReady: boolean; grok: boolean }>;
for (const gatewayKey of ['sk-xd-gateway', null])
  for (const nativeLogin of [true, false])
    for (const bound of [true, false])
      for (const proxyReady of [true, false])
        for (const grok of [true, false]) facts.push({ gatewayKey, nativeLogin, bound, proxyReady, grok });
const providers = [undefined, 'xd', 'cindy', 'anthropic', 'openai', 'xai-acct', 'claude-acct', 'cprov-custom'];
const modes = [undefined, 'gateway-key', 'provider-oauth', 'oauth-bearer'] as const;
const models = [undefined, 'claude-sonnet-4-5', 'chatgpt/gpt-5.4', 'grok-4'];

describe('Host and desktop Claude adapters decide the same way', () => {
  it('state and the spawn environment match for every source, mode and model', async () => {
    const mismatches: unknown[] = [];
    const gatewaySecretCells = new Set<string>();
    let cells = 0;
    let nativeCells = 0;
    for (const f of facts) {
      Object.assign(h, { gatewayKey: f.gatewayKey, nativeLogin: f.nativeLogin, bound: f.bound, proxyReady: f.proxyReady });
      h.grokLogins = f.grok ? new Map([['xai-acct', 'grok@example.test']]) : new Map();
      // The facts are fixed for this round, so its cells can run together.
      const round = providers.flatMap(providerId => modes.flatMap(credentialMode => models.map(model => ({ providerId, credentialMode, model }))));
      cells += round.length;
      // buildClaudeEnv reads only these inputs (the source only outside the gateway-key mode, the
      // model only without a mode): spawn each distinct set once per round.
      const spawns = new Map<string, Promise<[Record<string, string>, Record<string, string>]>>();
      await Promise.all(round.map(async cell => {
        const opts = cell as AuthAdapterOptions;
        const [ds, hs] = await Promise.all([desktop.getState(opts), host.getState(opts)]);
        if (JSON.stringify(ds) !== JSON.stringify(hs)) mismatches.push({ facts: f, opts, desktop: ds, host: hs });
        if (!ds.authenticated) return;
        // As maker-core's Claude spawn: the effective mode decides the Claude Code login branch.
        const nativeCliAuth = resolveEffectiveCredentialModeFromAuthSource(cell.credentialMode, ds.authSource) === 'oauth-bearer';
        if (nativeCliAuth) nativeCells += 1;
        const spawn = (adapter: Adapter) => buildClaudeEnv(adapter as AuthAdapter, runtimeConfig as never, {
          credentialMode: cell.credentialMode, nativeCliAuth, authModel: cell.model, sessionProviderId: cell.providerId ?? null });
        const key = JSON.stringify([cell.credentialMode ?? null, cell.credentialMode && cell.credentialMode !== 'gateway-key' ? cell.providerId ?? null : null,
          cell.credentialMode ? null : cell.model ?? null, nativeCliAuth]);
        if (!spawns.has(key)) spawns.set(key, Promise.all([spawn(desktop), spawn(host)]));
        const [de, he] = await spawns.get(key)!;
        if (nativeCliAuth && ('ANTHROPIC_BASE_URL' in de || 'ANTHROPIC_BASE_URL' in he)) mismatches.push({ facts: f, opts, native: { de, he } });
        // A Host secret only ever travels with the loopback address.
        if ([HOST_SECRET, HOST_GATEWAY_SECRET].includes(he.ANTHROPIC_API_KEY) && he.ANTHROPIC_BASE_URL !== PROXY_URL)
          mismatches.push({ facts: f, opts, secretOffProxy: he });
        // A proxy that did not start leaves both CLIs on the upstream with the desktop's values: no fold.
        const denv = placeholder(de, f.proxyReady ? CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY : NO_FOLD, f.proxyReady ? h.gatewayKey ?? '' : NO_FOLD);
        const henv = placeholder(he, f.proxyReady ? HOST_SECRET : NO_FOLD, f.proxyReady ? HOST_GATEWAY_SECRET : NO_FOLD);
        if (de.ANTHROPIC_API_KEY !== undefined && de.ANTHROPIC_API_KEY === h.gatewayKey && he.ANTHROPIC_API_KEY === HOST_GATEWAY_SECRET)
          gatewaySecretCells.add(`${cell.providerId ?? '-'} ${cell.credentialMode ?? '-'}`);
        if (JSON.stringify(denv) !== JSON.stringify(henv)) mismatches.push({ facts: f, opts, desktop: denv, host: henv });
      }));
    }
    expect(cells).toBe(facts.length * providers.length * modes.length * models.length);
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(nativeCells).toBeGreaterThan(0);
    expect([...gatewaySecretCells].sort()).toEqual(GATEWAY_SECRET_CELLS);
  }, 120_000);

  it('the effective one-shot request matches for every set of facts', async () => {
    // maker-core's Claude oneShot: getOneShotAuth, else the adapter's key on the engine endpoint.
    const effective = async (adapter: Adapter) => {
      if (!(await adapter.getState()).authenticated) return null;
      const own = await adapter.getOneShotAuth!();
      if (own?.apiKey) return { apiKey: own.apiKey, baseURL: own.baseURL ?? engineEndpoint() };
      const apiKey = (await adapter.getAuthEnv()).ANTHROPIC_API_KEY;
      return apiKey ? { apiKey, baseURL: engineEndpoint() } : null;
    };
    const outcomes = new Set<string>();
    for (const f of facts) {
      Object.assign(h, { gatewayKey: f.gatewayKey, nativeLogin: f.nativeLogin, bound: f.bound, proxyReady: f.proxyReady });
      h.grokLogins = f.grok ? new Map([['xai-acct', 'grok@example.test']]) : new Map();
      const [d, o] = [await effective(desktop), await effective(host)];
      if (o && [HOST_SECRET, HOST_GATEWAY_SECRET].includes(o.apiKey)) expect(o.baseURL).toBe(PROXY_URL);
      const fold = (r: typeof d, secret: string) => r && { ...r, apiKey: r.apiKey === secret ? '<gateway key via the proxy>' : r.apiKey };
      const viaProxy = f.proxyReady && !(f.nativeLogin && f.bound);
      expect({ facts: f, host: fold(o, viaProxy ? HOST_GATEWAY_SECRET : NO_FOLD) })
        .toEqual({ facts: f, host: fold(d, viaProxy ? h.gatewayKey ?? '' : NO_FOLD) });
      outcomes.add(JSON.stringify(d));
    }
    // With a login, the gateway key on the gateway endpoint; without one, the key on the engine
    // endpoint; without a key, nothing.
    expect([...outcomes].sort()).toEqual([JSON.stringify({ apiKey: 'sk-xd-gateway', baseURL: 'https://gateway.test' }),
      JSON.stringify({ apiKey: 'sk-xd-gateway', baseURL: PROXY_URL }), 'null'].sort());
  }, 120_000);

  it('the Host CLI never carries the public placeholder', async () => {
    Object.assign(h, { gatewayKey: null, nativeLogin: true, bound: true, proxyReady: true });
    for (const opts of [{ credentialMode: 'provider-oauth' }, { model: 'chatgpt/gpt-5.4' }] as AuthAdapterOptions[]) {
      expect((await desktop.getAuthEnv(opts)).ANTHROPIC_API_KEY).toBe(CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY);
      expect((await host.getAuthEnv(opts)).ANTHROPIC_API_KEY).toBe(HOST_SECRET);
    }
  });

  it('a pooled subscription account reads its own state on both', async () => {
    const account = {
      readState: async () => ({ authenticated: true, authSource: 'oauth', identity: 'pooled' }) as AuthState,
      assertCurrent: () => {}, configDir: '/tmp/pooled-claude-config', defaultProfile: false,
    };
    for (const proxyReady of [true, false]) {
      h.proxyReady = proxyReady;
      for (const providerId of ['openai', 'anthropic']) {
        const opts = { providerId, nativeSubscriptionAccount: account } as unknown as AuthAdapterOptions;
        expect(await host.getState(opts)).toEqual(await desktop.getState(opts));
        expect(await host.getAuthEnv(opts)).toEqual(await desktop.getAuthEnv(opts));
      }
    }
  });
});
