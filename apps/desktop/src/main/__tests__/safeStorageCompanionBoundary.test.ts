import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companionEnvironmentKey } from '../bot-import/environment.js';
import { isRendererAccessibleSafeStorageKey, isCustomProviderRuntimeKeyStorageKey,
  customProviderSecretStorageKey, customMcpSecretStorageKey, providerOAuthStorageKey,
  MCP_APP_REVISION_KEY_STORAGE_KEY } from '../../shared/providerSecrets.js';

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

function bridge() {
  const handlers = new Map<string, Handler>();
  const log = { error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  const readXdKey = vi.fn<(id: string) => string | null>(() => null);
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } },
    isRendererAccessibleSafeStorageKey, isCustomProviderRuntimeKeyStorageKey,
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

  it.each(['api_key', customProviderSecretStorageKey('fixture-provider', 'codex'),
    customMcpSecretStorageKey('fixture-mcp'), providerOAuthStorageKey('fixture-oauth')])('preserves ordinary Renderer credential operations for %s', async key => {
    const api = bridge();
    expect(await api.invoke('store', key, 'fixture-ordinary-token')).toBe(true);
    expect(await api.invoke('read', key)).toBe('fixture-ordinary-token');
    expect(await api.invoke('remove', key)).toEqual({ success: true });
    expect(await api.invoke('read', key)).toBeNull();
    expect(api.safeStorage.encryptString).toHaveBeenCalledTimes(1);
    expect(api.safeStorage.decryptString).toHaveBeenCalledTimes(1);
    if (key !== 'api_key') {
      expect(api.activeOwnerScopeKey).not.toHaveBeenCalled();
      expect(api.getProviderSecretStore).not.toHaveBeenCalled();
      expect(api.noteCindyGatewayKeyReplaced).not.toHaveBeenCalled();
    }
  });

  // Regression for #9159: the real IPC registration needs the new gateway-only
  // dependencies. Unit tier, using the existing encrypted-file fixture; no owner
  // or gateway key lookup may affect unrelated Renderer credential operations.
  it.each([false, true])('records a saved gateway replacement only for the same owner (changed=%s)', async changed => {
    const api = bridge();
    api.readXdKey.mockReturnValue('fixture-old-token');
    api.activeOwnerScopeKey.mockReturnValueOnce('fixture-owner')
      .mockReturnValue(changed ? 'fixture-other-owner' : 'fixture-owner');
    expect(await api.invoke('store', 'api_key', 'fixture-new-token')).toBe(true);
    expect(await api.invoke('read', 'api_key')).toBe('fixture-new-token');
    expect(api.readXdKey).toHaveBeenCalledExactlyOnceWith('xd');
    if (changed) expect(api.noteCindyGatewayKeyReplaced).not.toHaveBeenCalled();
    else expect(api.noteCindyGatewayKeyReplaced).toHaveBeenCalledExactlyOnceWith('fixture-old-token', 'fixture-new-token');
  });

  it('does not record a gateway replacement when the encrypted write fails', async () => {
    const api = bridge();
    api.readXdKey.mockReturnValue('fixture-old-token');
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('fixture write failed'); });
    try {
      expect(await api.invoke('store', 'api_key', 'fixture-new-token')).toBe(false);
      expect(api.noteCindyGatewayKeyReplaced).not.toHaveBeenCalled();
      expect(api.noteManualXdKeySaved).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
