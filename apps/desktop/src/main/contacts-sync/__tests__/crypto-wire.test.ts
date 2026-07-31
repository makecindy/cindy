import { describe, expect, it, vi } from 'vitest';
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
import {
  CONTACTS_SYNC_MAX_DECOMPRESSED_BYTES,
  encodeContactsSyncJsonInProcess,
  inProcessContactsSyncCodec,
} from '../contactsSyncCodec.js';

describe('contacts sync crypto and wire', () => {
  it('发送端在压缩前拒绝超过接收端明文上限的状态', () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const oversized = {
      byteLength: CONTACTS_SYNC_MAX_DECOMPRESSED_BYTES + 1,
    } as Uint8Array;
    expect(() =>
      encodeContactsSyncJsonInProcess(oversized, {
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      }),
    ).toThrow(/decompressed bytes/);
  });

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

  it('大状态会分片、乱序抵达后仍可完整解密', async () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const state = { opaqueTestData: randomBytes(600_000).toString('base64') };
    const frames = await encodeContactsSyncMessage(
      {
        message: { version: 1, type: 'state', state, requestReply: true },
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(isContactsSyncWireFrame)).toBe(true);

    const decoder = new ContactsSyncWireDecoder(inProcessContactsSyncCodec);
    let result: Awaited<ReturnType<typeof decoder.accept>> = null;
    for (const frame of [...frames].reverse()) {
      result =
        (await decoder.accept({
          srcDeviceId: 'device-a',
          dstDeviceId: 'device-b',
          frame,
          ownPrivateKey: b.privateKey,
          expectedPeerPublicKey: a.publicKey,
        })) ?? result;
    }
    expect(result).toEqual({ version: 1, type: 'state', state, requestReply: true });
  });

  it('篡改目标设备、分片元数据或密文都会认证失败', async () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const frames = await encodeContactsSyncMessage(
      {
        message: { version: 1, type: 'state', state: { contacts: [] } },
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    const changed = {
      ...frames[0]!,
      data: Buffer.from('tampered').toString('base64'),
    };
    const decoder = new ContactsSyncWireDecoder(inProcessContactsSyncCodec);
    await expect(
      decoder.accept({
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-c',
        frame: changed,
        ownPrivateKey: b.privateKey,
        expectedPeerPublicKey: a.publicKey,
      }),
    ).rejects.toThrow();
  });

  it('持续收到新分片时按最后活动时间续期传输', async () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const state = { opaqueTestData: randomBytes(600_000).toString('base64') };
    const frames = await encodeContactsSyncMessage(
      {
        message: { version: 1, type: 'state', state },
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    expect(frames.length).toBeGreaterThan(2);

    const decoder = new ContactsSyncWireDecoder(inProcessContactsSyncCodec);
    let result: Awaited<ReturnType<typeof decoder.accept>> = null;
    for (const [index, frame] of frames.entries()) {
      result =
        (await decoder.accept({
          srcDeviceId: 'device-a',
          dstDeviceId: 'device-b',
          frame,
          ownPrivateKey: b.privateKey,
          expectedPeerPublicKey: a.publicKey,
          now: index * 90_000,
        })) ?? result;
    }

    expect((frames.length - 1) * 90_000).toBeGreaterThan(2 * 60 * 1000);
    expect(result).toEqual({ version: 1, type: 'state', state });
  });

  it('重复分片不会为停滞传输续期', async () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const state = { opaqueTestData: randomBytes(600_000).toString('base64') };
    const frames = await encodeContactsSyncMessage(
      {
        message: { version: 1, type: 'state', state },
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    expect(frames.length).toBeGreaterThan(2);

    const decoder = new ContactsSyncWireDecoder(inProcessContactsSyncCodec);
    const accept = (frame: (typeof frames)[number], now: number) =>
      decoder.accept({
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
        frame,
        ownPrivateKey: b.privateKey,
        expectedPeerPublicKey: a.publicKey,
        now,
      });
    await expect(accept(frames[0]!, 0)).resolves.toBeNull();
    await expect(accept(frames[0]!, 110_000)).resolves.toBeNull();

    let result: Awaited<ReturnType<typeof decoder.accept>> = null;
    for (const [index, frame] of frames.slice(1).entries()) {
      result = (await accept(frame, 130_000 + index)) ?? result;
    }
    expect(result).toBeNull();
  });

  it('reset 后丢弃仍在 worker 解码的旧结果', async () => {
    const a = generateContactsSyncIdentity();
    const b = generateContactsSyncIdentity();
    const message = { version: 1 as const, type: 'state' as const, state: { contacts: [] } };
    const [frame] = await encodeContactsSyncMessage(
      {
        message,
        ownPrivateKey: a.privateKey,
        ownPublicKey: a.publicKey,
        peerPublicKey: b.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    const deferred: { release?: () => void; signal?: AbortSignal } = {};
    const decoder = new ContactsSyncWireDecoder({
      encode: inProcessContactsSyncCodec.encode,
      decode: async (_options, signal) => {
        deferred.signal = signal;
        await new Promise<void>((resolve) => {
          deferred.release = resolve;
        });
        return message;
      },
    });

    const decoding = decoder.accept({
      srcDeviceId: 'device-a',
      dstDeviceId: 'device-b',
      frame: frame!,
      ownPrivateKey: b.privateKey,
      expectedPeerPublicKey: a.publicKey,
    });
    await vi.waitFor(() => expect(deferred.release).toBeTypeOf('function'));
    decoder.reset();
    expect(deferred.signal?.aborted).toBe(true);
    deferred.release?.();

    await expect(decoding).resolves.toBeNull();
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
