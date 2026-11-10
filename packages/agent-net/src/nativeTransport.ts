import { ChannelEvents, type PeerChannel, type RosterEntry, type Transport, type TransportOptions } from './types.js';
import { concatBytes, decodeUtf8, fromBase64Url, keyHex, toBase64Url, utf8 } from './portableBytes.js';

export interface NativeEnginePort {
  command<T = unknown>(command: Record<string, unknown>): Promise<T>;
  destroy(): Promise<void>;
  assertCurrent?(): void;
}
interface Address { address: string; port: number; }
interface NativeState {
  id: number; established: boolean; dead: boolean; closedByPeer: boolean; unacked: boolean; remoteKey: string;
  path?: Address | { link: number };
  events: { kind: 'open' | 'finish'; stream: number }[];
  data: { stream: number; data: string }[];
  rttUs: number; sent: number; received: number; rotations: number;
}
interface Poll { packets: { link: number; data: string }[]; connections: NativeState[]; }
interface NativeIdentity { deviceId: string; transportKey: string; udpPort: number | null; }
interface Waiting { resolve(channel: PeerChannel): void; reject(error: Error): void; deadline: number; }
const MAX_PENDING = 16 * 1024 * 1024;
const now = () => performance.now();

/** Native Rust owns UDP, cryptography and reliable packet state; JS owns the
 * existing authenticated stream protocol. Every native poll mirrors revocation
 * before reading or transmitting another packet. */
export class NativeTransport implements Transport {
  readonly id: string;
  readonly dial: { udp?: Address };
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private channels = new Map<number, NativeChannel>();
  private waiting = new Map<number, Waiting>();
  private links = new Map<string, number>();
  private deviceForLink = new Map<number, string>();
  private lastAdmission = '';
  private nextLink = 0;
  private pendingBytes = 0;
  private constructor(
    private readonly engine: NativeEnginePort,
    private readonly options: TransportOptions,
    identity: NativeIdentity,
    private readonly localCandidates: Address[],
  ) {
    this.id = keyHex(identity.transportKey);
    this.dial = identity.udpPort ? { udp: { address: '0.0.0.0', port: identity.udpPort } } : {};
    options.relay?.uplink.onDatagram((deviceId, bytes) => {
      if (this.closed) return;
      const link = this.links.get(deviceId);
      if (!link) return;
      void this.call({ op: 'datagram', from: { link }, data: toBase64Url(bytes) }).catch(() => undefined);
    });
  }
  static async create(engine: NativeEnginePort, options: TransportOptions, addresses: string[] = []): Promise<NativeTransport> {
    if (!options.admittedPeers) throw new Error('NATIVE_PEER_LIST_REQUIRED');
    try {
      const identity = await engine.command<NativeIdentity>({ op: 'identity' });
      const candidates = identity.udpPort ? addresses.filter(address => address.length <= 128).slice(0, 16)
        .map(address => ({ address, port: identity.udpPort! })) : [];
      const transport = new NativeTransport(engine, options, identity, candidates);
      await transport.synchronizeAdmission();
      transport.schedule();
      return transport;
    } catch (error) { await engine.destroy().catch(() => undefined); throw error; }
  }
  async call<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    this.engine.assertCurrent?.();
    const result = await this.engine.command<T>(command);
    this.engine.assertCurrent?.();
    if (this.closed) throw new Error('NATIVE_TRANSPORT_CLOSED');
    return result;
  }
  private linkFor(deviceId: string): number {
    const existing = this.links.get(deviceId);
    if (existing) return existing;
    if (this.links.size >= 4096) throw new Error('NATIVE_PEER_ADDRESS_LIMIT');
    const link = ++this.nextLink;
    this.links.set(deviceId, link); this.deviceForLink.set(link, deviceId);
    return link;
  }
  private async synchronizeAdmission(): Promise<void> {
    const entries = this.options.admittedPeers!().map(peer => {
      if (!/^[a-f0-9]{64}$/.test(peer.id) || !this.options.admit(peer.id)) throw new Error('INVALID_NATIVE_PEER');
      const key = Uint8Array.from(peer.id.match(/../g)!, part => parseInt(part, 16));
      return { key: toBase64Url(key), link: this.linkFor(peer.relayId) };
    }).sort((a, b) => a.link - b.link);
    const serialized = JSON.stringify(entries);
    if (serialized === this.lastAdmission) return;
    await this.call({ op: 'admit', peers: entries });
    this.lastAdmission = serialized;
  }
  async connect(entry: RosterEntry): Promise<PeerChannel> {
    if (!this.options.admit(entry.id)) throw new Error('UNAUTHORIZED_PEER');
    await this.synchronizeAdmission();
    const dial = entry.dial as { relayId?: string; udp?: Address; preferUdp?: boolean };
    const expected = this.options.relayIdOf?.(entry.id);
    if (!expected || dial.relayId !== expected) throw new Error('PEER_ADDRESS_MISMATCH');
    const address = dial.preferUdp && dial.udp ? dial.udp : { link: this.linkFor(expected) };
    const key = toBase64Url(Uint8Array.from(entry.id.match(/../g)!, part => parseInt(part, 16)));
    const id = await this.call<number>({ op: 'connect', key, address });
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('NATIVE_TRANSPORT_CLOSED')); return; }
      this.waiting.set(id, { resolve, reject, deadline: now() + 3_000 });
    });
  }
  reserve(bytes: number): void {
    if (this.pendingBytes + bytes > MAX_PENDING) throw new Error('NATIVE_TRANSPORT_BACKPRESSURE');
    this.pendingBytes += bytes;
  }
  release(bytes: number): void { this.pendingBytes = Math.max(0, this.pendingBytes - bytes); }
  private schedule(): void {
    if (!this.closed && !this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().then(() => this.schedule(), () => this.close());
    }, 8);
  }
  private async poll(): Promise<void> {
    await this.synchronizeAdmission();
    const result = await this.call<Poll>({ op: 'poll' });
    for (const packet of result.packets) {
      const deviceId = this.deviceForLink.get(packet.link);
      if (deviceId) this.options.relay?.uplink.send(deviceId, fromBase64Url(packet.data));
    }
    const alive = new Set(result.connections.map(connection => connection.id));
    for (const state of result.connections) {
      let channel = this.channels.get(state.id);
      const key = keyHex(state.remoteKey);
      if (state.dead || state.closedByPeer || !this.options.admit(key)) {
        channel?.close({ drain: false });
        this.waiting.get(state.id)?.reject(new Error('NATIVE_CONNECTION_CLOSED'));
        this.waiting.delete(state.id);
        if (!channel) void this.call({ op: 'close', id: state.id }).catch(() => undefined);
        continue;
      }
      try {
        if (!channel && state.established) {
          channel = new NativeChannel(this, state.id, key, this.localCandidates);
          this.channels.set(state.id, channel);
          await channel.initialize();
          const waiting = this.waiting.get(state.id);
          if (waiting) { this.waiting.delete(state.id); waiting.resolve(channel); }
          else this.options.onIncoming(channel);
        }
        if (channel) { channel.receive(state); await channel.flush(); }
      } catch (error) {
        channel?.close({ drain: false });
        this.waiting.get(state.id)?.reject(error instanceof Error ? error : new Error('NATIVE_CONNECTION_CLOSED'));
        this.waiting.delete(state.id);
        this.engine.assertCurrent?.();
      }
    }
    for (const [id, channel] of this.channels) if (!alive.has(id)) channel.close({ drain: false });
    for (const [id, waiting] of this.waiting) if (!alive.has(id) || now() >= waiting.deadline) {
      this.waiting.delete(id); waiting.reject(new Error('NATIVE_CONNECT_TIMEOUT'));
      void this.call({ op: 'close', id }).catch(() => undefined);
    }
  }
  detach(id: number): void {
    this.channels.delete(id);
    if (!this.closed) void this.call({ op: 'close', id }).catch(() => undefined);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const pending of this.waiting.values()) pending.reject(new Error('NATIVE_TRANSPORT_CLOSED'));
    this.waiting.clear();
    for (const channel of [...this.channels.values()]) channel.close({ drain: false });
    this.channels.clear();
    await this.engine.destroy();
  }
}

class NativeChannel implements PeerChannel {
  private events = new ChannelEvents();
  private dataStream = 0;
  private streams = new Map<number, { kind: number | null; text: string }>();
  private queue: { bytes: Uint8Array; offset: number }[] = [];
  private queuedBytes = 0;
  private state: NativeState | null = null;
  private candidates: Address[] = [];
  private candidateCursor = 0;
  private nextProbe = 0;
  private disposed = false;
  private closeDeadline = 0;
  private finishSnapshot: NativeState | null = null;
  constructor(private owner: NativeTransport, private id: number, readonly remoteId: string, private local: Address[]) {}
  async initialize(): Promise<void> {
    this.dataStream = await this.owner.call<number>({ op: 'openStream', id: this.id });
    await this.owner.call({ op: 'write', id: this.id, stream: this.dataStream, data: toBase64Url(Uint8Array.of(0x44)) });
    const control = await this.owner.call<number>({ op: 'openStream', id: this.id, priority: 'interactive' });
    const bytes = concatBytes([Uint8Array.of(0x43), utf8(JSON.stringify({ candidates: this.local }) + '\n')]);
    await this.owner.call({ op: 'write', id: this.id, stream: control, data: toBase64Url(bytes) });
  }
  send(bytes: Uint8Array): void {
    if (this.events.closed) throw new Error('NATIVE_CONNECTION_CLOSED');
    this.owner.reserve(bytes.length);
    this.queue.push({ bytes: bytes.slice(), offset: 0 });
    this.queuedBytes += bytes.length;
  }
  get bufferedAmount(): number { return this.queuedBytes; }
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.closeDeadline && now() >= this.closeDeadline) { this.dispose(); return; }
    for (let turn = 0; turn < 8 && this.queue.length && !this.disposed; turn++) {
      const item = this.queue[0], part = item.bytes.subarray(item.offset, item.offset + 65_536);
      const written = await this.owner.call<number>({ op: 'write', id: this.id, stream: this.dataStream, data: toBase64Url(part) });
      if (!Number.isInteger(written) || written < 0 || written > part.length) throw new Error('INVALID_NATIVE_WRITE');
      if (!written) break;
      item.offset += written; this.queuedBytes -= written; this.owner.release(written);
      if (item.offset === item.bytes.length) this.queue.shift();
    }
    if (this.closeDeadline && !this.queue.length) {
      if (!this.finishSnapshot) {
        this.finishSnapshot = this.state;
        await this.owner.call({ op: 'finish', id: this.id, stream: this.dataStream });
      } else if (this.state !== this.finishSnapshot && !this.state?.unacked) this.dispose();
    }
  }
  receive(state: NativeState): void {
    this.state = state;
    if (this.events.closed) return;
    for (const event of state.events) if (event.kind === 'open') {
      if (this.streams.size >= 128) { this.close({ drain: false }); return; }
      this.streams.set(event.stream, { kind: null, text: '' });
    }
    for (const chunk of state.data) {
      const stream = this.streams.get(chunk.stream);
      if (!stream) { this.close({ drain: false }); return; }
      let data = fromBase64Url(chunk.data);
      if (stream.kind === null && data.length) { stream.kind = data[0]; data = data.subarray(1); }
      if (stream.kind === 0x44) { if (data.length) this.events.data(data); }
      else if (stream.kind === 0x43) {
        stream.text += decodeUtf8(data);
        if (stream.text.length > 8192) { this.close({ drain: false }); return; }
        for (let end = stream.text.indexOf('\n'); end >= 0; end = stream.text.indexOf('\n')) {
          try {
            const value = JSON.parse(stream.text.slice(0, end));
            if (Array.isArray(value.candidates)) {
              this.candidates = value.candidates.filter((a: Address) => a && typeof a.address === 'string' && a.address.length <= 128
                && Number.isInteger(a.port) && a.port > 0 && a.port <= 65535).slice(0, 16);
              this.candidateCursor = 0; this.nextProbe = 0;
            }
          } catch { /* Ignore malformed candidate announcements, never business frames. */ }
          stream.text = stream.text.slice(end + 1);
        }
      } else if (stream.kind !== null) { this.close({ drain: false }); return; }
    }
    for (const event of state.events) if (event.kind === 'finish') {
      if (this.streams.get(event.stream)?.kind === 0x44) { this.close(); return; }
      this.streams.delete(event.stream);
    }
    if (now() >= this.nextProbe && this.candidates.length) {
      this.nextProbe = now() + 10_000;
      const count = Math.min(4, this.candidates.length);
      for (let index = 0; index < count; index++) {
        const address = this.candidates[(this.candidateCursor + index) % this.candidates.length];
        void this.owner.call({ op: 'probe', id: this.id, address }).catch(() => undefined);
      }
      this.candidateCursor = (this.candidateCursor + count) % this.candidates.length;
    }
  }
  onData(handler: (bytes: Uint8Array) => void): void { this.events.onData(handler); }
  onClose(handler: () => void): void { this.events.onClose(handler); }
  path(): 'direct' | 'relay' | null { return this.events.closed || !this.state?.path ? null : 'link' in this.state.path ? 'relay' : 'direct'; }
  stats(): Record<string, number> | null {
    return this.events.closed || !this.state ? null : { srttUs: this.state.rttUs, sent: this.state.sent, received: this.state.received, rotations: this.state.rotations };
  }
  close(options?: { drain?: boolean }): void {
    if (this.disposed) return;
    this.events.close();
    if (options?.drain !== false) { this.closeDeadline ||= now() + 2_000; return; }
    this.dispose();
  }
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue) this.owner.release(item.bytes.length - item.offset);
    this.queue = []; this.queuedBytes = 0; this.streams.clear(); this.events.close(); this.owner.detach(this.id);
  }
}
