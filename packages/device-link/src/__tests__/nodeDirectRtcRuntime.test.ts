import { expect, it, vi } from 'vitest';
import { createNodeDirectRtcRuntime } from '../nodeDirectRtcRuntime.js';

// The injected constructor is the production seam used by a native Node host.
// The browser default must stay untouched, including on machines with no global RTC.
it('uses the supplied native RTC constructor without setting or reading a browser global', async () => {
  const previous = globalThis.RTCPeerConnection;
  const configurations: RTCConfiguration[] = [];
  const closed = vi.fn();
  class NativePeer {
    iceGatheringState = 'complete';
    localDescription: RTCSessionDescriptionInit | null = null;
    ondatachannel: unknown;
    onconnectionstatechange: unknown;
    addEventListener() {}
    close = vi.fn();
    constructor(configuration: RTCConfiguration) { configurations.push(configuration); }
    createDataChannel() {
      return { label: 'device-link-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
        close: vi.fn(), bufferedAmount: 0 };
    }
    async createOffer() { return { type: 'offer', sdp: 'native-offer' }; }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  }
  const runtime = createNodeDirectRtcRuntime({
    RTCPeerConnection: NativePeer as unknown as typeof RTCPeerConnection,
  });
  const session = runtime.create('peer1', { open: vi.fn(), message: vi.fn(), drained: vi.fn(), closed });
  await expect(session.offer()).resolves.toBe('native-offer');
  expect(configurations).toEqual([{ iceServers: [] }]);
  expect(globalThis.RTCPeerConnection).toBe(previous);
  session.close(); session.close();
  expect(closed).toHaveBeenCalledOnce();
});

it.each([
  [65535, 65535, null, null],
  [65535, 2, 65535, 2],
  [2, 65535, 2, 65535],
  [null, null, null, null],
  [0, 0, 0, 0],
])('normalizes only the native missing-limit pair (%s,%s)', async (retries, lifetime, expectedRetries, expectedLifetime) => {
  const { createNodeRtcPeerConnection } = await import('../nodeRtcPeerConnection.js');
  let inbound!: (event: RTCDataChannelEvent) => void;
  const makeChannel = () => ({ maxRetransmits: retries, maxPacketLifeTime: lifetime });
  class NativePeer {
    createDataChannel = makeChannel;
    addEventListener(_event: string, handler: typeof inbound) { inbound = handler; }
  }
  const peer = createNodeRtcPeerConnection({ RTCPeerConnection: NativePeer as unknown as typeof RTCPeerConnection }, {});
  const outgoing = peer.createDataChannel('device-link-v1');
  expect([outgoing.maxRetransmits, outgoing.maxPacketLifeTime]).toEqual([expectedRetries, expectedLifetime]);
  const incoming = makeChannel();
  inbound({ channel: incoming } as unknown as RTCDataChannelEvent);
  expect([incoming.maxRetransmits, incoming.maxPacketLifeTime]).toEqual([expectedRetries, expectedLifetime]);
});
