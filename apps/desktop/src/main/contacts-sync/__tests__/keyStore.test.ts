import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ContactsSyncKeyStore,
  isContactsSyncSecureStorageAvailable,
} from '../keyStore.js';
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

  it('设备私钥只以加密文本落盘，重启后身份稳定', async () => {
    const { store, file } = createStore();
    await store.prepare();
    const identity = store.getIdentity();
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(identity.privateKey);

    store.resetMemory();
    await store.prepare();
    expect(store.getIdentity()).toEqual(identity);
  });

  it('首次绑定对端公钥，之后拒绝同 deviceId 换钥', async () => {
    const { store } = createStore();
    await store.prepare();
    const first = generateContactsSyncIdentity().publicKey;
    const second = generateContactsSyncIdentity().publicKey;
    await expect(store.pinPeerPublicKey('device-b', first)).resolves.toBe(true);
    await expect(store.pinPeerPublicKey('device-b', first)).resolves.toBe(false);
    await expect(store.pinPeerPublicKey('device-b', second)).rejects.toThrow(/identity changed/);
    expect(store.getPeerPublicKey('device-b')).toBe(first);
  });

  it('共享 userData 的实例采用同一设备身份，并在最新磁盘基线上合并 peer pin', async () => {
    const file = createSharedFile();
    const firstStore = createStore({ file }).store;
    const secondStore = createStore({ file }).store;
    await Promise.all([firstStore.prepare(), secondStore.prepare()]);
    const firstIdentity = firstStore.getIdentity();
    expect(secondStore.getIdentity()).toEqual(firstIdentity);

    // 两边此时都持有同一旧缓存；后写者仍须保留前一实例刚写入的 pin。
    const peerB = generateContactsSyncIdentity().publicKey;
    const peerC = generateContactsSyncIdentity().publicKey;
    await Promise.all([
      expect(firstStore.pinPeerPublicKey('device-b', peerB)).resolves.toBe(true),
      expect(secondStore.pinPeerPublicKey('device-c', peerC)).resolves.toBe(true),
    ]);

    const reloaded = createStore({ file }).store;
    await reloaded.prepare();
    expect(reloaded.getIdentity()).toEqual(firstIdentity);
    expect(reloaded.getPeerPublicKey('device-b')).toBe(peerB);
    expect(reloaded.getPeerPublicKey('device-c')).toBe(peerC);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['key.enc']);
  });

  it('旧缓存实例幂等接受其它实例已写入的 pin 后立即刷新本地可见值', async () => {
    const file = createSharedFile();
    const staleStore = createStore({ file }).store;
    const writerStore = createStore({ file }).store;
    await staleStore.prepare();
    await writerStore.prepare();
    const peerKey = generateContactsSyncIdentity().publicKey;

    await expect(writerStore.pinPeerPublicKey('device-b', peerKey)).resolves.toBe(true);
    expect(staleStore.getPeerPublicKey('device-b')).toBeNull();
    await expect(staleStore.pinPeerPublicKey('device-b', peerKey)).resolves.toBe(false);
    expect(staleStore.getPeerPublicKey('device-b')).toBe(peerKey);
  });

  it('密钥读取失败会释放跨进程锁，修复文件后可重新初始化', async () => {
    const file = createSharedFile();
    fs.writeFileSync(file, 'broken ciphertext', 'utf8');
    await expect(createStore({ file }).store.prepare()).rejects.toThrow(/unreadable/);

    fs.unlinkSync(file);
    const repaired = createStore({ file }).store;
    await repaired.prepare();
    const identity = repaired.getIdentity();
    expect(identity.publicKey).toBeTruthy();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('安全存储不可用时 fail closed，不生成明文私钥文件', async () => {
    const { store, file } = createStore({ encryptionAvailable: false });
    await expect(store.prepare()).rejects.toThrow(/secure storage is unavailable/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('Linux basic_text 后端即使声称可加密也 fail closed', () => {
    expect(
      isContactsSyncSecureStorageAvailable({
        platform: 'linux',
        encryptionAvailable: true,
        backend: 'basic_text',
      }),
    ).toBe(false);
    expect(
      isContactsSyncSecureStorageAvailable({
        platform: 'linux',
        encryptionAvailable: true,
        backend: 'gnome_libsecret',
      }),
    ).toBe(true);
    expect(
      isContactsSyncSecureStorageAvailable({
        platform: 'darwin',
        encryptionAvailable: true,
        backend: 'basic_text',
      }),
    ).toBe(true);
  });

  it('等待另一实例的锁时不阻塞事件循环', async () => {
    const file = createSharedFile();
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const store = createStore({ file }).store;
    let timerFired = false;

    const preparing = store.prepare();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        fs.unlinkSync(`${file}.lock`);
        resolve();
      }, 20);
    });

    expect(timerFired).toBe(true);
    await preparing;
    expect(store.getIdentity().publicKey).toBeTruthy();
  });

  it('重置会作废仍在等待锁的旧操作', async () => {
    const file = createSharedFile();
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const store = createStore({ file }).store;

    const preparing = store.prepare();
    store.resetMemory();
    fs.unlinkSync(`${file}.lock`);

    await expect(preparing).rejects.toThrow(/invalidated/);
    expect(() => store.getIdentity()).toThrow(/not prepared/);
    expect(store.getPeerPublicKey('device-b')).toBeNull();
  });

  it('peer pin 达到上限后拒绝新设备且不写出不可读文件', async () => {
    const { store, file } = createStore();
    await store.prepare();
    const identity = store.getIdentity();
    const peerKey = generateContactsSyncIdentity().publicKey;
    const peers = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`device-${index}`, peerKey]),
    );
    const plaintext = JSON.stringify({ version: 1, ...identity, peers });
    fs.writeFileSync(file, Buffer.from(`encrypted:${plaintext}`, 'utf8').toString('base64'));
    store.resetMemory();
    await store.prepare();
    const before = fs.readFileSync(file, 'utf8');

    await expect(
      store.pinPeerPublicKey('device-over-limit', generateContactsSyncIdentity().publicKey),
    ).rejects.toThrow(/peer limit exceeded/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);

    store.resetMemory();
    await store.prepare();
    expect(store.getIdentity()).toEqual(identity);
    expect(store.getPeerPublicKey('device-999')).toBe(peerKey);
  });
});
