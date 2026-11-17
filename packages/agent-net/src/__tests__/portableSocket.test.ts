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
import { DeviceLinkClient, SERVER_CAPABILITY_NOTIFY } from '@cindy/device-link';
import { AgentNetSocket } from '../portableSocket.js';
import type { PeerChannel, RosterEntry, TransportOptions } from '../types.js';

// A simultaneous dial can replace an admitted channel while its first link-open
// is still in flight. Exercise real frame admission, routing and reply handling;
// an already-established-channel test cannot expose this controlled ordering.
it.each(['before', 'in-flight', 'revoked', 'rotated', 'stale-presence', 'replacement-closed'] as const)(
  'handles %s frames during simultaneous-dial channel replacement', async mode => {
    const local = generateIdentity('a-host'), remote = generateIdentity('b-controller');
    const { root, bootstrap } = createPrivateNetwork('Channel handover', local);
    const member = (identity: typeof remote): DeviceView => ({
      certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }),
      name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [],
    });
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [member(remote)], delegations: [],
      send() {}, presence() {}, onDatagram() {}, close() {} });
    const makeChannel = () => {
      let receive!: (bytes: Uint8Array) => void;
      let finish: () => void = () => undefined;
      const sent: Array<{ kind: string; id?: string }> = [];
      const channel: PeerChannel = {
        remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'),
        send(bytes) { sent.push(JSON.parse(Buffer.from(bytes).subarray(4).toString())); },
        onData(handler) { receive = handler; }, onClose(handler) { finish = handler; },
        // A graceful core close drains already-written bytes; they may arrive
        // after the replacement is admitted. No artificial delay or retry.
        close() {}, path: () => 'relay',
      };
      return { channel, sent, finish() { finish(); }, deliver(frame: object) {
        const body = Buffer.from(JSON.stringify(frame)), header = Buffer.alloc(4); header.writeUInt32BE(body.length);
        receive(Buffer.concat([header, body]));
      } };
    };
    const old = makeChannel(), preferred = makeChannel();
    let transport!: TransportOptions;
    const socket = await AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey,
        certificate: bootstrap.ownerCertificate, identity: local, connect: async () => uplink },
      userId: bootstrap.ownerCertificate.subject,
      bindings: { verifyCertificate, createTransport: async options => {
        transport = options;
        return { id: 'local', dial: {}, connect: async () => preferred.channel, close: async () => undefined };
      } },
    });
    const received: string[] = [];
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); received.push(frame.kind);
      if (frame.kind === 'link-open') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'link-accept',
        id: frame.id, dst: frame.src, payload: { appVersion: 'test', allowlistHash: 'test' } }));
    });
    const request = { v: PROTOCOL_VERSION, kind: 'link-open', id: 'in-flight-open', dst: local.deviceId, payload: {} };
    try {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
        deviceName: 'Host', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false,
      } }));
      // The preferred outgoing handshake is already in progress when the
      // incoming nonpreferred connection is admitted first.
      const preferredDial = socket.dial(remote.deviceId);
      transport.onIncoming(old.channel);
      if (mode === 'before') old.deliver(request);
      await preferredDial;
      received.length = 0;
      if (mode === 'revoked') { uplink.devices = []; uplink.emit('directory'); }
      if (mode === 'rotated') { uplink.devices = [member(generateIdentity(remote.deviceId))]; uplink.emit('directory'); }
      if (mode === 'replacement-closed') preferred.finish();
      if (mode === 'stale-presence') old.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { online: true } });
      else if (mode !== 'before') old.deliver(request);
      if (mode === 'before') expect(old.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: request.id }));
      else if (mode === 'in-flight') expect(preferred.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: request.id }));
      else {
        expect(received).not.toContain(mode === 'stale-presence' ? 'presence-changed' : 'link-open');
        expect(preferred.sent.some(frame => frame.kind === 'link-accept')).toBe(false);
      }
    } finally { socket.close(); }
  });

// Mixed-version protocol, unit: real signed roster and length-prefixed peer
// frames through openWithBindings/dial. Existing recovery tests sent no peer
// presence; an old frame must not overwrite the App learned from the directory.
it('fills a legacy online presence from the directory and publishes later App updates', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('App routing', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Friend Mac', app: 'cindy-friend', online: false,
    remoteControlEnabled: false, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  let receive!: (bytes: Uint8Array) => void;
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send() {},
    onData(callback) { receive = callback; }, onClose() {}, close() {}, path: () => 'relay' };
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate,
      identity: local, connect: async () => uplink }, userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect: async () => channel, close: async () => undefined }) },
  });
  const delivered: Array<{ kind: string; payload?: { deviceId?: string; online?: boolean; app?: string } }> = [];
  socket.on('message', message => delivered.push(JSON.parse(message.toString())));
  const legacyPresence = () => {
    const body = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: {
      deviceName: 'Friend Mac', platform: 'darwin', online: true, remoteControlEnabled: false, busy: false, lastSeenAt: 1,
    } }));
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    receive(Buffer.concat([header, body]));
  };
  const lastPresence = () => delivered.filter(frame => frame.kind === 'presence-changed' && frame.payload?.online).at(-1)?.payload;
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
      deviceName: 'Local', platform: 'test', app: 'cindy', appVersion: '1', remoteControlEnabled: true, busy: false,
    } }));
    await socket.dial(remote.deviceId);
    legacyPresence();
    expect(lastPresence()).toMatchObject({ deviceId: remote.deviceId, online: true, app: 'cindy-friend' });
    uplink.devices = [{ ...device, app: 'future-app' }]; uplink.emit('directory');
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
    legacyPresence();
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
    uplink.devices = [{ ...device, app: undefined }]; uplink.emit('directory');
    legacyPresence();
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
  } finally { socket.close(); }
});

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

/** An offline cached start bypasses the successful-handshake path exercised by
 * the integration suite. Notification capability must recover on this same app
 * socket; reconnecting it would discard otherwise healthy direct peers. */
it('refreshes notification capability when a cached offline startup reconnects', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Notification recovery', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [],
    notificationKey: { v: 2, networkId: certificate.networkId, deviceId: remote.deviceId, encryptionKey: remote.transportKey, signature: 'unit' } };
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], notifications: true,
    delegations: [], send() {}, presence() {}, onDatagram() {}, close() {} });
  const first = makeUplink(), second = makeUplink();
  const connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(first).mockResolvedValue(second);
  const notify = vi.fn(async () => undefined), createWebSocket = vi.fn(async () => AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject, cachedDirectory: [device], directoryExpiresAt: Date.now() + 60_000,
    bindings: { verifyCertificate, notify, createTransport: async () => ({ id: 'local', dial: {},
      connect: async () => { throw new Error('No peer dial needed'); }, close: async () => undefined }) },
  }));
  const client = new DeviceLinkClient({ getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'unit-marker',
    getHello: () => ({ deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
    createWebSocket, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const payload = { category: 'session-done' as const, title: 'Completed', deepLink: '/sessions/unit', collapseId: 'unit', targetDeviceId: 'remote' };
  try {
    client.start(); await client.waitUntilOnline(1000);
    expect(client.sendNotify(payload)).toBe(false);
    await vi.waitFor(() => expect(client.hasServerCapability(SERVER_CAPABILITY_NOTIFY)).toBe(true), { timeout: 1500 });
    expect(client.sendNotify(payload)).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    first.emit('close', 1006);
    expect(client.sendNotify(payload)).toBe(false);
    await vi.waitFor(() => expect(client.hasServerCapability(SERVER_CAPABILITY_NOTIFY)).toBe(true), { timeout: 1500 });
    expect(client.sendNotify(payload)).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(client.getStatus()).toBe('online');
  } finally { client.stop(); }
});
