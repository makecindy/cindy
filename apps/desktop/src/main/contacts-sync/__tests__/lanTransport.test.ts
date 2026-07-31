import net, { type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { inProcessContactsSyncCodec } from '../contactsSyncCodec.js';
import { generateContactsSyncIdentity } from '../crypto.js';
import { LanContactsSyncTransport } from '../lanTransport.js';
import { ContactsSyncWireDecoder, encodeContactsSyncMessage } from '../wire.js';

interface LanTransportInternals {
  endpoints: Map<string, { address: string; port: number; publicKey: string; seenAt: number }>;
  directRetryAfter: Map<string, number>;
  tcpServer: net.Server | null;
  handleConnection(socket: Socket): void;
}

describe('contacts sync LAN transport', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('同网端点需证明持有设备私钥，伪造信标端点会回退 relay', async () => {
    const aIdentity = generateContactsSyncIdentity();
    const bIdentity = generateContactsSyncIdentity();
    type DecodedFrame = Awaited<ReturnType<ContactsSyncWireDecoder['accept']>>;
    let resolveFrame: ((value: DecodedFrame) => void) | null = null;
    const received = new Promise<DecodedFrame>((resolve) => {
      resolveFrame = resolve;
    });
    const decoder = new ContactsSyncWireDecoder(inProcessContactsSyncCodec);
    const b = new LanContactsSyncTransport({
      getSelf: () => ({
        deviceId: 'device-b',
        publicKey: bIdentity.publicKey,
        privateKey: bIdentity.privateKey,
      }),
      isPeerAllowed: (deviceId, publicKey) =>
        deviceId === 'device-a' && publicKey === aIdentity.publicKey,
      onFrame: (srcDeviceId, frame) => {
        void decoder
          .accept({
            srcDeviceId,
            dstDeviceId: 'device-b',
            frame,
            ownPrivateKey: bIdentity.privateKey,
            expectedPeerPublicKey: aIdentity.publicKey,
          })
          .then((message) => resolveFrame?.(message));
      },
      logger: { debug: () => {}, warn: () => {} },
    });
    const bInternals = b as unknown as LanTransportInternals;
    const server = net.createServer((socket) => bInternals.handleConnection(socket));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('LAN transport test server did not expose a TCP port');
    }

    const a = new LanContactsSyncTransport({
      getSelf: () => ({
        deviceId: 'device-a',
        publicKey: aIdentity.publicKey,
        privateKey: aIdentity.privateKey,
      }),
      isPeerAllowed: (deviceId, publicKey) =>
        deviceId === 'device-b' && publicKey === bIdentity.publicKey,
      onFrame: () => {},
      logger: { debug: () => {}, warn: () => {} },
    });
    const aInternals = a as unknown as LanTransportInternals;
    const [frame] = await encodeContactsSyncMessage(
      {
        message: {
          version: 1,
          type: 'state',
          state: { privateContact: 'Alice' },
        },
        ownPrivateKey: aIdentity.privateKey,
        ownPublicKey: aIdentity.publicKey,
        peerPublicKey: bIdentity.publicKey,
        srcDeviceId: 'device-a',
        dstDeviceId: 'device-b',
      },
      inProcessContactsSyncCodec,
    );
    expect(frame).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain('Alice');
    expect(await a.send('device-b', frame!)).toBe(false);

    // 攻击者重放 B 的公开 beacon 后可以接住 TCP，但拿不到 B 的 X25519 私钥，
    // 因而无法返回认证 ACK；发送方必须报告 false，让上层继续走 relay。
    let impostorConnections = 0;
    const impostor = net.createServer((socket) => {
      impostorConnections += 1;
      socket.once('data', (bytes) => socket.end(bytes));
    });
    servers.push(impostor);
    await new Promise<void>((resolve, reject) => {
      impostor.once('error', reject);
      impostor.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const impostorAddress = impostor.address();
    if (!impostorAddress || typeof impostorAddress === 'string') {
      throw new Error('LAN impostor test server did not expose a TCP port');
    }
    aInternals.endpoints.set('device-b', {
      address: '127.0.0.1',
      port: impostorAddress.port,
      publicKey: bIdentity.publicKey,
      seenAt: Date.now(),
    });
    expect(await a.send('device-b', frame!)).toBe(false);
    expect(impostorConnections).toBe(1);

    // 攻击者即使立即重放同一合法设备的公开 beacon，冷却期内也不能让后续
    // 分片再次连接伪端点；send() 必须立即返回 false 让上层走 relay。
    aInternals.endpoints.set('device-b', {
      address: '127.0.0.1',
      port: impostorAddress.port,
      publicKey: bIdentity.publicKey,
      seenAt: Date.now(),
    });
    expect(await a.send('device-b', frame!)).toBe(false);
    expect(impostorConnections).toBe(1);

    // 冷却结束后合法设备仍可恢复直连。
    aInternals.directRetryAfter.set('device-b', Date.now() - 1);
    aInternals.endpoints.set('device-b', {
      address: '127.0.0.1',
      port: address.port,
      publicKey: bIdentity.publicKey,
      seenAt: Date.now(),
    });
    expect(await a.send('device-b', frame!)).toBe(true);
    await expect(received).resolves.toEqual({
      version: 1,
      type: 'state',
      state: { privateContact: 'Alice' },
    });
  });

  it('限制未认证 TCP 并发连接数', () => {
    const identity = generateContactsSyncIdentity();
    const transport = new LanContactsSyncTransport({
      getSelf: () => ({
        deviceId: 'device-a',
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
      }),
      isPeerAllowed: () => false,
      onFrame: () => {},
      logger: { debug: () => {}, warn: () => {} },
    });
    transport.start();
    const internals = transport as unknown as LanTransportInternals;
    expect(internals.tcpServer?.maxConnections).toBe(32);
    transport.stop();
  });
});
