import { describe, expect, it, vi } from 'vitest';

import type { ContactsSyncWireFrame } from '../wire.js';

const harness = vi.hoisted(() => ({
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
  encodeContactsSyncDatabaseState: async () => ({
    frames: harness.frames,
    materialized: false,
  }),
}));

const { ContactsSyncOutbound } = await import('../sender.js');

describe('contacts sync outbound', () => {
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
});
