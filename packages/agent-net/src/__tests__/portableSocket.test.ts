/** Production entry: PortableSocket.openWithBindings/dial with injected I/O.
 * Agent-Net recovery rule: a stale LAN candidate must not strand an authorized
 * peer while its relay is healthy. The encrypted network integration covers
 * working addresses, not a deterministic first-handshake failure. Minimal input:
 * one signed peer, one discovered address, and one failed UDP connection attempt.
 * Unit tier: real socket routing and certificates, in-memory transport only.
 */
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, issueCertificate, verifyCertificate } from '@cindy/agent-net-relay';
import type { DeviceView } from '@cindy/agent-net-protocol';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../portableSocket.js';
import type { PeerChannel, RosterEntry } from '../types.js';

it('retires a failed LAN candidate and retries only that peer through the relay', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Unit network', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  let disconnected: () => void = () => undefined;
  const send = vi.fn();
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send,
    onData() {}, onClose(callback) { disconnected = callback; }, close() {}, path: () => 'relay' };
  const connect = vi.fn(async (entry: RosterEntry) => {
    if ((entry.dial as { preferUdp?: boolean }).preferUdp) throw new Error('handshake timed out');
    return channel;
  });
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: {
      verifyCertificate,
      createTransport: async () => ({ id: 'local', dial: { udp: { port: 1 } }, connect, close: async () => undefined }),
      createDiscovery: options => ({ start() { options.onCandidate('remote', { address: '127.0.0.1', port: 1 }); }, close() {} }),
    },
  });
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.waitFor(() => expect(socket.supports('remote')).toBe(true));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0][0].dial).toMatchObject({ preferUdp: true });
    expect(connect.mock.calls[1][0].dial).toEqual({ relayId: 'remote' });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'remote', payload: { channel: 'test:echo', args: ['relay recovered'] } }));
    expect(send.mock.calls.some(([bytes]) => Buffer.from(bytes).subarray(4).toString().includes('relay recovered'))).toBe(true);
    disconnected();
    await socket.dial('remote');
    expect(connect.mock.calls[2][0].dial).toEqual({ relayId: 'remote' });
  } finally { socket.close(); }
});
