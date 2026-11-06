import { describe, expect, it } from 'vitest';

import {
  decryptDeviceSyncBytes,
  encryptDeviceSyncBytes,
  generateDeviceSyncIdentity,
  publicKeyFromPrivate,
} from '../crypto.js';

describe('device sync crypto', () => {
  it('两台设备派生同一共享密钥，服务端拿到公钥仍不能解密', () => {
    const a = generateDeviceSyncIdentity();
    const b = generateDeviceSyncIdentity();
    const context = {
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
      transferId: 'transfer-1',
      totalChunks: 1,
    };
    const encrypted = encryptDeviceSyncBytes(Buffer.from('private data'), a.privateKey, b.publicKey, context);

    expect(decryptDeviceSyncBytes(encrypted, b.privateKey, a.publicKey, context).toString('utf8')).toBe(
      'private data',
    );
    expect(() =>
      decryptDeviceSyncBytes(encrypted, generateDeviceSyncIdentity().privateKey, a.publicKey, context),
    ).toThrow();
    expect(() =>
      decryptDeviceSyncBytes(encrypted, b.privateKey, a.publicKey, { ...context, dstDeviceId: 'device-c' }),
    ).toThrow();
  });

  it('私钥导出的公钥可用于检测落盘密钥损坏', () => {
    const identity = generateDeviceSyncIdentity();
    expect(publicKeyFromPrivate(identity.privateKey)).toBe(identity.publicKey);
  });
});
