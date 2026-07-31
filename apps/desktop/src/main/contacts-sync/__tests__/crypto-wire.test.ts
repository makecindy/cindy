import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  decryptContactsSyncBytes,
  encryptContactsSyncBytes,
  generateContactsSyncIdentity,
  publicKeyFromPrivate,
} from '../crypto.js';
import {
  ContactsSyncWireDecoder,
  encodeContactsSyncMessage,
  isContactsSyncWireFrame,
} from '../wire.js';

describe('contacts sync crypto and wire', () => {
  it('两台设备派生同一共享密钥，服务端拿到公钥仍不能解密', () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const context = {
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
      transferId: 'transfer-1',
      totalChunks: 1,
    };
    const encrypted = encryptContactsSyncBytes(
      Buffer.from('private contacts'),
      a.privateKey,
      b.publicKey,
      context,
    );

    expect(
      decryptContactsSyncBytes(encrypted, b.privateKey, a.publicKey, context).toString('utf8'),
    ).toBe('private contacts');
    expect(() =>
      decryptContactsSyncBytes(
        encrypted,
        generateContactsSyncIdentity().privateKey,
        a.publicKey,
        context,
      ),
    ).toThrow();
  });

  it('私钥导出的公钥可用于检测落盘密钥损坏', () => {
    const identity = generateContactsSyncIdentity();
    expect(publicKeyFromPrivate(identity.privateKey)).toBe(identity.publicKey);
  });

  it('大状态会分片、乱序抵达后仍可完整解密', () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const state = { opaqueTestData: randomBytes(600_000).toString('base64') };
    const frames = encodeContactsSyncMessage({
      message: { version: 1, type: 'state', state, requestReply: true },
      ownPrivateKey: a.privateKey,
      ownPublicKey: a.publicKey,
      peerPublicKey: b.publicKey,
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isContactsSyncWireFrame)).toBe(true);

    const decoder = new ContactsSyncWireDecoder();
    let result: ReturnType<typeof decoder.accept> = null;
    for (const frame of [...frames].reverse()) {
      result =
        decoder.accept({
          srcDeviceId: 'device-a',
          dstDeviceId: 'device-b',
          frame,
          ownPrivateKey: b.privateKey,
          expectedPeerPublicKey: a.publicKey,
        }) ?? result;
    }
    expect(result).toEqual({ version: 1, type: 'state', state, requestReply: true });
  });

  it('篡改目标设备、分片元数据或密文都会认证失败', () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const frames = encodeContactsSyncMessage({
      message: { version: 1, type: 'state', state: { contacts: [] } },
      ownPrivateKey: a.privateKey,
      ownPublicKey: a.publicKey,
      peerPublicKey: b.publicKey,
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
    });
    const changed = {
      ...frames[0]!,
      data: Buffer.from('tampered').toString('base64'),
    };
    const decoder = new ContactsSyncWireDecoder();
    expect(() =>
      decoder.accept({
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-c',
        frame: changed,
        ownPrivateKey: b.privateKey,
        expectedPeerPublicKey: a.publicKey,
      }),
    ).toThrow();
  });

  it('拒绝伪造或超界的 wire 帧', () => {
    expect(isContactsSyncWireFrame({ version: 1, type: 'key', publicKey: 'not-a-key' })).toBe(
      false,
    );
    expect(
      isContactsSyncWireFrame({
        version: 1,
        type: 'cipher-chunk',
        senderPublicKey: generateContactsSyncIdentity().publicKey,
        transferId: 'x',
        index: 2,
        total: 2,
        iv: 'x',
        tag: 'x',
        compression: 'gzip',
        data: 'eA==',
      }),
    ).toBe(false);
  });
});
