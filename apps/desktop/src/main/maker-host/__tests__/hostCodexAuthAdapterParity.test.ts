/**
 * 测试价值
 * - 可观察结果：DesktopCodexAuthAdapter 与 Host 的 Codex 适配器（apps/host/src/agent/runtime.ts
 *   createCodexLocalCliAuth，Host 自己的代码）在同一个真实 profile 上，对 来源 × 凭据模式 给出的
 *   getState 与 getAuthEnv。事实维度：网关 key、codex-home/auth.json 的形态（OAuth、只有 API key、
 *   没有）、openai 绑定、作废标记。
 * - 规则依据：放行表第 19 行丙 2（审核方 m1-cp18e：只加对照，差异列出，不改代码）。
 * - 断言方式：逐格比较；不同的格子按类别写死在 KNOWN_DIFFERENCES 里。类别有增减、或某格换了
 *   类别，测试都会失败，需要重新报审核方。
 * - tier：unit（真实临时 profile 文件；HOME 是空目录且跑完仍为空；令牌是合成的，不起 CLI，不连网）。
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthAdapterOptions, AuthState } from '@cindy/maker-core';
import { DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { writeInvalidatedSystemCodexAuthMarker } from '../codex-auth-invalidation.js';
import { bindNativeProviderAuth, unbindNativeProviderAuth } from '../nativeProviderAuthBinding.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({ userDataDir: '', dataOwnerId: null as string | null, gatewayKey: null as string | null }));

vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => h.userDataDir, userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts) }));
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
    getActiveAppSession: () => ({ mode: h.dataOwnerId ? ('cloud' as const) : ('signed-out' as const), dataOwnerId: h.dataOwnerId, generation: 1 }),
    activeOwnerScopeKey: () => `${h.dataOwnerId ? 'cloud' : 'signed-out'}:${h.dataOwnerId ?? 'none'}:1`,
    isAppSessionBoundaryPending: () => false,
  };
});
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
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

type Adapter = {
  getState(opts?: AuthAdapterOptions): Promise<AuthState>;
  getAuthEnv(opts?: AuthAdapterOptions): Promise<Record<string, string>>;
};
let createHostCodexAuth: (codexHome: string) => Adapter;

beforeAll(async () => {
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostRuntime = '../../../../../host/src/agent/runtime.ts';
  const runtime = (await import(/* @vite-ignore */ hostRuntime)) as {
    createCodexLocalCliAuth(gateway: unknown, route: (id: string) => Promise<unknown>, codexHome: string): Adapter;
  };
  const gateway = { endpoint: 'https://gateway.test', get credential() { return h.gatewayKey; } };
  createHostCodexAuth = codexHome => runtime.createCodexLocalCliAuth(gateway, async () => { throw new Error('Provider requires connection'); }, codexHome);
});

const roots: string[] = [];
const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) expect(fs.readdirSync(home)).toEqual([]);
  h.dataOwnerId = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Facts = { gatewayKey: string | null; auth: 'oauth' | 'api-key' | 'none'; bound: boolean; marker: boolean };
const facts: Facts[] = [];
for (const gatewayKey of ['sk-xd-gateway', null])
  for (const auth of ['oauth', 'api-key', 'none'] as const)
    for (const bound of [true, false])
      for (const marker of [false, true]) facts.push({ gatewayKey, auth, bound, marker });
const providers = [undefined, 'xd', 'cindy', 'openai', 'cprov-custom'];
const modes = [undefined, 'gateway-key', 'oauth-bearer', 'provider-oauth'] as const;

/** A fresh profile with these facts; each side reads its own copy so neither sees the other's writes. */
function profile(f: Facts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-adapter-parity-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  homes.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  h.userDataDir = path.join(root, 'user-data');
  h.dataOwnerId = 'owner-a';
  h.gatewayKey = f.gatewayKey;
  const codexHome = path.join(h.userDataDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  if (f.auth === 'oauth') fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-workspace' } }), { mode: 0o600 });
  if (f.auth === 'api-key') fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-openai' }), { mode: 0o600 });
  if (f.bound) bindNativeProviderAuth('openai', { instanceIsolated: true }); else unbindNativeProviderAuth('openai');
  if (f.marker) writeInvalidatedSystemCodexAuthMarker(codexHome, path.join(home, '.codex', 'auth.json'), 'token_revoked', authPath, 'instance-isolated');
  return codexHome;
}

/** The desktop's settings-page credential diagnostics have no Host counterpart; counted separately. */
const comparable = (state: AuthState) => {
  const rest = { ...state } as Record<string, unknown>;
  delete rest.credentialDiagnostics;
  return rest;
};
const envShape = (env: Record<string, string>, codexHome: string) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === codexHome ? '<codex-home>' : v]));

async function read(adapter: Adapter, codexHome: string, opts: AuthAdapterOptions) {
  const state = await adapter.getState(opts).catch(error => ({ thrown: String((error as Error).message) }));
  const env = await adapter.getAuthEnv(opts).then(value => envShape(value, codexHome)).catch(error => ({ thrown: String((error as Error).message) }));
  return { state: 'thrown' in state ? state : comparable(state as AuthState), env, diagnostics: 'credentialDiagnostics' in state };
}

/** One difference in one field: `field: desktop -> host`. */
function fieldDifferences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map(key => `${key}: ${JSON.stringify(a[key]) ?? 'absent'} -> ${JSON.stringify(b[key]) ?? 'absent'}`);
}

/**
 * The differences found (m1-cp18e), by source, credential mode and field, with the number of fact
 * combinations (of 24) where each occurs. Reported to the reviewer; not changed in this checkpoint.
 */
const KNOWN_DIFFERENCES: Record<string, number> = {
  "(none) / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "(none) / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "(none) / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 2,
  "(none) / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "(none) / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "(none) / (none) | state identity: absent -> \"Cindy AI\" | env =": 2,
  "(none) / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 12,
  "(none) / oauth-bearer | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 11,
  "(none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\" | env =": 1,
  "(none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "(none) / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env =": 1,
  "(none) / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 1,
  "(none) / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env =": 6,
  "(none) / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 6,
  "(none) / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 5,
  "(none) / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\" | env =": 5,
  "cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "cindy / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env =": 6,
  "cindy / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 2,
  "cindy / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 6,
  "cindy / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "cindy / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "cindy / (none) | state identity: absent -> \"Cindy AI\" | env =": 2,
  "cindy / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 12,
  "cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "cindy / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 6,
  "cindy / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 4,
  "cindy / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 12,
  "cindy / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\" | env =": 12,
  "cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\" | env =": 2,
  "cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent | env =": 2,
  "cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 1,
  "cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 1,
  "cprov-custom / (none) | state authenticated: true -> false; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env =": 6,
  "cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 6,
  "cprov-custom / (none) | state errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "cprov-custom / gateway-key | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent | env =": 12,
  "cprov-custom / gateway-key | state errorReason: \"no_key\" -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 12,
  "cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env =": 6,
  "cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env =": 4,
  "cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "cprov-custom / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"Provider OAuth · Proxy\" -> absent | env =": 24,
  "openai / (none) | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 7,
  "openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"API Key · Cindy AI\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\" | env =": 1,
  "openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "openai / (none) | state authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env =": 2,
  "openai / (none) | state errorReason: absent -> \"oauth_not_bound\" | env =": 2,
  "openai / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "openai / oauth-bearer | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 11,
  "openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\" | env =": 1,
  "openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 1,
  "openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 6,
  "openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 5,
  "xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "xd / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env =": 6,
  "xd / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 2,
  "xd / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 6,
  "xd / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "xd / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "xd / (none) | state identity: absent -> \"Cindy AI\" | env =": 2,
  "xd / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 12,
  "xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "xd / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 6,
  "xd / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 4,
  "xd / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 12,
  "xd / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\" | env =": 12,
};

describe('Host and desktop Codex adapters', () => {
  it('differ only where recorded, for every source and credential mode on every set of facts', async () => {
    const observed: Record<string, number> = {};
    let cells = 0;
    let diagnostics = 0;
    for (const f of facts) {
      for (const providerId of providers) for (const credentialMode of modes) {
        const opts = { providerId, credentialMode } as AuthAdapterOptions;
        const desktop = new DesktopCodexAuthAdapter();
        // The desktop's global Codex skills, rules and plugins preparation (row 25); the Host has none.
        vi.spyOn(desktop, 'ensureGlobalCodexAssets').mockResolvedValue();
        const d = await read(desktop, profile(f), opts);
        const hostHome = profile(f);
        const o = await read(createHostCodexAuth(hostHome), hostHome, opts);
        cells += 1;
        if (d.diagnostics) diagnostics += 1;
        expect(o.diagnostics).toBe(false);
        const state = fieldDifferences(d.state as Record<string, unknown>, o.state as Record<string, unknown>);
        const env = fieldDifferences(d.env as Record<string, unknown>, o.env as Record<string, unknown>);
        if (!state.length && !env.length) continue;
        const key = `${providerId ?? '(none)'} / ${credentialMode ?? '(none)'} | state ${state.join('; ') || '='} | env ${env.join('; ') || '='}`;
        observed[key] = (observed[key] ?? 0) + 1;
      }
    }
    expect(cells).toBe(facts.length * providers.length * modes.length);
    // The desktop's settings-page credential diagnostics, which the Host does not produce.
    expect(diagnostics).toBe(160);
    expect(observed).toEqual(KNOWN_DIFFERENCES);
  });
});
