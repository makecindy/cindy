import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContactsSyncWireFrame } from '../wire.js';

const harness = vi.hoisted(() => ({
  encode: vi.fn(),
  frames: [0, 1, 2].map((index) => ({
    version: 1,
    type: 'cipher-chunk',
    senderPublicKey: 'own-public',
    transferId: 'same-transfer',
    index,
    total: 3,
    iv: 'iv',
    tag: 'tag',
    compression: 'gzip',
    data: `chunk-${index}`,
  })),
}));

vi.mock('../wire.js', () => ({
  encodeContactsSyncDatabaseState: harness.encode,
}));

const { ContactsSyncOutbound } = await import('../sender.js');

describe('contacts sync outbound', () => {
  beforeEach(() => {
    harness.encode.mockReset();
    harness.encode.mockResolvedValue({
      frames: harness.frames,
      materialized: false,
    });
  });

  it('retries the same relay frame after backpressure before advancing', async () => {
    const attempts: number[] = [];
    let rejectMiddleFrame = true;
    const transport = {
      getSelfDeviceId: () => 'self-device',
      isPeerAllowed: (deviceId: string) => deviceId === 'peer-device',
      sendRelayFrame: (_deviceId: string, frame: ContactsSyncWireFrame) => {
        if (frame.type !== 'cipher-chunk') throw new Error('unexpected key frame');
        attempts.push(frame.index);
        if (frame.index === 1 && rejectMiddleFrame) {
          rejectMiddleFrame = false;
          throw Object.assign(new Error('full'), { code: 'BACKPRESSURE' });
        }
      },
    };
    const codecAbortController = new AbortController();
    const outbound = new ContactsSyncOutbound({
      getGeneration: () => 1,
      getOwnerId: () => 'owner-a',
      getTransport: () => transport,
      getDirectTransport: () => null,
      getCodecAbortSignal: () => codecAbortController.signal,
      isEnabled: () => true,
      getIdentity: () => ({ privateKey: 'own-private', publicKey: 'own-public' }),
      getPeerPublicKey: () => 'peer-public',
      getDatabaseSource: () => ({ dbPath: '/tmp/test-contacts.db' }),
      getKnownClocks: () => undefined,
      getKnownMergeClocks: () => undefined,
      peerSupportsMergeRedirects: () => false,
      getPeerDeliveryEpoch: () => 0,
      onLocalMaterialized: vi.fn(),
      announceKey: vi.fn(),
      onError: vi.fn(),
    });

    await outbound.send('peer-device', true);

    expect(attempts).toEqual([0, 1, 1, 2]);
    expect(new Set(harness.frames.map((frame) => frame.transferId))).toEqual(
      new Set(['same-transfer']),
    );
  });

  it('drops a capable payload encoded before the peer went offline', async () => {
    let peerDeliveryEpoch = 0;
    let finishEncode:
      ((result: { frames: typeof harness.frames; materialized: boolean }) => void) | undefined;
    harness.encode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEncode = resolve;
        }),
    );
    const sendRelayFrame = vi.fn();
    const onLocalMaterialized = vi.fn();
    const transport = {
      getSelfDeviceId: () => 'self-device',
      // 模拟同一 deviceId 已用旧进程重新上线；仅在线状态不足以授权旧 payload。
      isPeerAllowed: (deviceId: string) => deviceId === 'peer-device',
      sendRelayFrame,
    };
    const codecAbortController = new AbortController();
    const outbound = new ContactsSyncOutbound({
      getGeneration: () => 1,
      getOwnerId: () => 'owner-a',
      getTransport: () => transport,
      getDirectTransport: () => null,
      getCodecAbortSignal: () => codecAbortController.signal,
      isEnabled: () => true,
      getIdentity: () => ({ privateKey: 'own-private', publicKey: 'own-public' }),
      getPeerPublicKey: () => 'peer-public',
      getDatabaseSource: () => ({ dbPath: '/tmp/test-contacts.db' }),
      getKnownClocks: () => undefined,
      getKnownMergeClocks: () => undefined,
      peerSupportsMergeRedirects: () => true,
      getPeerDeliveryEpoch: () => peerDeliveryEpoch,
      onLocalMaterialized,
      announceKey: vi.fn(),
      onError: vi.fn(),
    });

    const sending = outbound.send('peer-device', false);
    await vi.waitFor(() => expect(harness.encode).toHaveBeenCalledTimes(1));
    peerDeliveryEpoch += 1;
    finishEncode?.({ frames: harness.frames, materialized: true });
    await sending;

    expect(onLocalMaterialized).toHaveBeenCalledTimes(1);
    expect(sendRelayFrame).not.toHaveBeenCalled();
  });
});
