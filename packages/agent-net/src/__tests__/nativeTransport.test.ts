import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, issueCertificate, verifyCertificate } from '@cindy/agent-net-relay';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../portableSocket.js';
import { NativeTransport, type NativeEnginePort } from '../nativeTransport.js';
import type { PeerChannel } from '../types.js';

// Unit at the production NativeTransport IO boundary: a poll is still initializing
// an existing peer when another peer starts dialing. The old snapshot cannot
// declare that newer connection missing. The handover tests below never dial
// while a native command is suspended, so they cannot cover this ordering.
// Expiry remains independent of that snapshot, including a late established
// reply or initialization completing beyond the existing three-second deadline.
it.each(['ready', 'old-poll-timeout', 'late-established', 'slow-initialize'] as const)(
  'keeps newer native dials snapshot-safe and deadline-bounded: %s', async mode => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  let release!: () => void, entered!: () => void, connected!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dialCreated = new Promise<void>(resolve => { connected = resolve; });
  const closed: number[] = [], received: number[] = [];
  let nextStream = 0, first = true, dialed = false, delayed = false;
  const state = (id: number) => ({ id, established: true, dead: false, closedByPeer: false,
    unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 });
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
      if (command.op === 'poll') {
        if (dialed && mode === 'late-established' && !delayed) { delayed = true; vi.advanceTimersByTime(3001); }
        value = { packets: [], connections: [state(1), ...(dialed ? [state(2)] : [])].filter(s => !closed.includes(s.id)) };
      }
      if (command.op === 'connect') { dialed = true; value = 2; connected(); }
      if (command.op === 'openStream') {
        if (first) { first = false; entered(); await blocked; }
        if (command.id === 2 && mode === 'slow-initialize' && !delayed) { delayed = true; vi.advanceTimersByTime(3001); }
        value = ++nextStream;
      }
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      if (command.op === 'close') closed.push(command.id as number);
      return value as T;
    }, async destroy() {},
  };
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: () => { received.push(1); } });
    const poll = vi.advanceTimersByTimeAsync(8);
    await initializing;
    let outcome: { channel: PeerChannel } | { error: unknown } | undefined;
    const result = transport.connect({ id: key, dial: { relayId: remote.deviceId } })
      .then(channel => ({ channel }), error => ({ error })).then(value => { outcome = value; return value; });
    await dialCreated;
    await vi.advanceTimersByTimeAsync(0); // Register the waiter after the bridge command returned.
    if (mode === 'old-poll-timeout') vi.advanceTimersByTime(3001);
    release(); await poll;
    await vi.advanceTimersByTimeAsync(0); // Finish this poll without starting the next eight-ms poll.
    if (mode === 'old-poll-timeout') {
      expect(outcome).toMatchObject({ error: new Error('NATIVE_CONNECT_TIMEOUT') });
      expect(closed).toContain(2);
      expect(received).toEqual([1]);
      return;
    }
    await vi.advanceTimersByTimeAsync(8);
    if (mode === 'ready') {
      expect(await result).toHaveProperty('channel');
      expect(closed).not.toContain(2);
    } else {
      expect(await result).toMatchObject({ error: new Error('NATIVE_CONNECT_TIMEOUT') });
      expect(closed).toContain(2);
    }
    expect(received).toEqual([1]);
  } finally { release?.(); await transport?.close(); vi.useRealTimers(); }
});

// Unit at the native engine IO boundary: real NativeTransport/NativeChannel and
// PortableSocket admission, framing and replies; no fake PeerChannel.close.
it.each(['late-frame', 'late-response', 'revoked', 'rotated', 'abort', 'deadline'] as const)(
  'keeps native retired receive bounded and authorized: %s', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const local = generateIdentity('z-native'), remote = generateIdentity('a-guest');
    const { root, bootstrap } = createPrivateNetwork('native handover', local);
    const member = (identity: typeof remote) => ({ certificate: issueCertificate(root, {
      networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member',
    }), name: 'Guest', online: false, remoteControlEnabled: true, capabilities: [] });
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [member(remote)],
      delegations: [], send() {}, presence() {}, onDatagram() {}, close() {} });
    const frame = (id: string, kind = 'link-open') => {
      const body = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, kind, id, dst: local.deviceId, payload: {} }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]).toString('base64url');
    };
    const state = (id: number, data: string[] = [], opening = false) => ({ id, established: true, dead: false,
      closedByPeer: false, unacked: false, remoteKey: remote.transportKey, events: opening ? [{ kind: 'open', stream: 71 }] : [],
      data: data.map(data => ({ stream: 71, data })), rttUs: 0, sent: 0, received: 0, rotations: 0 });
    let states = [state(1, [Buffer.from([0x44]).toString('base64url')], true)], nextStream = 0;
    const closed = new Set<number>(), writes: Array<{ id: number; bytes: Buffer }> = [];
    const finishes: number[] = [], channels: PeerChannel[] = [];
    const engine: NativeEnginePort = {
      async command<T>(command: Record<string, unknown>): Promise<T> {
        let value: unknown;
        if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
        if (command.op === 'poll') { value = { packets: [], connections: states.filter(s => !closed.has(s.id)) }; states = states.map(s => ({ ...s, events: [], data: [] })); }
        if (command.op === 'openStream') value = ++nextStream;
        if (command.op === 'write') { const bytes = Buffer.from(command.data as string, 'base64url'); writes.push({ id: command.id as number, bytes }); value = bytes.length; }
        if (command.op === 'finish') finishes.push(command.id as number);
        if (command.op === 'close') closed.add(command.id as number);
        return value as T;
      }, async destroy() {},
    };
    let socket: AgentNetSocket | undefined;
    try {
      socket = await AgentNetSocket.openWithBindings({ client: { base: 'https://relay.example.test',
        rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect: async () => uplink },
        userId: bootstrap.ownerCertificate.subject,
        bindings: { verifyCertificate, createTransport: options => NativeTransport.create(engine, { ...options,
          onIncoming(channel) { channels.push(channel); options.onIncoming(channel); } }) } });
      const received: string[] = [];
      socket.on('message', raw => {
        const f = JSON.parse(raw.toString());
        if (f.kind === 'invoke-result') received.push(f.id);
        if (f.kind === 'link-open') { received.push(f.id); socket!.send(JSON.stringify({ v: PROTOCOL_VERSION,
          kind: 'link-accept', id: f.id, dst: f.src, payload: { appVersion: 'test', allowlistHash: 'test' } })); }
      });
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
        deviceName: 'Native', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false,
      } }));
      await vi.advanceTimersByTimeAsync(8);
      if (mode === 'late-response') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'invoke',
        id: 'old-in-flight', dst: remote.deviceId, payload: { channel: 'test:echo', args: [] } }));
      // New authenticated inbound is admitted before an already-written old
      // request arrives. Both endpoints have the same direction and identity.
      states = [state(2, [Buffer.from([0x44]).toString('base64url')], true), state(1)];
      await vi.advanceTimersByTimeAsync(8);
      expect(channels).toHaveLength(2);
      expect(finishes).toContain(1);
      if (mode === 'revoked') { uplink.devices = []; uplink.emit('directory'); }
      if (mode === 'rotated') { uplink.devices = [member(generateIdentity(remote.deviceId))]; uplink.emit('directory'); }
      if (mode === 'abort') channels[0].close({ drain: false });
      // Outgoing ACK completion must not cut off receive before the deadline.
      await vi.advanceTimersByTimeAsync(mode === 'deadline' ? 2000 : 24);
      states = [state(2), state(1, [frame('old-in-flight', mode === 'late-response' ? 'invoke-result' : 'link-open')])];
      await vi.advanceTimersByTimeAsync(16);
      if (mode === 'late-frame' || mode === 'late-response') {
        expect(received).toContain('old-in-flight');
        if (mode === 'late-frame') expect(writes.some(w => w.id === 2 && w.bytes.length > 4 && w.bytes.subarray(4).toString().includes('old-in-flight'))).toBe(true);
        // Late old close must leave the selected native channel usable.
        channels[0].close({ drain: false });
        states = [state(2, [frame('new-request')])];
        await vi.advanceTimersByTimeAsync(16);
        expect(received).toContain('new-request');
      } else expect(received).not.toContain('old-in-flight');
      if (mode === 'deadline' || mode === 'abort') expect(closed.has(1)).toBe(true);
    } finally { socket?.close(); await Promise.resolve(); vi.useRealTimers(); }
  });
