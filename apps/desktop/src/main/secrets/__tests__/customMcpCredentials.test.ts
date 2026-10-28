/** 测试价值：unit；真实临时文件和假加密器覆盖密文提交、不可读与账号隔离，不访问系统钥匙串。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '', owner: 'owner-a', available: true, corrupt: false }));
const key = randomBytes(32);
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString: (data: Buffer) => {
      if (state.corrupt) throw new Error('fake cipher failure');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  },
}));
vi.mock('../providerSecretStore.js', () => ({
  resolveOwnerScopedSecretStorageKey: (value: string) =>
    state.owner ? state.owner + '_' + value : null,
}));
import {
  readLegacyMcpToken,
  readMcpCredentials,
  writeMcpCredentials,
} from '../customMcpCredentials.js';
import { isRendererAccessibleSafeStorageKey } from '../../../shared/providerSecrets.js';
const server = { id: 'custom_test', url: 'https://example.test/mcp', transport: 'http' };
const credentials = {
  token: 'test-invalid-token',
  headers: { 'X-Test-Key': 'test-invalid-header' },
};
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mcp-secret-'));
  state.owner = 'owner-a';
  state.available = true;
  state.corrupt = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(state.root, { recursive: true, force: true });
});
function fileFor(ref: string) {
  return path.join(state.root, 'safe-storage', state.owner + '_' + ref + '.enc');
}
describe('Main-only MCP credential files', () => {
  it('roundtrips an immutable encrypted bundle bound to its server and endpoint', () => {
    const ref = writeMcpCredentials(server, credentials)!;
    expect(readMcpCredentials(server, ref)).toEqual(credentials);
    const encoded = fs.readFileSync(fileFor(ref));
    for (const data of [encoded.toString(), Buffer.from(encoded.toString(), 'base64').toString()]) {
      expect(data).not.toContain(credentials.token);
      expect(data).not.toContain(credentials.headers['X-Test-Key']);
    }
    if (process.platform !== 'win32') expect(fs.statSync(fileFor(ref)).mode & 0o777).toBe(0o600);
    expect(writeMcpCredentials(server, credentials)).not.toBe(ref);
    expect(() => readMcpCredentials({ ...server, id: 'other' }, ref)).toThrow('SECRET_UNREADABLE');
    expect(() => readMcpCredentials({ ...server, url: 'https://other.test/mcp' }, ref)).toThrow(
      'SECRET_UNREADABLE',
    );
    state.owner = 'owner-b';
    expect(() => readMcpCredentials(server, ref)).toThrow('SECRET_UNREADABLE');
  });
  it('distinguishes absence from missing or unreadable referenced credentials', () => {
    expect(readLegacyMcpToken('custom_missing')).toBeNull();
    expect(readMcpCredentials(server, null)).toEqual({ token: '', headers: {} });
    const ref = writeMcpCredentials(server, credentials)!;
    state.corrupt = true;
    expect(() => readMcpCredentials(server, ref)).toThrow('SECRET_UNREADABLE');
    state.corrupt = false;
    fs.unlinkSync(fileFor(ref));
    expect(() => readMcpCredentials(server, ref)).toThrow('SECRET_UNREADABLE');
    expect(() => readMcpCredentials(server, '../../outside')).toThrow('SECRET_UNREADABLE');
  });
  it('leaves the old generation intact and removes temp files if atomic rename fails', () => {
    const ref = writeMcpCredentials(server, credentials)!;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('fake rename failure');
    });
    expect(() =>
      writeMcpCredentials(server, { ...credentials, token: 'test-replacement' }),
    ).toThrow('SECRET_STORE_UNAVAILABLE');
    expect(readMcpCredentials(server, ref)).toEqual(credentials);
    expect(fs.readdirSync(path.dirname(fileFor(ref)))).toEqual([path.basename(fileFor(ref))]);
  });
  it('fails closed without encryption or an owner and reserves all secret prefixes', () => {
    state.available = false;
    expect(() => writeMcpCredentials(server, credentials)).toThrow('SECRET_STORE_UNAVAILABLE');
    state.available = true;
    state.owner = '';
    expect(() => writeMcpCredentials(server, credentials)).toThrow('OWNER_CHANGED');
    for (const name of [
      'mcp_token_custom_test',
      'MCP_TOKEN_future',
      'mcp_bundle_future',
      'MCP_BUNDLE_T_a',
    ])
      expect(isRendererAccessibleSafeStorageKey(name)).toBe(false);
  });
});
