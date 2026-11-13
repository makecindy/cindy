/**
 * Host vs desktop: the Claude auth adapter behind the loopback proxy.
 *
 *   DesktopClaudeAuthAdapter and the Host's proxy adapter (apps/host/src/agent/runtime.ts
 *   createClaudeGatewayAuth with a proxy) read the same facts here: gateway key, Claude
 *   Code login and its binding, proxy readiness, SuperGrok logins and subscription
 *   account kinds. For every source × credential mode × model they must return the same
 *   state and the same environment. The only allowed difference: where the desktop CLI
 *   carries the public provider placeholder, the Host CLI carries its runtime secret.
 *   The one-shot credential (getOneShotAuth: the Host's own direct requests) matches for
 *   every set of facts, so neither side's one-shot request uses the subscription.
 *   Facts are synthetic; no CLI, network or real credential store is used.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthAdapterOptions, AuthState } from '@cindy/maker-core';

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
  const proxy = { isReady: () => h.proxyReady, inboundSecret: () => HOST_SECRET };
  const grok = { hasGrokOAuthLogin: (id: string) => h.grokLogins.has(id), grokAccountIdentity: (id: string) => h.grokLogins.get(id) };
  host = createClaudeGatewayAuth(gateway, async () => { throw new Error('Unexpected direct route'); }, cli, proxy, grok);
}, 120_000);

/** The one allowed difference, folded to a common token. */
const placeholder = (env: Record<string, string>, own: string) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === 'ANTHROPIC_API_KEY' && v === own ? '<proxy placeholder>' : v]));

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
  it('state and environment match for every source, mode and model', async () => {
    const mismatches: unknown[] = [];
    let cells = 0;
    for (const f of facts) {
      Object.assign(h, { gatewayKey: f.gatewayKey, nativeLogin: f.nativeLogin, bound: f.bound, proxyReady: f.proxyReady });
      h.grokLogins = f.grok ? new Map([['xai-acct', 'grok@example.test']]) : new Map();
      // The facts are fixed for this round, so its cells can run together.
      const round = providers.flatMap(providerId => modes.flatMap(credentialMode => models.map(model => ({ providerId, credentialMode, model }))));
      cells += round.length;
      await Promise.all(round.map(async cell => {
        const opts = cell as AuthAdapterOptions;
        const [ds, hs, de, he] = await Promise.all([
          desktop.getState(opts), host.getState(opts), desktop.getAuthEnv(opts), host.getAuthEnv(opts),
        ]);
        const denv = placeholder(de, CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY);
        const henv = placeholder(he, HOST_SECRET);
        if (JSON.stringify(ds) !== JSON.stringify(hs) || JSON.stringify(denv) !== JSON.stringify(henv))
          mismatches.push({ facts: f, opts, desktop: { state: ds, env: denv }, host: { state: hs, env: henv } });
      }));
    }
    expect(cells).toBe(facts.length * providers.length * modes.length * models.length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  }, 120_000);

  it('the one-shot credential matches for every set of facts', async () => {
    const outcomes = new Set<string>();
    for (const f of facts) {
      Object.assign(h, { gatewayKey: f.gatewayKey, nativeLogin: f.nativeLogin, bound: f.bound, proxyReady: f.proxyReady });
      h.grokLogins = f.grok ? new Map([['xai-acct', 'grok@example.test']]) : new Map();
      const [d, o] = [await desktop.getOneShotAuth!(), await host.getOneShotAuth!()];
      expect({ facts: f, host: o }).toEqual({ facts: f, host: d });
      outcomes.add(JSON.stringify(d));
    }
    // Both outcomes occur: the gateway key on the gateway endpoint, and the fallback (null).
    expect([...outcomes].sort()).toEqual([JSON.stringify({ apiKey: 'sk-xd-gateway', baseURL: 'https://gateway.test' }), 'null'].sort());
  });

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
