import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companionEnvironmentKey } from '../bot-import/environment.js';
import { readCustomMcpToken } from '../../renderer/lib/customMcpServers.js';
import { readCustomProviderKey } from '../../renderer/lib/customProviders.js';
import { isRendererSafeStorageOperationAllowed, isCustomProviderRuntimeKeyStorageKey,
  customProviderHeaderStorageKey, customProviderSecretStorageKey, customMcpSecretStorageKey,
  providerOAuthStorageKey, ghostSecretStorageKey, ghostSecretHintStorageKey, providerSecretStorageKey,
  DYNAMIC_SECRET_PREFIXES, GHOST_QUARANTINED_OAUTH_PREFIX, PROVIDER_SECRET_IDS,
  MCP_APP_REVISION_KEY_STORAGE_KEY, PI_PROXY_DERIVATION_KEY_STORAGE_KEY,
  PROVIDER_SECRET_OWNER_STORAGE_KEY, REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY,
  type RendererSafeStorageOperation } from '../../shared/providerSecrets.js';

// Execute the production registrations with fake Electron dependencies, without
// launching Desktop or reproducing the IPC handlers in a test implementation.
const source = fs.readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
const start = source.indexOf('// safeStorage IPC handlers');
const end = source.indexOf('const builtinApiKeyLog =', start);
if (start < 0 || end <= start) throw new Error('safeStorage registration block not found');
const compiled = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
type Handler = (event: object, key: string, value?: string) => Promise<unknown>;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-companion-bridge-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function bridge({ cloud = false }: { cloud?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const log = { error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  const readXdKey = vi.fn<(id: string) => string | null>(() => null);
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
    isRendererSafeStorageOperationAllowed, isCustomProviderRuntimeKeyStorageKey,
    assertTrustedAppRendererEvent: vi.fn(),
    resolveOwnerScopedSecretStorageKey: vi.fn((key: string) => `owner_fixture_${key}`),
    app: { getPath: () => root }, fs, path, Buffer,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`fixture:${value}`)),
      decryptString: vi.fn((value: Buffer) => value.toString().slice('fixture:'.length)),
    },
    getCodexProxyAuthInjectionState: () => 'oauth-bearer',
    activeOwnerScopeKey: vi.fn(() => 'fixture-owner'),
    getProviderSecretStore: vi.fn(() => ({ get: readXdKey })),
    noteCindyGatewayKeyReplaced: vi.fn(),
    noteManualXdKeySaved: vi.fn(), noteManualXdKeyRemoved: vi.fn(),
    getGhostSetupChangeBus: () => ({ emitAll: vi.fn() }),
    BrowserWindow: { getAllWindows: () => [] },
    safeStorageReadLog: log, console: log,
    isIpcError: () => false,
    throwIpcError: (_code: string, message: string) => { throw new Error(message); },
    // Cloud management registers the same handler; only its closed call reaches it.
    cloudManagementProviderRegistry: (registry: unknown) => registry,
    isCloudManagementInvocation: () => cloud,
    providerSecretStorageKey,
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  expect([...handlers.keys()]).toEqual(['safe-storage-store', 'safe-storage-read', 'safe-storage-remove']);
  return { ...deps, readXdKey, invoke: (operation: string, key: string, value?: string) => handlers.get(`safe-storage-${operation}`)!({}, key, value) };
}

describe('generic safeStorage companion boundary', () => {
  it.each([
    ['read', null], ['store', false], ['remove', { success: false, error: 'invalid key' }],
  ])('denies %s before resolving a path, touching the vault or changing stored data', async (operation, result) => {
    const api = bridge();
    const key = companionEnvironmentKey('fixture-companion');
    const directory = path.join(root, 'safe-storage');
    fs.mkdirSync(directory);
    const file = path.join(directory, `owner_fixture_${key}.enc`);
    // Legacy data remains readable to Main and must not escape via generic IPC;
    // writes/deletes must not corrupt either old or chunked environment files.
    const original = Buffer.from('fixture:{"env":{"KEY":"fixture-private-token"}}').toString('base64');
    fs.writeFileSync(file, original);
    for (const variant of [key, key.toUpperCase(), 'bot_environment_future_format', 'bot_environment_',
      MCP_APP_REVISION_KEY_STORAGE_KEY, MCP_APP_REVISION_KEY_STORAGE_KEY.toUpperCase()]) {
      expect(await api.invoke(String(operation), variant, 'replacement')).toEqual(result);
    }
    expect(api.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(6);
    expect(api.resolveOwnerScopedSecretStorageKey).not.toHaveBeenCalled();
    expect(api.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(api.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(api.safeStorage.encryptString).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
  });

  // 测试价值
  // - 生产入口与可观察结果：bootstrap-electron 的 safe-storage-{read,store,remove} 注册块原文；每个键族的
  //   读、写、删各一条用例，断言 Renderer 拿到的返回值，以及磁盘上的 .enc 文件是否被写入或删除。
  // - 规则依据：electron-security-and-process-boundaries §1（preload 是最小权限桥）。Renderer 只用
  //   三类键：网关 api_key（useApiKey、makerChatStore 读，useApiKey 删）、mcp_token_（customMcpServers
  //   读取已存 token）、自定义供应商 runtime key（customProviders 只读）。
  // - 现有覆盖缺口：没有用例逐个键族、逐个操作钉住通用 IPC 的访问范围。
  // - 最小失败输入：表外的某个键或操作被放行；或者表内登记的操作被误拒。
  // - tier：unit，进程内 fake + 临时目录。
  type Access = Readonly<Record<RendererSafeStorageOperation, boolean>>;
  const MAIN_ONLY: Access = { read: false, store: false, remove: false };
  // 每个由 Main 管理的键族都必须在此登记 Renderer 能做的操作。新增前缀或固定键名而不登记，
  // 完整性用例失败；生产里未登记的键默认拒绝。
  const RENDERER_ACCESS: Record<string, { sample: string; access: Access }> = {
    ghost_alias_migration_: { sample: 'ghost_alias_migration_fixture', access: MAIN_ONLY },
    bot_environment_: { sample: companionEnvironmentKey('fixture-companion'), access: MAIN_ONLY },
    byok_cache_: { sample: `byok_cache_${'a'.repeat(64)}`, access: MAIN_ONLY },
    mcp_token_: { sample: customMcpSecretStorageKey('fixture-mcp'), access: { read: true, store: true, remove: true } },
    provider_headers_: { sample: customProviderHeaderStorageKey('fixture-provider', 'pi'), access: MAIN_ONLY },
    provider_key_: { sample: customProviderSecretStorageKey('fixture-provider', 'codex'), access: { read: true, store: false, remove: false } },
    provider_oauth_: { sample: providerOAuthStorageKey('fixture-oauth'), access: MAIN_ONLY },
    ghost_secret_: { sample: ghostSecretStorageKey('fixture-plugin', 'token'), access: MAIN_ONLY },
    ghost_hint_: { sample: ghostSecretHintStorageKey('fixture-plugin', 'token'), access: MAIN_ONLY },
    ghost_quarantined_oauth_: { sample: `${GHOST_QUARANTINED_OAUTH_PREFIX}${'b'.repeat(32)}`, access: MAIN_ONLY },
    api_key: { sample: 'api_key', access: { read: true, store: false, remove: true } },
    mivo_api_key: { sample: 'mivo_api_key', access: MAIN_ONLY },
    brave_search_api_key: { sample: 'brave_search_api_key', access: MAIN_ONLY },
    tavily_api_key: { sample: 'tavily_api_key', access: MAIN_ONLY },
    provider_key_xai: { sample: 'provider_key_xai', access: MAIN_ONLY },
    voice_input_asr_api_key: { sample: 'voice_input_asr_api_key', access: MAIN_ONLY },
    provider_key_gemini: { sample: 'provider_key_gemini', access: MAIN_ONLY },
    provider_key_openai_images: { sample: 'provider_key_openai_images', access: MAIN_ONLY },
    remote_mcp_bridge_token: { sample: 'remote_mcp_bridge_token', access: MAIN_ONLY },
    pi_proxy_derivation_key: { sample: 'pi_proxy_derivation_key', access: MAIN_ONLY },
    mcp_app_revision_key: { sample: 'mcp_app_revision_key', access: MAIN_ONLY },
    provider_secret_owner: { sample: 'provider_secret_owner', access: MAIN_ONLY },
  };
  const FIXED_KEYS = [...PROVIDER_SECRET_IDS.map(providerSecretStorageKey), REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY,
    PI_PROXY_DERIVATION_KEY_STORAGE_KEY, MCP_APP_REVISION_KEY_STORAGE_KEY, PROVIDER_SECRET_OWNER_STORAGE_KEY];

  it('registers every Main-managed key family in the Renderer access table', () => {
    expect(Object.keys(RENDERER_ACCESS).sort()).toEqual([...new Set([...DYNAMIC_SECRET_PREFIXES, ...FIXED_KEYS])].sort());
    for (const prefix of DYNAMIC_SECRET_PREFIXES) expect(RENDERER_ACCESS[prefix].sample.startsWith(prefix)).toBe(true);
    for (const key of FIXED_KEYS) expect(RENDERER_ACCESS[key].sample).toBe(key);
  });

  // Main 自己写在 safe-storage 下、不属于上面键族的登录与集成 token（authSessionHint.ts:18-22、
  // github/gitlab/atlassianAccountsMigration 的旧文件名）。Renderer 没有调用点，一律拒绝。
  const MAIN_LOGIN_AND_INTEGRATION_TOKENS = ['cindy_auth_session_v1', 'cindy_auth_refresh_token',
    'cindy_auth_account_refresh_token', 'refresh_token', 'github_token', 'gitlab_token', 'jira_refresh_token'];
  const families: Array<readonly [string, string, Access]> = [
    ...Object.entries(RENDERER_ACCESS).map(([family, { sample, access }]) => [family, sample, access] as const),
    ...MAIN_LOGIN_AND_INTEGRATION_TOKENS.map((key) => [`main token ${key}`, key, MAIN_ONLY] as const),
    // 未登记的前缀与大小写变体一律拒绝（大小写不敏感的文件系统上会落到同一文件）。
    ['unregistered prefix', 'future_secret_fixture', MAIN_ONLY] as const,
    ['bare mcp_token_ prefix', 'mcp_token_', MAIN_ONLY] as const,
    ...Object.entries(RENDERER_ACCESS).map(([family, { sample }]) => [`${family} upper-case`, sample.toUpperCase(), MAIN_ONLY] as const),
  ];
  const OPERATIONS: readonly RendererSafeStorageOperation[] = ['read', 'store', 'remove'];
  const rows = families.flatMap(([family, key, access]) =>
    OPERATIONS.map((operation) => [family, operation, access[operation] ? 'allowed' : 'denied', key] as const));

  const seeded = Buffer.from('fixture:fixture-seeded-value').toString('base64');
  it.each(rows)('%s: Renderer %s is %s', async (_family, operation, verdict, key) => {
    const api = bridge();
    const directory = path.join(root, 'safe-storage');
    fs.mkdirSync(directory);
    const file = path.join(directory, `owner_fixture_${key}.enc`);
    fs.writeFileSync(file, seeded);
    const allowed = verdict === 'allowed';

    if (operation === 'read') {
      expect(await api.invoke('read', key)).toBe(allowed ? 'fixture-seeded-value' : null);
      expect(fs.readFileSync(file, 'utf8')).toBe(seeded);
    } else if (operation === 'store') {
      expect(await api.invoke('store', key, 'fixture-replacement')).toBe(allowed);
      expect(fs.readFileSync(file, 'utf8')).toBe(allowed ? Buffer.from('fixture:fixture-replacement').toString('base64') : seeded);
    } else {
      expect(await api.invoke('remove', key)).toEqual(allowed ? { success: true } : { success: false, error: 'invalid key' });
      expect(fs.existsSync(file)).toBe(!allowed);
      expect(api.noteManualXdKeyRemoved).toHaveBeenCalledTimes(allowed && key === 'api_key' ? 1 : 0);
    }
    if (!allowed) {
      expect(api.resolveOwnerScopedSecretStorageKey).not.toHaveBeenCalled();
      expect(api.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
      expect(api.safeStorage.decryptString).not.toHaveBeenCalled();
      expect(api.safeStorage.encryptString).not.toHaveBeenCalled();
    }
  });
});

// 测试价值
// - 生产入口与可观察结果：Renderer 的真实调用函数（customMcpServers、customProviders.readCustomProviderKey）
//   经 window.electronAPI 进入 bootstrap-electron 注册块原文，断言函数返回值与磁盘 .enc 内容。
// - 规则依据：白名单收紧后普通桌面现有功能不得受影响（编辑自定义供应商时回显 key、回显已存 MCP 令牌）。
// - 现有覆盖缺口：上面的表驱动用例只证明键名被放行，不证明 Renderer 实际拼出的键名落在放行范围内。
// - 最小失败输入：Renderer 拼出的键名与白名单匹配不一致（如供应商 id 经 storedCustomProviderId 改写）。
// - tier：unit，进程内 fake + 临时目录。
describe('ordinary Renderer credential flows through the real safeStorage handlers', () => {
  function wireRenderer() {
    const api = bridge();
    vi.stubGlobal('window', { electronAPI: {
      safeStorageRead: (key: string) => api.invoke('read', key),
    } });
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('echoes a saved custom provider key while editing (read only)', async () => {
    wireRenderer();
    const key = customProviderSecretStorageKey('fixture-provider', 'codex');
    fs.mkdirSync(path.join(root, 'safe-storage'));
    fs.writeFileSync(path.join(root, 'safe-storage', `owner_fixture_${key}.enc`), Buffer.from('fixture:fixture-provider-key').toString('base64'));
    expect(await readCustomProviderKey('fixture-provider', 'codex')).toBe('fixture-provider-key');
    expect(await readCustomProviderKey('fixture-provider', 'claude-code')).toBeNull();
  });

  it('reads the stored MCP token for the server being edited', async () => {
    wireRenderer();
    const key = customMcpSecretStorageKey('fixture-mcp');
    fs.mkdirSync(path.join(root, 'safe-storage'));
    fs.writeFileSync(path.join(root, 'safe-storage', `owner_fixture_${key}.enc`), Buffer.from('fixture:fixture-token').toString('base64'));
    expect(await readCustomMcpToken('fixture-mcp')).toBe('fixture-token');
    expect(await readCustomMcpToken('other-mcp')).toBeNull();
  });
});

describe('cloud providers page removal', () => {
  it('removes only the Cindy AI key through cloud management', async () => {
    const api = bridge({ cloud: true });
    expect(await api.invoke('remove', customProviderSecretStorageKey('fixture-provider', 'codex'))).toEqual({
      success: false, error: 'invalid key',
    });
    expect(api.assertTrustedAppRendererEvent).not.toHaveBeenCalled();
    expect(api.resolveOwnerScopedSecretStorageKey).not.toHaveBeenCalled();
    expect(await api.invoke('remove', 'api_key')).toEqual({ success: true });
    expect(api.noteManualXdKeyRemoved).toHaveBeenCalledOnce();
  });
});
