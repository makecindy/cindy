/**
 * 测试价值
 * - 可观察结果：DesktopCodexAuthAdapter 与 Host 按真实装配建出的 Codex 适配器（apps/host/src/agent/runtime.ts
 *   createCodexLocalCliAuth，带 Host 的账号服务与系统登录对账）在同一个真实 profile 上，对 来源 × 凭据模式
 *   给出的 getState、getAuthEnv，以及经共用 buildCodexEnv 与 buildCodexCustomProviderArgs 之后的最终进程环境。
 *   两组装配：安装态（桌面 isPackaged，Host 的系统登录为夹具 HOME 里的 ~/.codex/auth.json）与源码态
 *   （桌面未打包，Host 不对账）。事实维度：网关 key、codex-home/auth.json 的形态（OAuth、只有 API key、
 *   没有）、openai 绑定、作废标记、系统登录有无。
 * - 规则依据：放行表第 19 行丙 2；审核方 m1-cp19 裁定（docs/host/codex-auth-adapter-differences.md）。
 * - 断言方式：逐格比较。maker-core 真实路径交给适配器的输入（authAdapterEntryInputs.ts，由 maker-core
 *   index.test.ts 核对）之外的格子标为普通路径不可达，差异另记。可达且两边都放行的格子，最终进程环境
 *   必须相等。不同的格子按类别写死；类别有增减、或某格换了类别，测试都会失败。
 * - 环境：开头用桌面建链接的同一个函数试一次，按平台与能否建链接选表（Windows 两边都保留已有的
 *   auth.json，见 docs/host/codex-auth-adapter-differences.md “Windows”）；没有记录表的环境只跳过表的比较。
 * - tier：unit（真实临时 profile 文件；HOME 是空目录，跑完只剩夹具自己写的系统登录；令牌是合成的，
 *   不起 CLI，不连网）。
 */
import { configureOwnerContext } from '../../ownerContext.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthAdapterOptions, AuthState } from '@cindy/maker-core';
import { DesktopCodexAuthAdapter } from '../auth-adapters.js';
import { writeInvalidatedSystemCodexAuthMarker } from '../codex-auth-invalidation.js';
import { relinkSharedCodexAuth } from '../codex-auth-link.js';
import { bindNativeProviderAuth, unbindNativeProviderAuth } from '../nativeProviderAuthBinding.js';
import { buildCodexCustomProviderArgs } from '../codex-custom-provider-route.js';
import { buildCodexEnv } from '../../../../../../packages/maker-core/src/agents/codex/env-builder.js';
import { CODEX_AUTH_ADAPTER_ENTRY_INPUTS } from '../../../../../../packages/maker-core/src/agents/codex/__tests__/authAdapterEntryInputs.js';
import type { AuthAdapter } from '@cindy/maker-core';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({ userDataDir: '', dataOwnerId: null as string | null, gatewayKey: null as string | null, packaged: true }));

vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => h.userDataDir, userDataPath: (...parts: string[]) => path.join(h.userDataDir, ...parts) }));
configureOwnerContext({
  read: () => ({ dataOwnerId: h.dataOwnerId, generation: 1, boundaryPending: false }),
  fallbackBaseDir: () => h.userDataDir,
});
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, getAppPath: () => h.userDataDir, get isPackaged() { return h.packaged; } },
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
type Assembly = 'installed' | 'source';
let createHostCodexAuth: (codexHome: string, assembly: Assembly, home: string) => Adapter;

beforeAll(async () => {
  // Non-literal specifiers keep the Host sources out of the desktop typecheck.
  const hostAgent = (file: string) => `../../../../../host/src/agent/${file}`;
  const runtime = (await import(/* @vite-ignore */ hostAgent('runtime.ts'))) as {
    createCodexLocalCliAuth(gateway: unknown, route: (id: string) => Promise<unknown>, codexHome: string, accounts?: unknown,
      config?: undefined, native?: { systemLogin: unknown }): Adapter;
  };
  const { createHostCodexSystemLogin } = (await import(/* @vite-ignore */ hostAgent('codex-system-login.ts'))) as {
    createHostCodexSystemLogin(options: { codexHome: string; systemAuthPath: string | null; loginActive(): boolean }): unknown;
  };
  const { createHostCodexAccounts } = (await import(/* @vite-ignore */ hostAgent('provider-config.ts'))) as {
    createHostCodexAccounts(options: { profileDir: string }, scope: { owner: string; check(): void; closed(): boolean }): { isCodexAccountLoginActive(id: string): boolean };
  };
  const gateway = { endpoint: 'https://gateway.test', get credential() { return h.gatewayKey; } };
  // As createHostAgentGraph and createHostCodexRuntime assemble it: the profile's account service and
  // the system login reconciliation; installed, the system login is the fixture HOME's ~/.codex.
  createHostCodexAuth = (codexHome, assembly, home) => {
    const accounts = createHostCodexAccounts({ profileDir: h.userDataDir }, { owner: '', check: () => {}, closed: () => false });
    const systemLogin = createHostCodexSystemLogin({ codexHome, loginActive: () => accounts.isCodexAccountLoginActive('openai'),
      systemAuthPath: assembly === 'installed' ? path.join(home, '.codex', 'auth.json') : null });
    return runtime.createCodexLocalCliAuth(gateway, async () => { throw new Error('Provider requires connection'); }, codexHome, accounts, undefined, { systemLogin });
  };
});

const roots: string[] = [];
const homes: Array<{ home: string; system: string | null }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  // HOME holds only the system login the fixture wrote, unchanged.
  for (const { home, system } of homes.splice(0)) {
    expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(system === null ? [] : ['.codex', path.join('.codex', 'auth.json')]);
    if (system !== null) expect(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).toBe(system);
  }
  h.dataOwnerId = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Facts = { gatewayKey: string | null; auth: 'oauth' | 'api-key' | 'none'; bound: boolean; marker: boolean; system: boolean };
const facts: Facts[] = [];
for (const gatewayKey of ['sk-xd-gateway', null])
  for (const auth of ['oauth', 'api-key', 'none'] as const)
    for (const bound of [true, false])
      for (const marker of [false, true])
        for (const system of [false, true]) facts.push({ gatewayKey, auth, bound, marker, system });
const SYSTEM_LOGIN = JSON.stringify({ tokens: { access_token: 'system-fixture-token', account_id: 'fixture-workspace' } });
const providers = [undefined, 'xd', 'cindy', 'openai', 'cprov-custom'];
const modes = [undefined, 'gateway-key', 'oauth-bearer', 'provider-oauth'] as const;

/** A fresh profile with these facts; each side reads its own copy so neither sees the other's writes. */
function profile(f: Facts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-adapter-parity-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  if (f.system) {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), SYSTEM_LOGIN, { mode: 0o600 });
  }
  homes.push({ home, system: f.system ? SYSTEM_LOGIN : null });
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
  return { codexHome, home };
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
  const raw = await adapter.getAuthEnv(opts).catch(error => ({ thrown: String((error as Error).message) }) as Record<string, string>);
  const env = 'thrown' in raw ? raw : envShape(raw, codexHome);
  return { state: 'thrown' in state ? state : comparable(state as AuthState), env, raw, diagnostics: 'credentialDiagnostics' in state };
}

/**
 * The process environment a spawn ends with: the shared buildCodexEnv over the adapter's environment,
 * then the shared spawn configuration's extra environment for this credential mode
 * (codexSpawnConfigCore.ts: an unset mode is oauth-bearer with a Codex login, else the gateway key).
 */
async function finalEnv(raw: Record<string, string>, codexHome: string, opts: AuthAdapterOptions, oauthLogin: boolean) {
  const mode = opts.credentialMode ?? (oauthLogin ? 'oauth-bearer' : 'gateway-key');
  const injection = mode === 'oauth-bearer' ? 'oauth-bearer' : mode === 'provider-oauth' ? 'provider-oauth' : 'env-key';
  const env = await buildCodexEnv({ getAuthEnv: async () => raw } as unknown as AuthAdapter, {}, opts);
  Object.assign(env, buildCodexCustomProviderArgs('http://127.0.0.1:9', injection, []).extraEnv);
  return envShape(env, codexHome);
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
/**
 * The differences found (m1-cp19, after the provider-oauth branch and the independent-account
 * order were aligned), by assembly, reachability, source, credential mode and field, with the
 * number of fact combinations (of 48) where each occurs. Ruled in m1-cp19
 * (docs/host/codex-auth-adapter-differences.md): installed and reachable, only the API-key-only
 * auth.json without a gateway key, the error reason where both refuse, the identity labels (M2)
 * and the gateway key in the raw OAuth environment (the final environment is equal); source mode
 * adds the desktop development build's write lock and its system login reconciliation, which the
 * Host from source never does (release table, reconciliation with the system Codex login);
 * unreachable inputs belong to the M2 provider view.
 */
const KNOWN_DIFFERENCES: Record<string, number> = {
  "installed reachable (none) / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 3,
  "installed reachable (none) / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "installed reachable (none) / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "installed reachable (none) / (none) | state identity: absent -> \"Cindy AI\" | env =": 3,
  "installed reachable (none) / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 24,
  "installed reachable (none) / oauth-bearer | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 24,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env =": 4,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "installed unreachable cindy / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env =": 12,
  "installed unreachable cindy / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 3,
  "installed unreachable cindy / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 12,
  "installed unreachable cindy / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "installed unreachable cindy / (none) | state identity: absent -> \"Cindy AI\" | env =": 3,
  "installed unreachable cindy / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 24,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "installed unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "installed unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "installed unreachable cindy / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 12,
  "installed unreachable cindy / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 5,
  "installed unreachable cindy / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 24,
  "installed unreachable cindy / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\" | env =": 24,
  "installed unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\" | env =": 3,
  "installed unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent | env =": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env =": 4,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 4,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 1,
  "installed unreachable cprov-custom / (none) | state authenticated: true -> false; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 3,
  "installed unreachable cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env =": 12,
  "installed unreachable cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 12,
  "installed unreachable cprov-custom / (none) | state errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "installed unreachable cprov-custom / gateway-key | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent | env =": 24,
  "installed unreachable cprov-custom / gateway-key | state errorReason: \"no_key\" -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 24,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env =": 4,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 1,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "installed unreachable cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env =": 12,
  "installed unreachable cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "installed unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env =": 5,
  "installed unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "installed unreachable cprov-custom / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"Provider OAuth · Proxy\" -> absent | env =": 48,
  "installed unreachable openai / (none) | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 19,
  "installed unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 3,
  "installed unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"API Key · Cindy AI\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable openai / (none) | state authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env =": 3,
  "installed unreachable openai / (none) | state errorReason: absent -> \"oauth_not_bound\" | env =": 2,
  "installed unreachable openai / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 24,
  "installed unreachable openai / oauth-bearer | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 24,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"system-shared\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"system-shared\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 4,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"unknown\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"unknown\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 1,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 12,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 5,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env =": 4,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 1,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "installed unreachable xd / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env =": 12,
  "installed unreachable xd / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 3,
  "installed unreachable xd / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 12,
  "installed unreachable xd / (none) | state errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 2,
  "installed unreachable xd / (none) | state identity: absent -> \"Cindy AI\" | env =": 3,
  "installed unreachable xd / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\" | env =": 24,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 1,
  "installed unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "installed unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "installed unreachable xd / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\" | env =": 12,
  "installed unreachable xd / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 5,
  "installed unreachable xd / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 24,
  "installed unreachable xd / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\" | env =": 24,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source reachable (none) / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source reachable (none) / (none) | state errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source reachable (none) / (none) | state oauthWritesBlocked: true -> absent | env =": 28,
  "source reachable (none) / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 24,
  "source reachable (none) / gateway-key | state oauthWritesBlocked: true -> absent | env =": 24,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source reachable (none) / oauth-bearer | state oauthWritesBlocked: true -> absent | env =": 19,
  "source reachable (none) / oauth-bearer | state oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 19,
  "source reachable (none) / provider-oauth | state oauthWritesBlocked: true -> absent | env =": 48,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable cindy / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable cindy / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable cindy / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable cindy / (none) | state errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable cindy / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable cindy / gateway-key | state oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "source unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "source unreachable cindy / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable cindy / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 5,
  "source unreachable cindy / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 24,
  "source unreachable cindy / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 4,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 1,
  "source unreachable cprov-custom / (none) | state authenticated: true -> false; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 3,
  "source unreachable cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable cprov-custom / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 12,
  "source unreachable cprov-custom / (none) | state errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "source unreachable cprov-custom / gateway-key | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"API Key · Cindy AI\" -> absent; oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable cprov-custom / gateway-key | state errorReason: \"no_key\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 24,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source unreachable cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable cprov-custom / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "source unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 5,
  "source unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "source unreachable cprov-custom / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env =": 48,
  "source unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"API Key · Cindy AI\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 3,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source unreachable openai / (none) | state authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable openai / (none) | state errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable openai / (none) | state oauthWritesBlocked: true -> absent | env =": 14,
  "source unreachable openai / (none) | state oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 14,
  "source unreachable openai / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 24,
  "source unreachable openai / gateway-key | state oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source unreachable openai / oauth-bearer | state oauthWritesBlocked: true -> absent | env =": 19,
  "source unreachable openai / oauth-bearer | state oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 19,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"instance-isolated\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 2,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; credentialScope: absent -> \"instance-isolated\"; errorReason: absent -> \"token_revoked\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 12,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 10,
  "source unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 10,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable xd / (none) | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable xd / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable xd / (none) | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable xd / (none) | state errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 3,
  "source unreachable xd / gateway-key | state identity: \"API Key · Cindy AI\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable xd / gateway-key | state oauthWritesBlocked: true -> absent | env =": 24,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"instance-isolated\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 1,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"instance-isolated\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 1,
  "source unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 12,
  "source unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 5,
  "source unreachable xd / oauth-bearer | state credentialScope: \"instance-isolated\" -> absent; errorReason: \"token_revoked\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 12,
  "source unreachable xd / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 5,
  "source unreachable xd / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"no_key\"; identity: \"Provider OAuth · Proxy\" -> absent; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 24,
  "source unreachable xd / provider-oauth | state identity: \"Provider OAuth · Proxy\" -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 24,
};
/** Reachable cells where both sides start the task: the final process environment is equal. */
const FINAL_DIFFERENCES: Record<string, number> = {};

/**
 * On Windows the cells whose count differs from KNOWN_DIFFERENCES: the count there (0: none).
 *
 * Both sides keep an existing auth.json on Windows instead of linking it to the system Codex login
 * (desktop auth-adapters.ts, `process.platform === 'win32' && topology.linkType === 'file'`; the
 * Host's codex-system-login.ts has the same branch). The facts that change are therefore only a
 * profile that has its own auth.json (OAuth or API key only) while a system login exists, with no
 * openai binding and no invalidation marker. No new kind of difference appears; each change falls
 * in a category ruled in m1-cp19 (docs/host/codex-auth-adapter-differences.md, "Windows"):
 * - installed, reachable: the API-key-only auth.json without a gateway key (both sides cannot start
 *   the task, the Host refuses first) and the identity labels (M2);
 * - installed, unreachable: the named sources of the M2 provider view;
 * - source: the desktop development build's write lock and its system login reconciliation, which
 *   the Host from source never does.
 * Taken from the Windows CI run of 8bc58bf34e (six groups printed in full) and reproduced by
 * running this test with process.platform set to win32 (all ten groups; the six match CI key by
 * key). A Windows run is the final check.
 */
const WINDOWS_COUNTS: Record<string, number> = {
  // installed, reachable
  "installed reachable (none) / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 4,
  "installed reachable (none) / (none) | state identity: absent -> \"Cindy AI\" | env =": 4,
  // installed, unreachable (M2 provider view)
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable xd / (none) | state identity: absent -> \"Cindy AI\" | env =": 4,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "installed unreachable xd / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 6,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env =": 2,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\" | env =": 4,
  "installed unreachable cindy / (none) | state identity: absent -> \"Cindy AI\" | env =": 4,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\" | env =": 2,
  "installed unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "installed unreachable cindy / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\" | env =": 6,
  "installed unreachable openai / (none) | state = | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 18,
  "installed unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "installed unreachable openai / (none) | state authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\" | env =": 4,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"system-shared\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"system-shared\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"unknown\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> \"oauth\"; credentialScope: absent -> \"unknown\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 2,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "installed unreachable openai / provider-oauth | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; identity: \"Provider OAuth · Proxy\" -> absent | env XDT_CODEX_API_KEY: \"xdt-provider-oauth-placeholder-key\" -> absent": 6,
  "installed unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\" | env =": 4,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "installed unreachable cprov-custom / (none) | state authenticated: true -> false; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 4,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env =": 2,
  "installed unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "installed unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env =": 6,
  "installed unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\" | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  // source (desktop development build only)
  "source reachable (none) / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source reachable (none) / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source reachable (none) / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source reachable (none) / oauth-bearer | state oauthWritesBlocked: true -> absent | env =": 20,
  "source reachable (none) / oauth-bearer | state oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 20,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable xd / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable xd / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "source unreachable xd / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 6,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / (none) | state authenticated: true -> false; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cindy / (none) | state identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"system-shared\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> \"api-key\"; credentialScope: \"unknown\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cindy / oauth-bearer | state authSource: absent -> \"api-key\"; authenticated: false -> true; errorReason: \"no_oauth\" -> absent; identity: absent -> \"Cindy AI\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
  "source unreachable cindy / oauth-bearer | state errorReason: \"no_oauth\" -> \"no_key\"; oauthWritesBlocked: true -> absent | env =": 6,
  "source unreachable openai / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 4,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable openai / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / (none) | state authenticated: true -> false; errorReason: absent -> \"oauth_not_bound\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable openai / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"no_oauth\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable openai / oauth-bearer | state oauthWritesBlocked: true -> absent | env =": 20,
  "source unreachable openai / oauth-bearer | state oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 20,
  "source unreachable cprov-custom / (none) | state authSource: \"api-key\" -> absent; authenticated: true -> false; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 4,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / (none) | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 2,
  "source unreachable cprov-custom / (none) | state authenticated: true -> false; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: absent -> \"xdt-provider-oauth-placeholder-key\"": 4,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"system-shared\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 2,
  "source unreachable cprov-custom / oauth-bearer | state authSource: \"oauth\" -> absent; authenticated: true -> false; credentialScope: \"unknown\" -> absent; errorReason: absent -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 2,
  "source unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env =": 6,
  "source unreachable cprov-custom / oauth-bearer | state errorReason: \"no_oauth\" -> \"not_connected\"; oauthWritesBlocked: true -> absent | env XDT_CODEX_API_KEY: \"sk-xd-gateway\" -> absent": 6,
};

/**
 * The environment, from the same function the desktop uses to link auth.json to the system login,
 * tried once in a temporary directory: the differences depend on the platform's branch, and on
 * Windows the link itself may be refused (no developer mode), which no run has recorded.
 */
async function probeEnvironment(): Promise<{ label: string; table: Record<string, number> | null; diagnostics: number | null }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-link-probe-'));
  let links: boolean;
  let kind: string;
  try {
    const system = path.join(dir, 'system-auth.json');
    const profileAuth = path.join(dir, 'profile-auth.json');
    fs.writeFileSync(system, '{}');
    kind = (await relinkSharedCodexAuth(system, profileAuth)).kind;
    // What the desktop ends with: profile auth.json is a symlink to the system login.
    links = fs.lstatSync(profileAuth, { throwIfNoEntry: false })?.isSymbolicLink() === true
      && path.resolve(dir, fs.readlinkSync(profileAuth)) === system;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const label = `${process.platform}, ${links ? 'links' : 'no links'} (${kind})`;
  if (!links) return { label, table: null, diagnostics: null };
  if (process.platform !== 'win32') return { label, table: KNOWN_DIFFERENCES, diagnostics: 760 };
  const table = { ...KNOWN_DIFFERENCES, ...WINDOWS_COUNTS };
  for (const [key, count] of Object.entries(table)) if (count === 0) delete table[key];
  return { label, table, diagnostics: 720 };
}
const environment = await probeEnvironment();

const ASSEMBLIES = ['installed', 'source'] as const;

/** The recorded differences of one assembly and source: their keys start with this. */
const recorded = (table: Record<string, number>, assembly: string, providerId: string | undefined) =>
  Object.fromEntries(Object.entries(table).filter(([key]) =>
    ['reachable', 'unreachable'].some(reach => key.startsWith(`${assembly} ${reach} ${providerId ?? '(none)'} / `))));

// One test per assembly and source keeps each within the test time budget on slower file systems;
// together they cover every cell. The last test checks the totals once all of them have run.
const totals = { started: 0, groups: 0, cells: 0, diagnostics: 0 };

describe.each(ASSEMBLIES)(`Host and desktop Codex adapters (${environment.label}), %s`, (assembly) => {
  it.each(providers.map(providerId => [providerId ?? '(none)', providerId] as const))(
    'differ only where recorded for source %s, every credential mode and set of facts', async (_label, providerId) => {
    totals.started += 1;
    const observed: Record<string, number> = {};
    const finals: Record<string, number> = {};
    h.packaged = assembly === 'installed';
    for (const f of facts) {
      for (const credentialMode of modes) {
        const opts = { providerId, credentialMode } as AuthAdapterOptions;
        const reachable = CODEX_AUTH_ADAPTER_ENTRY_INPUTS.includes(`${providerId ?? '-'} | ${credentialMode ?? '-'}`);
        const desktop = new DesktopCodexAuthAdapter();
        // The desktop's global Codex skills, rules and plugins preparation (row 25); the Host has none.
        vi.spyOn(desktop, 'ensureGlobalCodexAssets').mockResolvedValue(true);
        const dp = profile(f);
        const d = await read(desktop, dp.codexHome, opts);
        const hp = profile(f);
        const o = await read(createHostCodexAuth(hp.codexHome, assembly, hp.home), hp.codexHome, opts);
        totals.cells += 1;
        if (d.diagnostics) totals.diagnostics += 1;
        expect(o.diagnostics).toBe(false);
        const prefix = `${assembly} ${reachable ? 'reachable' : 'unreachable'} ${providerId ?? '(none)'} / ${credentialMode ?? '(none)'}`;
        const state = fieldDifferences(d.state as Record<string, unknown>, o.state as Record<string, unknown>);
        const env = fieldDifferences(d.env as Record<string, unknown>, o.env as Record<string, unknown>);
        if (state.length || env.length) {
          const key = `${prefix} | state ${state.join('; ') || '='} | env ${env.join('; ') || '='}`;
          observed[key] = (observed[key] ?? 0) + 1;
        }
        // Where a real path reaches both adapters and both let the task start, the process
        // environment it ends with must match.
        const dState = d.state as unknown as AuthState;
        if (!reachable || !dState.authenticated || !(o.state as unknown as AuthState).authenticated || 'thrown' in d.raw || 'thrown' in o.raw) continue;
        const oauthLogin = dState.authSource === 'oauth';
        const final = fieldDifferences(await finalEnv(d.raw, dp.codexHome, opts, oauthLogin), await finalEnv(o.raw, hp.codexHome, opts, oauthLogin));
        if (final.length) {
          const key = `${prefix} | final ${final.join('; ')}`;
          finals[key] = (finals[key] ?? 0) + 1;
        }
      }
    }
    if (environment.table) expect(observed).toEqual(recorded(environment.table, assembly, providerId));
    expect(finals).toEqual(recorded(FINAL_DIFFERENCES, assembly, providerId));
    totals.groups += 1;
  });
});

// On CI the comparison may not be skipped silently: an environment without a recorded table fails
// there. A developer machine skips it visibly instead.
const onCi = Boolean(process.env.CI) && process.env.CI !== 'false';
if (!environment.table) {
  (onCi ? it : it.skip)(`has no recorded table for this environment (${environment.label}): the groups above still check that the Host gives no diagnostics and that final environments are equal`, () => {
    expect.fail(`CI has no recorded table for this environment (${environment.label}); the difference table was not compared`);
  });
}

it('covers every cell, and every recorded difference belongs to exactly one assembly and source', () => {
  for (const table of [KNOWN_DIFFERENCES, WINDOWS_COUNTS, FINAL_DIFFERENCES]) {
    const picked = ASSEMBLIES.flatMap(assembly => providers.flatMap(providerId => Object.keys(recorded(table, assembly, providerId))));
    expect(picked.sort()).toEqual(Object.keys(table).sort());
  }
  const groups = ASSEMBLIES.length * providers.length;
  expect(totals.started, 'run the whole file: only some assembly and source groups ran').toBe(groups);
  expect(totals.groups, 'an assembly and source group above failed; these totals count only when all pass').toBe(groups);
  expect(totals.cells).toBe(ASSEMBLIES.length * facts.length * providers.length * modes.length);
  // The desktop's settings-page credential diagnostics, which the Host does not produce.
  if (environment.diagnostics !== null) expect(totals.diagnostics).toBe(environment.diagnostics);
});
