import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'fixture-a', available: true, pending: false }));
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (value: string) => Buffer.from(`sealed-test-only:${value}`),
    decryptString: (value: Buffer) => {
      if (!value.toString().startsWith('sealed-test-only:')) throw new Error('invalid ciphertext');
      return value.toString().slice('sealed-test-only:'.length);
    },
  },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: state.owner }),
  isAppSessionBoundaryPending: () => state.pending,
  dataOwnerStorageKey: (owner: string) => owner, LOCAL_DATA_OWNER_ID: 'local-v1',
}));

import { getMcpAppRevisionKey, getProviderSecretStore, resolveOwnerScopedSecretStorageKey } from '../providerSecretStore.js';
import { MCP_APP_REVISION_KEY_STORAGE_KEY } from '../../../shared/providerSecrets.js';

function keyPath() {
  return path.join(state.root, 'safe-storage', `${resolveOwnerScopedSecretStorageKey(MCP_APP_REVISION_KEY_STORAGE_KEY)}.enc`);
}
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mcp-app-revision-key-'));
  state.owner = 'fixture-a'; state.available = true; state.pending = false;
  getProviderSecretStore().invalidateCaches();
});
afterEach(() => {
  vi.restoreAllMocks();
  getProviderSecretStore().invalidateCaches();
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('MCP App revision key vault', () => {
  it('persists only encrypted key material and reuses it after process-cache invalidation', () => {
    const key = getMcpAppRevisionKey();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    const bytes = fs.readFileSync(keyPath());
    expect(bytes.toString()).not.toContain(key);
    getProviderSecretStore().invalidateCaches();
    expect(getMcpAppRevisionKey()).toBe(key);
    expect(fs.readFileSync(keyPath())).toEqual(bytes);
  });

  it('isolates owners even before cache invalidation and refuses pending owner boundaries', () => {
    const first = getMcpAppRevisionKey();
    state.owner = 'fixture-b';
    expect(getMcpAppRevisionKey()).not.toBe(first);
    state.owner = 'fixture-a';
    expect(getMcpAppRevisionKey()).toBe(first);
    state.pending = true;
    expect(getMcpAppRevisionKey).toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
    state.pending = false; state.owner = '';
    expect(getMcpAppRevisionKey).toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
  });

  it('retries unavailable secure storage without writing a plaintext or ephemeral substitute', () => {
    state.available = false;
    expect(getMcpAppRevisionKey).toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
    expect(fs.readdirSync(state.root)).toEqual([]);
    state.available = true;
    expect(getMcpAppRevisionKey()).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['invalid-ciphertext', Buffer.from('sealed-test-only:invalid-key').toString('base64')])(
    'preserves unreadable vault data instead of silently replacing it', (bytes) => {
      fs.mkdirSync(path.dirname(keyPath()));
      fs.writeFileSync(keyPath(), bytes);
      expect(getMcpAppRevisionKey).toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
      expect(fs.readFileSync(keyPath(), 'utf8')).toBe(bytes);
    },
  );

  it('adopts a concurrent creator instead of replacing the already persisted key', () => {
    const winner = 'b'.repeat(64);
    const bytes = Buffer.from(`sealed-test-only:${winner}`).toString('base64');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
      write(file, bytes, options);
      write(file, data, options); // Same exclusive-create flags now produce EEXIST.
    });
    expect(getMcpAppRevisionKey()).toBe(winner);
    expect(fs.readFileSync(keyPath(), 'utf8')).toBe(bytes);
  });

  it('clears the key and its cache with the existing explicit secret-clearing boundary', () => {
    const before = getMcpAppRevisionKey();
    getProviderSecretStore().clearAll();
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(getMcpAppRevisionKey()).not.toBe(before);
  });
});
