/**
 * 测试价值
 * - 可观察结果：桌面的 desktopPiAuthAdapter（pi-host.ts，桌面自己的端口）与 Host 引擎图里交给 Pi 的
 *   鉴权适配器（apps/host/src/agent/runtime.ts 的 createPiAuthAdapter 实例，Host 自己的端口）对每个
 *   来源给出的 getState 与 getAuthEnv。两边读同一组事实：网关 key、SuperGrok 登录、订阅账号种类、
 *   目录里的 Codex 账号供应商、自定义供应商（各种鉴权方式）及其 key 与 OAuth 令牌、同一个 codex-home。
 * - 规则依据：放行表第 19 行丙 3（审核方 m1-cp18e：只加对照，差异列出，不改代码；m1-cp18b2 对齐
 *   codex-builtin 那一类：判断 OpenAI 订阅时只算用户添加的来源，差别清零）。
 * - 断言方式：逐格比较；不同的格子按类别写死在 KNOWN_DIFFERENCES 里，类别有增减都会失败。
 * - tier：unit（真实临时 profile；HOME 是空目录且跑完仍为空；凭据是合成的，不起 Pi，不连网）。
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthAdapter, AuthAdapterOptions } from '@cindy/maker-core';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  userDataDir: '', home: '', dataOwnerId: 'owner-a' as string | null,
  gatewayKey: null as string | null,
  grok: new Set<string>(),
  accounts: new Map<string, 'claude' | 'xai'>([['xai-acct', 'xai'], ['claude-acct', 'claude']]),
  customs: [] as unknown[],
  keys: new Map<string, string>(),
  oauthTokens: new Set<string>(),
}));

vi.mock('../../userDataPath.js', async (original) => ({
  ...(await original<typeof import('../../userDataPath.js')>()),
  getUserDataDir: () => h.userDataDir,
  userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts),
  // The Host's configureHostOwner points the same reader at this profile.
  configureUserDataDir: () => {},
}));
configureOwnerContext({
  read: () => ({ dataOwnerId: h.dataOwnerId, generation: 1, boundaryPending: false }),
  fallbackBaseDir: () => h.userDataDir,
});
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, getAppPath: () => h.userDataDir, isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../managed-skills.js', () => ({ listCindyManagedSkills: async () => [], cindyManagedSkillRoots: async () => [] }));
vi.mock('../../device-link/providerShareAvailabilityTransport.js', () => ({
  disableShareAvailability: () => { throw new Error('Unexpected standby-share mutation in credential test'); },
}));
vi.mock('../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../appSessionState.js')>();
  return {
    ...actual,
    getActiveAppSession: () => ({ mode: 'cloud' as const, dataOwnerId: h.dataOwnerId, generation: 1 }),
    activeOwnerScopeKey: () => `cloud:${h.dataOwnerId}:1`,
    isAppSessionBoundaryPending: () => false,
  };
});
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../secrets/providerSecretStore.js', async (original) => ({
  ...(await original<typeof import('../../secrets/providerSecretStore.js')>()),
  getProviderSecretStore: () => ({ get: () => h.gatewayKey, remove: () => ({ success: true }) }),
  readCustomProviderKey: (id: string) => h.keys.get(id) ?? null,
}));
vi.mock('../grok-oauth-login.desktop.js', async (original) => ({
  ...(await original<typeof import('../grok-oauth-login.desktop.js')>()),
  hasGrokOAuthLogin: (id = 'xai') => h.grok.has(id),
  grokAccountIdentity: (id = 'xai') => (h.grok.has(id) ? `${id}@example.test` : undefined),
}));
vi.mock('../subscription-account-kind.js', async (original) => {
  const actual = await original<typeof import('../subscription-account-kind.js')>();
  const kind = (id?: string | null) => (id ? h.accounts.get(id) ?? null : null);
  return { ...actual, subscriptionAccountKind: kind,
    isClaudeSubscriptionProviderId: (id?: string | null) => id === 'anthropic' || kind(id) === 'claude',
    isXaiSubscriptionProviderId: (id?: string | null) => id === 'xai' || kind(id) === 'xai' };
});
vi.mock('../custom-provider-header-secrets.js', async (original) => ({
  ...(await original<typeof import('../custom-provider-header-secrets.js')>()),
  listCustomProvidersWithSecureHeaders: async () => h.customs,
}));
vi.mock('../generic-oauth.desktop.js', async (original) => ({
  ...(await original<typeof import('../generic-oauth.desktop.js')>()),
  readCachedGenericOAuthAccessToken: (id: string) => (h.oauthTokens.has(id) ? 'fixture-oauth-token' : null),
}));

import { desktopPiAuthAdapter } from '../pi-host.js';
import { getActiveCatalog, setActiveCatalog } from '../active-catalog.js';

type Adapter = Pick<AuthAdapter, 'getState' | 'getAuthEnv'>;
let host: Adapter;
let restoreCatalog: (() => void) | undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pi-adapter-parity-'));

beforeAll(async () => {
  h.home = path.join(root, 'home');
  fs.mkdirSync(h.home);
  vi.spyOn(os, 'homedir').mockReturnValue(h.home);
  h.userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(path.join(h.userDataDir, 'codex-home'), { recursive: true });
  const previous = getActiveCatalog();
  const openai = previous.providers.find(provider => provider.id === 'openai') ?? previous.providers[0];
  setActiveCatalog({ ...previous, providers: [...previous.providers,
    { ...openai, id: 'codex-acct', source: 'user', auth: { method: 'oauth', native: 'codex' } },
    { ...openai, id: 'codex-builtin', source: 'builtin', auth: { method: 'oauth', native: 'codex' } }] } as never);
  restoreCatalog = () => setActiveCatalog(previous);
  const piRuntime = (models: string[]) => ({ baseUrl: 'https://byom.example.test/v1', models: models.map(id => ({ id })) });
  h.customs = [
    { id: 'cprov-key', name: 'Keyed', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime(['m']) } },
    { id: 'cprov-nokey', name: 'Unkeyed', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime(['m']) } },
    { id: 'cprov-none', name: 'Keyless', auth: { method: 'none' }, runtimes: { pi: piRuntime(['m']) } },
    { id: 'cprov-oauth', name: 'OAuth', auth: { method: 'oauth', oauth: { authorizeUrl: 'https://auth.example.test', tokenUrl: 'https://auth.example.test/t', clientId: 'c' } }, runtimes: { pi: piRuntime(['m']) } },
    { id: 'cprov-oauth-missing', name: 'OAuth without token', auth: { method: 'oauth', oauth: { authorizeUrl: 'https://auth.example.test', tokenUrl: 'https://auth.example.test/t', clientId: 'c' } }, runtimes: { pi: piRuntime(['m']) } },
  ];
  h.keys.set('cprov-key', 'fixture-byom-key');
  h.oauthTokens.add('cprov-oauth');

  // The Host side: the agent graph as Host main builds it, with its own Pi auth ports. The
  // provider config's readers stand for the Host's own stores and read the same facts.
  const runtimeModule = '../../../../../host/src/agent/runtime.ts';
  const mcpModule = '../../../../../host/src/agent/mcp-runtime.ts';
  const claudeAuthModule = '../../../../../host/src/agent/claude-auth.mjs';
  const providerConfigModule = '../../../../../host/src/agent/provider-config.ts';
  const { createHostCodexAccounts } = (await import(/* @vite-ignore */ providerConfigModule)) as {
    createHostCodexAccounts(options: Record<string, unknown>, scope: Record<string, unknown>): unknown;
  };
  const { createHostAgentGraph } = (await import(/* @vite-ignore */ runtimeModule)) as { createHostAgentGraph(options: Record<string, unknown>): { pi: { deps: { auth: Adapter } } } };
  const { createHostMcpRuntime } = (await import(/* @vite-ignore */ mcpModule)) as { createHostMcpRuntime(ports: Record<string, unknown>): { close(): Promise<void> } };
  const { configureHostOwner } = (await import(/* @vite-ignore */ claudeAuthModule)) as { configureHostOwner(input: Record<string, unknown>): void };
  configureHostOwner({ userDataDir: h.userDataDir, ownerId: 'owner-a' });
  const harnessRoot = path.join(root, 'harnesses');
  const rgDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(rgDir, { recursive: true });
  fs.writeFileSync(path.join(rgDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  const graph = createHostAgentGraph({
    userDataDir: h.userDataDir, harnessRoot,
    gateway: { endpoint: 'https://gateway.test', get credential() { return h.gatewayKey; } },
    binaryPath: path.join(root, 'claude'), codexBinaryPath: path.join(root, 'codex'), piBinaryPath: path.join(root, 'pi'),
    mcpRuntime: mcp, mcpProviders: [], storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: (id = 'xai') => h.grok.has(id), grokAccountIdentity: (id = 'xai') => (h.grok.has(id) ? `${id}@example.test` : undefined) },
      list: async () => h.customs,
      readKey: (id: string) => h.keys.get(id) ?? null,
      oauth: { readCachedGenericOAuthAccessToken: (id: string) => (h.oauthTokens.has(id) ? 'fixture-oauth-token' : null) },
      // The Host's own Codex account service over this profile, as provider-config.ts builds it.
      codexAccounts: createHostCodexAccounts({ profileDir: h.userDataDir, getCodexBinary: () => null },
        { owner: 'cloud:owner-a:1', check: () => {}, closed: () => false }),
      publicViews: async () => [],
    },
  });
  host = graph.pi.deps.auth;
});

afterAll(() => {
  restoreCatalog?.();
  vi.restoreAllMocks();
  expect(fs.readdirSync(h.home)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

const providers = [undefined, 'xd', 'cindy', 'anthropic', 'openai', 'codex-acct', 'codex-builtin', 'xai', 'xai-acct', 'claude-acct',
  'cprov-key', 'cprov-nokey', 'cprov-none', 'cprov-oauth', 'cprov-oauth-missing', 'cprov-unknown'];
const facts = [] as Array<{ gatewayKey: string | null; grok: boolean }>;
for (const gatewayKey of ['sk-xd-gateway', null]) for (const grok of [true, false]) facts.push({ gatewayKey, grok });

function fieldDifferences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map(key => `${key}: ${JSON.stringify(a[key]) ?? 'absent'} -> ${JSON.stringify(b[key]) ?? 'absent'}`);
}
const settle = (promise: Promise<unknown>) => promise.then(value => value as Record<string, unknown>, error => ({ thrown: String((error as Error).message) }));

/**
 * The differences found, by source and field, with the number of fact sets (of 4) where each occurs.
 * m1-cp18e found one class (codex-builtin: the Host took any catalog provider with a native Codex login
 * as an OpenAI subscription); m1-cp18b2 aligned it. Codex-routed sources inherit the Codex adapter, whose
 * differences are recorded in hostCodexAuthAdapterParity; none shows here on these facts.
 */
const KNOWN_DIFFERENCES: Record<string, number> = {};

describe('Host and desktop Pi auth adapters', () => {
  it('differ only where recorded, for every source on every set of facts', async () => {
    const observed: Record<string, number> = {};
    let cells = 0;
    for (const f of facts) {
      h.gatewayKey = f.gatewayKey;
      h.grok = f.grok ? new Set(['xai', 'xai-acct']) : new Set();
      for (const providerId of providers) {
        const opts = { providerId } as AuthAdapterOptions;
        const [ds, hs, de, he] = await Promise.all([
          settle(desktopPiAuthAdapter.getState(opts)), settle(host.getState(opts)),
          settle(desktopPiAuthAdapter.getAuthEnv(opts)), settle(host.getAuthEnv(opts)),
        ]);
        cells += 1;
        const state = fieldDifferences(ds, hs);
        const env = fieldDifferences(de, he);
        if (!state.length && !env.length) continue;
        const key = `${providerId ?? '(none)'} | state ${state.join('; ') || '='} | env ${env.join('; ') || '='}`;
        observed[key] = (observed[key] ?? 0) + 1;
      }
    }
    expect(cells).toBe(facts.length * providers.length);
    expect(observed).toEqual(KNOWN_DIFFERENCES);
  });

});
