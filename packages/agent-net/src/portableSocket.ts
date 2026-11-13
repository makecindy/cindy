import { SocketEvents } from './socketEvents.js';
import { concatBytes, decodeUtf8, keyHex, utf8 } from './portableBytes.js';
import type { PortableSocketOptions, SocketClient, SocketDiscovery, SocketUplink } from './socketPorts.js';
import {
  CONTROL_KINDS, MAX_FRAME_BYTES, PROTOCOL_VERSION, ROUTED_KINDS, SERVER_CAPABILITY_NOTIFY,
  SHARED_TASK_RELAY_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY,
  type Envelope, type HelloPayload, type PresenceSnapshot,
} from '@cindy/device-link-protocol';
import type { WsLike } from '@cindy/device-link';
import { CERT_LIFETIME_MS, delegationEndpointCertificate, delegationVisibleTo, type Delegation, type DeviceView } from '@cindy/agent-net-protocol';
import { frameMatchesDelegation, scopedFrame, delegatedPeerTarget, type ScopedPeerTarget } from './scopedRoutes.js';
import { MAX_CHANNEL_PENDING_BYTES, type PeerChannel, type RosterEntry, type Transport } from './types.js';

interface Peer { deviceId: string; key: string; channel: PeerChannel; outbound: boolean; info?: PresenceSnapshot; }

/** Node timers can release the event loop; React Native timers are numeric ids. */
function unrefTimer(timer: number | { unref?: () => void }): void {
  if (typeof timer !== 'number') timer.unref?.();
}

/** A bounded length-prefixed stream parser. A malformed peer closes only its own channel. */
class Frames {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private expected: number | null = null;
  push(input: Uint8Array, consume: (frame: Envelope) => void): void {
    this.chunks.push(input.slice()); this.bytes += input.length;
    for (;;) {
      if (this.expected === null) {
        if (this.bytes < 4) return;
        const header = this.take(4);
        this.expected = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
        if (this.expected < 1 || this.expected > MAX_FRAME_BYTES) throw new Error('INVALID_FRAME_LENGTH');
      }
      if (this.bytes < this.expected) return;
      const value: unknown = JSON.parse(decodeUtf8(this.take(this.expected)));
      this.expected = null;
      if (!value || typeof value !== 'object' || (value as Envelope).v !== PROTOCOL_VERSION || typeof (value as Envelope).kind !== 'string') throw new Error('INVALID_FRAME');
      consume(value as Envelope);
    }
  }
  private take(size: number): Uint8Array {
    this.bytes -= size;
    const first = this.chunks[0];
    if (first.length >= size) {
      if (first.length === size) this.chunks.shift(); else this.chunks[0] = first.subarray(size);
      return first.subarray(0, size);
    }
    const merged = concatBytes(this.chunks);
    this.chunks = merged.length === size ? [] : [merged.subarray(size)];
    return merged.subarray(0, size);
  }
}

/** Existing DeviceLinkClient business protocol over authenticated, encrypted Rust streams. */
export class AgentNetSocket extends SocketEvents implements WsLike {
  private transport!: Transport;
  private uplink: SocketUplink | null = null;
  private receiveDatagram: ((id: string, data: Uint8Array) => void) | null = null;
  private roster = new Map<string, DeviceView>();
  private delegations = new Map<string, Delegation>();
  private ownDelegation: Delegation | null = null;
  private knownV2 = new Set<string>();
  private peers = new Map<string, Peer>();
  private dialing = new Map<string, Promise<void>>();
  private pending = new Map<string, { frame: Envelope; bytes: number }[]>();
  private pendingBytes = 0;
  private sentRequests = new Map<string, { peer: string; at: number; frame: Envelope }>();
  private closed = false;
  private ready = false;
  private localHello: HelloPayload | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private retryMs = 500;
  private rosterValidUntil = 0;
  private lan: SocketDiscovery | null = null;
  private lanCandidates = new Map<string, { address: string; port: number }>();
  private directoryRevision = 0;
  private directoryRefresh: ReturnType<typeof setInterval> | undefined;
  private refreshingDirectory = false;
  private notificationAbort = new AbortController();
  private notifying = false;
  protected constructor(private readonly options: PortableSocketOptions) { super(); }

  static async openWithBindings(options: PortableSocketOptions): Promise<AgentNetSocket> {
    const socket = new this(options);
    socket.rosterValidUntil = options.directoryExpiresAt ?? 0;
    // A cached online bit is not current liveness. Wait for authenticated
    // discovery instead of occupying the first cold-start dial with a dead relay.
    socket.updateDirectory((options.cachedDirectory ?? []).map(view => ({ ...view, online: false })), false);
    try { await socket.connectRelay(); }
    catch (error) {
      if (socket.closed || socket.roster.size === 0) { socket.close(); throw error; }
      socket.scheduleReconnect();
    }
    try {
      socket.transport = await options.bindings.createTransport({
        relay: { deviceId: options.client.identity.deviceId, uplink: {
          kind: 'agent-net', send: (id, data) => { if (socket.authorized(id)) socket.uplink?.send(id, data); },
          onDatagram: (receive) => { socket.receiveDatagram = receive; }, close: () => undefined,
        } },
        admit: (key) => socket.deviceForKey(key) !== undefined,
        admissionVersion: () => socket.directoryRevision,
        relayIdOf: (key) => socket.deviceForKey(key),
        admittedPeers: () => socket.peerIds().filter(id => socket.authorized(id))
          .map(id => ({ id: keyHex(socket.transportKey(id)!), relayId: id })),
        onIncoming: (channel) => socket.adopt(channel, false),
      });
      socket.uplink?.onDatagram((id, data) => socket.receiveDatagram?.(id, data));
      const dial = socket.transport.dial as { udp?: { port: number } };
      if (options.bindings.createDiscovery && options.lanDiscovery !== false && dial.udp && !options.client.delegation) {
        socket.lan = options.bindings.createDiscovery({ networkId: options.client.certificate.networkId, port: dial.udp.port,
          certificateFor: (id) => socket.authorized(id) ? socket.roster.get(id)?.certificate : undefined,
          onCandidate(id, address) {
            if (!socket.authorized(id)) return;
            socket.lanCandidates.set(id, address);
            if (socket.ready && !socket.peers.has(id)) void socket.dial(id).catch(() => undefined);
          },
        });
        socket.lan.start();
      }
      socket.directoryRefresh = setInterval(() => { void socket.refreshDirectory().catch(() => undefined); }, 6 * 60 * 60_000);
      unrefTimer(socket.directoryRefresh);
      setTimeout(() => { if (!socket.closed) socket.emit('open'); }, 0);
      return socket;
    } catch (error) { socket.close(); throw error; }
  }
  get bufferedAmount(): number {
    let bytes = this.pendingBytes;
    for (const peer of this.peers.values()) bytes += peer.channel.bufferedAmount ?? 0;
    return bytes;
  }
  get deviceId(): string { return this.options.client.identity.deviceId; }
  /** A REST response cannot overwrite a newer WebSocket directory event. */
  async refreshDirectory(): Promise<void> {
    const client = this.options.client, revision = this.directoryRevision, generation = this.generation;
    if (this.closed || !this.uplink || this.refreshingDirectory || !client.directory) return;
    this.refreshingDirectory = true;
    try {
      const devices = await client.directory(); this.options.assertCurrent?.();
      if (!this.closed && this.uplink && this.options.client === client && this.generation === generation && this.directoryRevision === revision) {
        this.updateDirectory(devices);
      }
    } finally { this.refreshingDirectory = false; }
  }
  /** Renew only the relay credential; existing authenticated direct streams keep running. */
  async replaceClient(next: SocketClient): Promise<void> {
    const previous = this.options.client;
    if (this.closed || next.base !== previous.base || next.rootPublicKey !== previous.rootPublicKey
      || next.certificate.networkId !== previous.certificate.networkId || next.certificate.subject !== previous.certificate.subject
      || next.identity.deviceId !== previous.identity.deviceId || next.identity.signingKey !== previous.identity.signingKey
      || next.identity.transportKey !== previous.identity.transportKey) throw new Error('AGENT_NET_IDENTITY_CHANGED');
    this.options.client = next;
    const old = this.uplink; this.uplink = null; old?.close();
    if (this.ready) this.acknowledgeHello();
    if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null; }
    try { await this.connectRelay(); } catch (error) { if (!this.closed) this.scheduleReconnect(); throw error; }
  }
  supports(deviceId: string): boolean { return this.authorized(deviceId) && (this.peers.has(deviceId) || this.roster.get(deviceId)?.online === true); }
  /** A previously certified V2 peer must not silently downgrade when its relay session disappears. */
  knowsPeer(deviceId: string): boolean { return this.knownV2.has(deviceId); }
  certificateFor(deviceId: string) { return this.roster.get(deviceId)?.certificate; }
  scopedPeerTarget(peer: string): ScopedPeerTarget | null {
    if (this.options.client.delegation) {
      const own = this.ownDelegation, target = own && delegatedPeerTarget(own, peer, 'guest');
      return target && this.authorized(target.relayId) ? target : null;
    }
    for (const [id, delegation] of this.delegations) {
      const target = this.authorized(id) && delegatedPeerTarget(delegation, peer, 'host');
      if (target) return target;
    }
    return null;
  }
  pathTo(deviceId: string): 'direct' | 'relay' | null { return this.peers.get(deviceId)?.channel.path?.() ?? null; }
  peerSnapshot(deviceId: string): { path: 'direct' | 'relay'; rttMs: number | null } | null {
    const channel = this.peers.get(deviceId)?.channel, path = channel?.path?.();
    if (!channel || !path) return null;
    const rtt = channel.stats?.()?.srttUs;
    return { path, rttMs: typeof rtt === 'number' && rtt > 0 ? rtt / 1000 : null };
  }
  async dial(deviceId: string): Promise<void> {
    if (this.closed || this.peers.has(deviceId)) return;
    const existing = this.dialing.get(deviceId); if (existing) return existing;
    const key = this.transportKey(deviceId);
    if (!key || !this.authorized(deviceId)) throw new Error('UNAUTHORIZED_PEER');
    const lan = this.lanCandidates.get(deviceId);
    const entry: RosterEntry = { id: keyHex(key), dial: { relayId: deviceId, ...(lan ? { udp: lan, preferUdp: true } : {}) } };
    const connect = async () => {
      try { return await this.transport.connect(entry); }
      catch (error) {
        if (!lan || !this.uplink || !this.authorized(deviceId) || keyHex(this.transportKey(deviceId)!) !== entry.id) throw error;
        // A remembered LAN address may belong to the previous network. Retire
        // only that candidate and retry this peer through its authenticated relay.
        if (this.lanCandidates.get(deviceId) === lan) this.lanCandidates.delete(deviceId);
        return this.transport.connect({ id: entry.id, dial: { relayId: deviceId } });
      }
    };
    const dialing = connect().then((channel) => this.adopt(channel, true));
    this.dialing.set(deviceId, dialing);
    try { await dialing; } finally { if (this.dialing.get(deviceId) === dialing) this.dialing.delete(deviceId); }
  }
  private authorized(deviceId: string): boolean {
    const delegate = this.delegations.get(deviceId);
    if (delegate) return !this.closed && Date.now() < this.rosterValidUntil
      && delegationVisibleTo(delegate, this.options.client.identity)
      && !!this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, delegate);
    const own = this.ownDelegation, endpoint = own && delegationEndpointCertificate(own, deviceId);
    if (this.options.client.delegation && (!own?.scope || !endpoint || !this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, own))) return false;
    const view = this.roster.get(deviceId), c = view?.certificate;
    return !this.closed && Date.now() < this.rosterValidUntil && !!c && c.deviceId !== this.deviceId && this.options.bindings.verifyCertificate(this.options.client.rootPublicKey, c)
      && (!endpoint || endpoint.signingKey === c.signingKey && endpoint.transportKey === c.transportKey)
      && c.networkId === this.options.client.certificate.networkId && c.subject === this.options.client.certificate.subject;
  }
  private deviceForKey(hex: string): string | undefined {
    for (const id of this.peerIds()) if (this.authorized(id) && keyHex(this.transportKey(id)!) === hex) return id;
    return undefined;
  }
  private peerIds(): string[] { return [...this.roster.keys(), ...this.delegations.keys()]; }
  private transportKey(id: string): string | undefined {
    return this.delegations.get(id)?.guestTransportKey ?? this.roster.get(id)?.certificate.transportKey;
  }
  private updateDirectory(directory: DeviceView[], live = true, grants?: Delegation[]): void {
    this.directoryRevision++;
    if (live) this.rosterValidUntil = Date.now() + CERT_LIFETIME_MS;
    const next = new Map<string, DeviceView>();
    for (const view of directory) {
      if (!view || typeof view !== 'object') continue;
      const c = view.certificate;
      if (!this.options.bindings.verifyCertificate(this.options.client.rootPublicKey, c, c?.issuedAt) || c.networkId !== this.options.client.certificate.networkId
        || c.subject !== this.options.client.certificate.subject) continue;
      next.set(c.deviceId, view);
      this.knownV2.add(c.deviceId);
    }
    this.roster = next;
    if (grants) {
      this.delegations.clear();
      if (this.options.client.delegation) this.ownDelegation = grants.find(d => d.scope
        && delegationVisibleTo(d, this.options.client.identity, this.options.client.delegation)
        && this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, d)) ?? null;
      if (this.options.scoped && !this.options.client.delegation) for (const d of grants) {
        if (d.scope && d.networkId === this.options.client.certificate.networkId
          && delegationVisibleTo(d, this.options.client.identity)
          && this.options.bindings.verifyDelegation?.(this.options.client.rootPublicKey, d)) this.delegations.set('guest:' + d.id, d);
      }
      // Resource channels must have distinct transport keys. Ambiguity cannot
      // turn one resource's Noise connection into another resource or a member.
      const keys = new Map<string, string[]>();
      for (const id of this.peerIds()) { const k = this.transportKey(id)!; keys.set(k, [...(keys.get(k) ?? []), id]); }
      for (const ids of keys.values()) if (ids.length > 1) for (const id of ids) this.delegations.delete(id);
      this.options.onDelegations?.(this.options.client.delegation ? this.ownDelegation ? [this.ownDelegation] : [] : [...this.delegations.values()]);
    }
    for (const [id, peer] of this.peers) if (peer.info && next.has(id)) {
      const view = next.get(id)!;
      peer.info = { ...peer.info, deviceName: view.name, selfName: view.selfName ?? peer.info.selfName };
      if (this.ready) this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: peer.info });
    }
    for (const id of this.lanCandidates.keys()) if (!this.authorized(id)) this.lanCandidates.delete(id);
    for (const [id, peer] of this.peers) if (!this.authorized(id) || keyHex(this.transportKey(id)!) !== peer.key) {
      this.peers.delete(id); peer.channel.close({ drain: false }); this.presence(id, false);
    }
    if (live) this.options.onDirectory?.([...next.values()]);
    if (this.ready) for (const [id, view] of next) if (!this.peers.has(id)) {
      this.presence(id, false);
      if (view.online && this.deviceId < id) void this.dial(id).catch(() => undefined);
    }
  }
  private async connectRelay(): Promise<void> {
    const generation = ++this.generation;
    let uplink: SocketUplink;
    try { uplink = await this.options.client.connect(); }
    catch (error) {
      if (/^AGENT_NET_UPGRADE_(401|403)$/.test(error instanceof Error ? error.message : '')) this.close(4410);
      throw error;
    }
    if (this.closed || generation !== this.generation) { uplink.close(); return; }
    this.uplink = uplink; this.retryMs = 500;
    this.updateDirectory(uplink.devices, true, uplink.delegations ?? []);
    this.options.onDelegationRequests?.(uplink.delegationRequests ?? []);
    uplink.onDatagram((id, data) => this.receiveDatagram?.(id, data));
    uplink.on('directory', () => {
      this.updateDirectory(uplink.devices, true, uplink.delegations ?? []);
      this.options.onDelegationRequests?.(uplink.delegationRequests ?? []);
    });
    uplink.once('close', (code: number) => {
      if (this.uplink !== uplink || this.closed) return;
      this.uplink = null;
      if ([4410, 4401, 4403].includes(code)) { this.close(4410); return; }
      this.acknowledgeHello();
      // Existing direct connections remain alive; loss of one relay does not tear down the app socket.
      this.scheduleReconnect();
    });
    if (this.localHello && !this.options.client.delegation) uplink.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
    if (this.ready) this.acknowledgeHello();
  }
  /** DeviceLinkClient accepts repeated acknowledgements to update capabilities
   * on the same application socket, without resetting authenticated peers. */
  private acknowledgeHello(): void {
    this.deliver({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
      serverProtocolVersion: PROTOCOL_VERSION, deviceId: this.deviceId, userId: this.options.userId,
      capabilities: [
        ...(this.uplink?.notifications && this.options.bindings.notify ? [SERVER_CAPABILITY_NOTIFY] : []),
        ...(this.options.scoped || this.options.client.delegation?.scope ? [SHARED_TASK_RELAY_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY] : []),
      ],
    } });
  }
  private scheduleReconnect(): void {
    if (this.closed || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.connectRelay().catch(() => this.scheduleReconnect());
    }, this.retryMs);
    unrefTimer(this.reconnect); this.retryMs = Math.min(15_000, this.retryMs * 2);
  }
  send(text: string): void {
    if (this.closed) throw new Error('AGENT_NET_SOCKET_CLOSED');
    if (utf8(text).length > MAX_FRAME_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    const frame = JSON.parse(text) as Envelope;
    if (frame.v !== PROTOCOL_VERSION) throw new Error('VERSION_MISMATCH');
    if (!this.ready) {
      if (frame.kind !== 'hello') return;
      this.localHello = frame.payload as HelloPayload; this.ready = true;
      if (!this.options.client.delegation) this.uplink?.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
      this.acknowledgeHello();
      for (const [id, view] of this.roster) if (id !== this.deviceId) {
        this.presence(id, false);
        if (view.online && this.deviceId < id) void this.dial(id).catch(() => undefined);
      }
      for (const peer of this.peers.values()) {
        if (peer.info) this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: peer.info });
        this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info() });
      }
      for (const id of this.lanCandidates.keys()) if (!this.peers.has(id)) void this.dial(id).catch(() => undefined);
      return;
    }
    if (frame.kind === 'ping') { this.deliver({ v: PROTOCOL_VERSION, kind: 'pong' }); return; }
    if (frame.kind === 'presence-set') {
      this.localHello = { ...this.localHello!, ...(frame.payload as object) };
      if (!this.options.client.delegation) this.uplink?.presence(this.localHello.remoteControlEnabled, this.localHello.capabilities ?? [], this.localHello);
      for (const peer of this.peers.values()) this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info() });
      return;
    }
    if (frame.kind === 'notify') {
      if (!this.notifying) void this.notify(frame);
      else this.reject(frame, 'BACKPRESSURE');
      return;
    }
    if (!ROUTED_KINDS.has(frame.kind)) return;
    this.route(frame);
  }
  private async notify(frame: Envelope): Promise<void> {
    if (!this.uplink?.notifications || !this.options.bindings.notify) return;
    this.notifying = true;
    try {
      const payload = frame.payload as import('@cindy/device-link-protocol').NotifyPayload;
      if (!payload || !['session-done', 'session-error', 'session-needs-reply'].includes(payload.category)
        || typeof payload.title !== 'string' || typeof payload.deepLink !== 'string' || payload.deepLink.length > 512
        || typeof payload.collapseId !== 'string') throw new Error('INVALID_NOTIFICATION');
      const recipients = [...this.roster.values()].filter(v => v.notificationKey && this.authorized(v.certificate.deviceId)
        && (!payload.targetDeviceId || v.certificate.deviceId === payload.targetDeviceId));
      // Bound work and use sequential delivery; one account cannot monopolize the relay's push pool.
      let failed = false;
      for (const recipient of recipients.slice(0, 256)) {
        this.options.assertCurrent?.();
        if (this.closed || this.notificationAbort.signal.aborted) return;
        try { await this.options.bindings.notify(recipient, payload, this.notificationAbort.signal, this.options.client); }
        catch { failed = true; }
      }
      if (failed && !this.closed) this.reject(frame, 'NOTIFICATION_DELIVERY_FAILED');
    } catch {
      if (!this.closed) this.reject(frame, 'NOTIFICATION_DELIVERY_FAILED');
    } finally { this.notifying = false; }
  }
  private route(frame: Envelope): void {
    let id = frame.dst;
    const own = this.ownDelegation;
    if (this.options.client.delegation) {
      const projected = own && scopedFrame(own, frame, 'guest', frame.dst);
      if (!projected) { this.reject(frame, 'FORBIDDEN'); return; }
      frame = projected; id = projected.dst;
    } else if (frame.sharedTask !== undefined || frame.providerShare !== undefined) {
      const match = [...this.delegations].find(([, d]) => this.authorized('guest:' + d.id) && frameMatchesDelegation(d, frame));
      const projected = match && scopedFrame(match[1], frame, 'host', this.deviceId);
      if (!match || !projected) { this.reject(frame, 'FORBIDDEN'); return; }
      id = match[0]; frame = projected;
    }
    if (!id || !this.authorized(id)) { this.reject(frame, 'DEVICE_OFFLINE'); return; }
    if (frame.id && ['invoke', 'link-open'].includes(frame.kind)) {
      for (const [request, item] of this.sentRequests) if (performance.now() - item.at > 15 * 60_000) this.sentRequests.delete(request);
      if (this.sentRequests.size >= 10_000) { this.reject(frame, 'BACKPRESSURE'); return; }
      this.sentRequests.set(frame.id, { peer: id, at: performance.now(), frame });
    }
    const peer = this.peers.get(id); if (peer) { this.write(peer, frame); return; }
    const bytes = utf8(JSON.stringify(frame)).length;
    const queue = this.pending.get(id) ?? [];
    if (queue.length >= 64 || this.bufferedAmount + bytes > MAX_CHANNEL_PENDING_BYTES) { this.reject(frame, 'BACKPRESSURE'); return; }
    queue.push({ frame, bytes }); this.pending.set(id, queue); this.pendingBytes += bytes;
    void this.dial(id).catch(() => {
      for (const item of this.pending.get(id) ?? []) { this.pendingBytes -= item.bytes; this.reject(item.frame, 'DEVICE_OFFLINE'); }
      this.pending.delete(id);
    });
  }
  private reject(frame: Envelope, code: string): void {
    if (frame.id && ['invoke', 'link-open'].includes(frame.kind)) this.sentRequests.delete(frame.id);
    this.deliver({ v: PROTOCOL_VERSION, kind: 'relay-error', ...(frame.id ? { id: frame.id } : {}),
      ...(frame.sharedTask ? { sharedTask: frame.sharedTask } : {}), ...(frame.providerShare ? { providerShare: frame.providerShare } : {}),
      payload: { code, message: code, ...(frame.dst ? { dst: frame.dst } : {}) } } as Envelope);
  }
  private adopt(channel: PeerChannel, outbound: boolean): void {
    const deviceId = this.deviceForKey(channel.remoteId);
    if (this.closed || !deviceId) { channel.close(); return; }
    const previous = this.peers.get(deviceId);
    const preferredOutbound = this.deviceId < deviceId;
    // Concurrent dials must agree on the same physical connection, rather than each closing the other's winner.
    if (previous && (previous.outbound === preferredOutbound || outbound !== preferredOutbound)) { channel.close({ drain: false }); return; }
    const peer: Peer = { deviceId, key: channel.remoteId, channel, outbound };
    this.peers.set(deviceId, peer); previous?.channel.close();
    const frames = new Frames();
    channel.onData((bytes) => {
      if (this.peers.get(deviceId) !== peer || !this.authorized(deviceId)) { channel.close(); return; }
      try { frames.push(bytes, (frame) => this.fromPeer(peer, frame)); } catch { channel.close(); }
    });
    channel.onClose(() => {
      if (this.peers.get(deviceId) !== peer) return;
      this.peers.delete(deviceId); this.presence(deviceId, false); this.options.onPathChanged?.(deviceId, null);
    });
    this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info() });
    for (const item of this.pending.get(deviceId) ?? []) { this.pendingBytes -= item.bytes; this.write(peer, item.frame); }
    this.pending.delete(deviceId); this.options.onPathChanged?.(deviceId, channel.path?.() ?? null);
  }
  private write(peer: Peer, frame: Envelope): void {
    const d = this.options.client.delegation ? this.ownDelegation : this.delegations.get(peer.deviceId);
    if (this.options.client.delegation && !d) return;
    if (d) {
      const projected = scopedFrame(d, frame, this.options.client.delegation ? 'guest' : 'host', this.options.client.delegation ? peer.deviceId : this.deviceId);
      if (!projected) return;
      frame = projected;
    }
    const body = utf8(JSON.stringify(frame));
    if (body.length > MAX_FRAME_BYTES) { this.reject(frame, 'PAYLOAD_TOO_LARGE'); return; }
    if (this.bufferedAmount + body.length + 4 > MAX_CHANNEL_PENDING_BYTES) {
      if (frame.id) this.sentRequests.delete(frame.id);
      this.reject(frame, 'BACKPRESSURE'); return;
    }
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, body.length, false);
    try { peer.channel.send(concatBytes([prefix, body])); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BACKPRESSURE')) throw error;
      if (frame.id) this.sentRequests.delete(frame.id);
      this.reject(frame, 'BACKPRESSURE');
    }
  }
  private info(): PresenceSnapshot {
    return { ...this.localHello, deviceId: this.deviceId, deviceName: this.localHello?.deviceName ?? '',
      platform: this.localHello?.platform ?? '', appVersion: this.localHello?.appVersion ?? '', online: true,
      remoteControlEnabled: this.localHello?.remoteControlEnabled ?? false, busy: this.localHello?.busy ?? false, lastSeenAt: Date.now() };
  }
  private presence(deviceId: string, online: boolean): void {
    if (this.options.client.delegation || this.delegations.has(deviceId) || deviceId.startsWith('guest:')) return;
    if (deviceId === this.deviceId) return;
    const view = this.roster.get(deviceId);
    this.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { deviceId, deviceName: view?.name ?? '', selfName: view?.selfName,
      online, remoteControlEnabled: online && (view?.remoteControlEnabled ?? false), platform: view?.platform ?? '',
      appVersion: view?.appVersion ?? '', busy: online && !!view?.busy, lastSeenAt: view?.lastSeenAt ?? Date.now() } });
  }
  private fromPeer(peer: Peer, frame: Envelope): void {
    const d = this.options.client.delegation ? this.ownDelegation : this.delegations.get(peer.deviceId);
    if (this.options.client.delegation && !d) return;
    if (d && frame.kind === 'presence-changed') return;
    if (frame.kind === 'presence-changed') {
      const reported = frame.payload as PresenceSnapshot, view = this.roster.get(peer.deviceId);
      peer.info = { ...reported, deviceName: view?.name ?? reported.deviceName, selfName: reported.selfName ?? reported.deviceName,
        deviceId: peer.deviceId, online: true, lastSeenAt: Date.now() };
      this.deliver({ ...frame, payload: peer.info });
      return;
    }
    if (frame.kind === 'relay-error') {
      const request = frame.id && this.sentRequests.get(frame.id);
      if (!request || request.peer !== peer.deviceId) return;
      this.deliver({ ...frame, sharedTask: request.frame.sharedTask, providerShare: request.frame.providerShare,
        src: peer.deviceId, payload: { ...(frame.payload as object), dst: request.frame.dst } }); return;
    }
    if (d) {
      const projected = scopedFrame(d, frame, this.options.client.delegation ? 'host' : 'guest', this.options.client.delegation ? peer.deviceId : this.deviceId);
      if (!projected) return;
      if (frame.id && ['invoke-result', 'link-accept'].includes(frame.kind)) this.sentRequests.delete(frame.id);
      this.deliver(projected); return;
    }
    if (frame.sharedTask !== undefined || frame.providerShare !== undefined) return;
    if (!ROUTED_KINDS.has(frame.kind) || frame.dst !== this.deviceId) return;
    if (CONTROL_KINDS.has(frame.kind) && !this.localHello?.remoteControlEnabled) {
      this.write(peer, { v: PROTOCOL_VERSION, kind: 'relay-error', id: frame.id, payload: {
        code: 'REMOTE_DISABLED', message: 'REMOTE_DISABLED', dst: this.deviceId,
      } } as Envelope); return;
    }
    if (frame.id && ['invoke-result', 'link-accept'].includes(frame.kind)) this.sentRequests.delete(frame.id);
    this.deliver({ ...frame, src: peer.deviceId });
  }
  private deliver(frame: Envelope): void {
    if (!this.closed && this.ready) this.emit('message', { toString: () => JSON.stringify(frame) });
  }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true; this.generation++;
    this.notificationAbort.abort();
    this.lan?.close(); this.lan = null; this.lanCandidates.clear();
    if (this.directoryRefresh) clearInterval(this.directoryRefresh); this.directoryRefresh = undefined;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null; this.uplink?.close(); this.uplink = null;
    for (const peer of this.peers.values()) peer.channel.close();
    this.peers.clear(); this.pending.clear(); this.pendingBytes = 0; this.sentRequests.clear();
    void this.transport?.close().catch(() => undefined);
    setTimeout(() => this.emit('close', code, ''), 0);
  }
  terminate(): void { this.close(1006); }
}
