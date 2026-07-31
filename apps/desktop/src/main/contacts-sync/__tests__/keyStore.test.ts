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

  function createStore(options?: { encryptionAvailable?: boolean; file?: string }) {
    const dir = options?.file
      ? path.dirname(options.file)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-contacts-sync-key-'));
    if (!options?.file) tempDirs.push(dir);
    const file = options?.file ?? path.join(dir, 'key.enc');
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

  function createSharedFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-contacts-sync-key-shared-'));
    tempDirs.push(dir);
    return path.join(dir, 'key.enc');
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

  it('共享 userData 的实例采用同一设备身份，并在最新磁盘基线上合并 peer pin', () => {
    const file = createSharedFile();
    const firstStore = createStore({ file }).store;
    const secondStore = createStore({ file }).store;
    const firstIdentity = firstStore.getIdentity();
    expect(secondStore.getIdentity()).toEqual(firstIdentity);

    // 两边此时都持有同一旧缓存；后写者仍须保留前一实例刚写入的 pin。
    const peerB = generateContactsSyncIdentity().publicKey;
    const peerC = generateContactsSyncIdentity().publicKey;
    expect(firstStore.pinPeerPublicKey('device-b', peerB)).toBe(true);
    expect(secondStore.pinPeerPublicKey('device-c', peerC)).toBe(true);

    const reloaded = createStore({ file }).store;
    expect(reloaded.getIdentity()).toEqual(firstIdentity);
    expect(reloaded.getPeerPublicKey('device-b')).toBe(peerB);
    expect(reloaded.getPeerPublicKey('device-c')).toBe(peerC);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['key.enc', 'key.enc.lock.sqlite']);
  });

  it('旧缓存实例幂等接受其它实例已写入的 pin 后立即刷新本地可见值', () => {
    const file = createSharedFile();
    const staleStore = createStore({ file }).store;
    const writerStore = createStore({ file }).store;
    staleStore.getIdentity();
    writerStore.getIdentity();
    const peerKey = generateContactsSyncIdentity().publicKey;

    expect(writerStore.pinPeerPublicKey('device-b', peerKey)).toBe(true);
    expect(staleStore.getPeerPublicKey('device-b')).toBeNull();
    expect(staleStore.pinPeerPublicKey('device-b', peerKey)).toBe(false);
    expect(staleStore.getPeerPublicKey('device-b')).toBe(peerKey);
  });

  it('密钥读取失败会回滚并释放跨进程锁，修复文件后可重新初始化', () => {
    const file = createSharedFile();
    fs.writeFileSync(file, 'broken ciphertext', 'utf8');
    expect(() => createStore({ file }).store.getIdentity()).toThrow(/unreadable/);

    fs.unlinkSync(file);
    const identity = createStore({ file }).store.getIdentity();
    expect(identity.publicKey).toBeTruthy();
    expect(fs.existsSync(`${file}.lock.sqlite`)).toBe(true);
  });

  it('安全存储不可用时 fail closed，不生成明文私钥文件', () => {
    const { store, file } = createStore({ encryptionAvailable: false });
    expect(() => store.getIdentity()).toThrow(/secure storage is unavailable/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
