import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContactsSyncKeyStore } from '../keyStore.js';
import { generateContactsSyncIdentity } from '../crypto.js';

describe('contacts sync key store', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function createStore(options?: { encryptionAvailable?: boolean }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-contacts-sync-key-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'key.enc');
    const store = new ContactsSyncKeyStore({
      filePath: () => file,
      isEncryptionAvailable: () => options?.encryptionAvailable ?? true,
      encrypt: (text) => Buffer.from(`encrypted:${text}`, 'utf8'),
      decrypt: (bytes) => {
        const value = bytes.toString('utf8');
        if (!value.startsWith('encrypted:')) throw new Error('bad ciphertext');
        return value.slice('encrypted:'.length);
      },
    });
    return { store, file };
  }

  it('设备私钥只以加密文本落盘，重启后身份稳定', () => {
    const { store, file } = createStore();
    const identity = store.getIdentity();
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(identity.privateKey);

    store.resetMemory();
    expect(store.getIdentity()).toEqual(identity);
  });

  it('首次绑定对端公钥，之后拒绝同 deviceId 换钥', () => {
    const { store } = createStore();
    const first = generateContactsSyncIdentity().publicKey;
    const second = generateContactsSyncIdentity().publicKey;
    expect(store.pinPeerPublicKey('device-b', first)).toBe(true);
    expect(store.pinPeerPublicKey('device-b', first)).toBe(false);
    expect(() => store.pinPeerPublicKey('device-b', second)).toThrow(/identity changed/);
    expect(store.getPeerPublicKey('device-b')).toBe(first);
  });

  it('安全存储不可用时 fail closed，不生成明文私钥文件', () => {
    const { store, file } = createStore({ encryptionAvailable: false });
    expect(() => store.getIdentity()).toThrow(/secure storage is unavailable/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
