import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileSecretStore,
  MemorySecretStore,
  ResilientSecretStore,
  type HeadlessSecretStore,
} from './secret-store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function vault(): { store: EncryptedFileSecretStore; vaultFile: string; keyFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-vault-'));
  dirs.push(dir);
  const vaultFile = path.join(dir, 'credentials', 'vault.v1.json');
  const keyFile = path.join(dir, 'credentials', 'vault.key');
  return { store: new EncryptedFileSecretStore(vaultFile, keyFile), vaultFile, keyFile };
}

describe('EncryptedFileSecretStore', () => {
  it('persists encrypted values across daemon instances without writing plaintext', async () => {
    const subject = vault();
    await subject.store.set('cindy_account_refresh', 'refresh-token-not-in-config');

    expect(fs.readFileSync(subject.vaultFile, 'utf8')).not.toContain('refresh-token-not-in-config');
    expect(fs.statSync(subject.vaultFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(subject.keyFile).mode & 0o777).toBe(0o400);
    await expect(new EncryptedFileSecretStore(subject.vaultFile, subject.keyFile).get('cindy_account_refresh'))
      .resolves.toBe('refresh-token-not-in-config');
  });

  it('binds ciphertext to its credential reference and rejects tampering', async () => {
    const subject = vault();
    await subject.store.set('provider_one', 'token');
    const document = JSON.parse(fs.readFileSync(subject.vaultFile, 'utf8')) as { entries: Record<string, unknown> };
    document.entries.provider_two = document.entries.provider_one;
    fs.writeFileSync(subject.vaultFile, JSON.stringify(document), { mode: 0o600 });
    await expect(subject.store.get('provider_two')).rejects.toThrow('cannot be decrypted');
  });

  it('uses the encrypted server vault when Secret Service is unavailable', async () => {
    const subject = vault();
    const unavailable: HeadlessSecretStore = {
      get: async () => { throw new Error('Secret Service unavailable'); },
      set: async () => { throw new Error('Secret Service unavailable'); },
      delete: async () => { throw new Error('Secret Service unavailable'); },
    };
    const store = new ResilientSecretStore(unavailable, subject.store);
    await store.set('cindy_account_refresh', 'durable-refresh');
    await expect(store.get('cindy_account_refresh')).resolves.toBe('durable-refresh');
  });

  it('keeps Secret Service as the preferred store when it is available', async () => {
    const primary = new MemorySecretStore();
    const subject = vault();
    const store = new ResilientSecretStore(primary, subject.store);
    await store.set('cindy_account_refresh', 'primary-refresh');
    await expect(primary.get('cindy_account_refresh')).resolves.toBe('primary-refresh');
    await expect(subject.store.get('cindy_account_refresh')).resolves.toBeNull();
  });
});
