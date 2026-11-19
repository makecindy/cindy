import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import WebSocket from 'ws';
import type { AgentNetClient } from '@cindy/agent-net-relay/client';
import { delegationVisibleTo, type DeviceCertificate, type DeviceView, type Delegation } from '@cindy/agent-net-protocol';
import { DatagramSendQueue, verifyDelegation } from '@cindy/agent-net-relay';
import { delegatedPeerTarget, type ScopedPeerTarget } from './scopedRoutes.js';
import { MAX_CONTROL_BYTES } from '@cindy/agent-net-protocol';
import { shortDeviceRef } from '@cindy/device-link';
import type { AgentNetSocketOptions } from './socket.js';
import type { PeerRule } from './socketPorts.js';
import { DRAIN_LOW_WATER_BYTES, type RelayRoute } from './types.js';
import type { SessionConfig, SessionHandle } from './session/peer.js';
import { WorkerSessions } from './session/workerSessions.js';

export type AgentNetAppSocket = Pick<import('./socket.js').AgentNetSocket,
  'send' | 'close' | 'terminate' | 'bufferedAmount' | 'onDrain' | 'deviceId' |
  'replaceClient' | 'supports' | 'knowsPeer' | 'certificateFor' | 'scopedPeerTarget' | 'pathTo' | 'peerSnapshot'> & {
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    removeListener(event: string, listener: (...args: any[]) => void): void;
    /** Agent-Net sessions (session/peer.ts); optional so other implementations of this socket need not have them. */
    useSessions?(config: SessionConfig): void;
    /**
     * The certificate a known device last had in this socket's signed directory, also after it left the directory (revoked).
     * Only to check that device's own signed statement that its Agent-Net is off; `certificateFor` is the current directory.
     */
    lastKnownCertificateFor?(id: string): DeviceCertificate | undefined;
    /** This computer changed networks (see AgentNetWorkerSocket.networkChanged). */
    networkChanged?(): void;
    /** A relay connection of this socket is open now (see AgentNetWorkerSocket.relayConnected; event `relay`). */
    relayConnected?(): boolean;
    /** The last round trip to the relay, in ms (see AgentNetWorkerSocket.relayRttMs). */
    relayRttMs?(): number | null;
    /** How relayed datagrams travel now, UDP or WebSocket, with that path's round trip (see AgentNetWorkerSocket.relayRoute; event `relay-route`). */
    relayRoute?(): RelayRoute | null;
    /** By session key: the device id, or inside a delegation the scoped peer it names (see `SessionConfig.handlers`). */
    session?(key: string): SessionHandle | null;
    onSession?(listener: (key: string, session: SessionHandle) => void): void;
    /** The connection the live session for this key runs on, for its path and round trip (`pathTo`, `peerSnapshot`). */
    sessionDevice?(key: string): string | null;
    /** See `PortableSocket.connectSession`. */
    connectSession?(key: string): Promise<boolean>;
    /** See `PortableSocket.restrictPeers`. */
    restrictPeers?(rule: PeerRule): void;
  };
export function workerClient(client: AgentNetClient) {
  return { base: client.base, identity: client.identity, certificate: client.certificate, rootPublicKey: client.rootPublicKey,
    delegation: client.delegation, ownerPinnedHttp: client.transport.ownerPinnedHttp };
}
/** Plain-text lines for the host log. Device ids are shortened; no addresses, keys or payloads. */
export interface AgentNetSocketLog {
  info(message: string): void;
  warn(message: string): void;
}
export interface AgentNetUplinkKeepalive {
  /** How often Main pings the relay connection. */
  intervalMs: number;
  /** No pong for this long means the connection no longer carries our data. */
  timeoutMs: number;
}
/**
 * The device-link heartbeat is answered inside the worker and never reaches the relay, so it cannot
 * notice a relay connection that still receives but no longer gets our data through (2026-11-13: a
 * lossy uplink queued ~100s of data; peers saw this computer as offline for 9 and 15 minutes until a
 * manual restart / the relay closed it, and recovered within a second of reconnecting).
 * A WebSocket ping must pass through that same queue, so only a pong proves the outbound direction.
 * Agent-Net's peer connections time out after about 30s without traffic, so a relay connection
 * whose round trip exceeds this budget is already useless to them. Standard WebSocket control frames:
 * official and self-hosted relays answer them already; no protocol change.
 */
export const AGENT_NET_UPLINK_KEEPALIVE: AgentNetUplinkKeepalive = { intervalMs: 15_000, timeoutMs: 45_000 };
/**
 * After a network change a relay connection must answer a ping within this long, or it is replaced. The same budget as
 * Device Link's network probe (its handshake timeout, 15 s): the regular keepalive would take up to 45 s.
 */
export const AGENT_NET_NETWORK_CHANGE_PROBE_MS = 15_000;
/** Bytes Main lets wait in one relay WebSocket; on top of it the queue-delay limit in DatagramSendQueue applies. */
const RELAY_SEND_BUFFER_CAP_BYTES = 1024 * 1024;
export type AgentNetWorkerSocketOptions = AgentNetSocketOptions & {
  log?: AgentNetSocketLog;
  uplinkKeepalive?: AgentNetUplinkKeepalive;
  /** See MAX_DATAGRAM_QUEUE_DELAY_MS; only tests shorten it. */
  uplinkMaxQueueDelayMs?: number;
  /** See AGENT_NET_NETWORK_CHANGE_PROBE_MS; only tests shorten it. */
  networkChangeProbeMs?: number;
};

interface PeerStatus {
  available: boolean;
  path: 'direct' | 'relay' | null;
  rttMs: number | null;
  dialing: boolean;
}

function peerRoute(status: PeerStatus | undefined): 'direct' | 'relay' | 'connecting' | null {
  if (status?.available && status.path) return status.path;
  return status?.dialing ? 'connecting' : null;
}

function peerRoutesChanged(previous: ReadonlyMap<string, PeerStatus>, next: ReadonlyMap<string, PeerStatus>): boolean {
  for (const [id, status] of next) if (peerRoute(status) !== peerRoute(previous.get(id))) return true;
  for (const [id, status] of previous) if (!next.has(id) && peerRoute(status)) return true;
  return false;
}

/** The encrypted transport/parser runs off Main; privileged outbound sockets retain the host's proxy policy. */
/** `terminate()` 后 worker 最多再跑这么久（毫秒），把关闭包发出去；端点自己最多等 250 毫秒（agent-net-core 的 CLOSE_DRAIN_MS）。 */
const TERMINATE_DRAIN_MS = 500;

export class AgentNetWorkerSocket extends EventEmitter implements AgentNetAppSocket {
  private worker!: Worker;
  private readonly network = new Map<number, WebSocket>();
  private readonly http = new Map<number, AbortController>();
  private readonly known = new Set<string>();
  private directory = new Map<string, DeviceCertificate>();
  /** Every device's latest certificate seen in a directory on this socket, kept when it leaves (see `lastKnownCertificateFor`). */
  private lastCertificates = new Map<string, DeviceCertificate>();
  private delegations: Delegation[] = [];
  private status = new Map<string, PeerStatus>();
  private queued = 0;
  private remoteQueued = 0;
  private closed = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private request = 0;
  private readonly renewals = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** Last logged route per peer, so the log records changes rather than every status snapshot. */
  private readonly loggedPaths = new Map<string, 'direct' | 'relay' | null>();
  private readonly relayQueues = new WeakMap<WebSocket, DatagramSendQueue>();
  /** Sessions run in the worker beside the core; this side gets decoded messages (session/workerSessions.ts). */
  private readonly sessions = new WorkerSessions((message) => { if (!this.closed) this.worker.postMessage(message); },
    (deviceId, session) => this.emit('session', deviceId, session));
  private constructor(private readonly options: AgentNetWorkerSocketOptions, private client: AgentNetClient) { super(); }
  static async open(options: AgentNetWorkerSocketOptions & { workerFile: string | URL }): Promise<AgentNetWorkerSocket> {
    options.assertCurrent?.();
    const socket = new AgentNetWorkerSocket(options, options.client);
    socket.worker = new Worker(options.workerFile, { resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AGENT_NET_WORKER_START_TIMEOUT')), 15_000); timer.unref();
      const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      socket.worker.on('message', (message) => {
        try {
        options.assertCurrent?.();
        if (message.type === 'ready') { finish(); return; }
        if (message.type === 'failed') { finish(new Error(message.code)); socket.dispose(4410); return; }
        socket.receive(message);
        // 账号或 Agent-Net 设置变了：不再把这个 worker 的消息交给 Main，但让它把关闭包发出去（terminate）。
        } catch { finish(new Error('AGENT_NET_OWNER_CHANGED')); socket.terminate(); }
      });
      socket.worker.once('error', () => { finish(new Error('AGENT_NET_WORKER_FAILED')); socket.dispose(1006); });
      socket.worker.once('exit', () => { finish(new Error('AGENT_NET_WORKER_EXITED')); socket.dispose(1006); });
    });
    const { onDirectory: _directory, onDelegationRequests: _requests, onDelegations: _grants, onPathChanged: _path, tap: _tap, client: _client, workerFile: _file, assertCurrent: _guard,
      log: _log, uplinkKeepalive: _keepalive, uplinkMaxQueueDelayMs: _queueDelay, networkChangeProbeMs: _probe, ...portable } = options;
    socket.worker.postMessage({ type: 'init', options: portable, client: workerClient(options.client), tap: !!options.tap });
    try { await ready; setImmediate(() => { if (!socket.closed) socket.emit('open'); }); return socket; }
    catch (error) { socket.dispose(1006); throw error; }
  }
  get deviceId() { return this.client.identity.deviceId; }
  /** See PortableSocket.useSessions. Off until called; Device Link frames on this socket are unaffected either way. */
  useSessions(config: SessionConfig): void { if (!this.closed) this.sessions.use(config); }
  session(key: string): SessionHandle | null { return this.closed ? null : this.sessions.session(key); }
  onSession(listener: (key: string, session: SessionHandle) => void): void { this.on('session', listener); }
  sessionDevice(key: string): string | null { return this.closed ? null : this.sessions.device(key); }
  connectSession(key: string): Promise<boolean> { return this.closed ? Promise.resolve(false) : this.sessions.connect(key); }
  /**
   * This computer changed networks (2026-11-17 review: Agent-Net did not hear of it; Device Link probes its relay at once).
   * Each relay connection is pinged now and replaced without a pong in time; the worker's peer connections send from the new
   * address right away, so the peer follows, and gather candidates again.
   */
  networkChanged(): void {
    if (this.closed) return;
    for (const ws of this.network.values()) this.probeRelayConnection(ws);
    this.worker.postMessage({ type: 'network-changed' });
  }
  private readonly probing = new WeakSet<WebSocket>();
  /** Relay connections open now. The socket stays open without one (direct peers keep working); `relay` reports the change. */
  private relayOpen = 0;
  /**
   * This socket has an open relay connection. Without one the Desktop still reaches the peers it is connected to directly, but
   * not the others, and phones get no pushes; it says so in its connection status (2026-11-17 review: it showed online).
   */
  relayConnected(): boolean { return this.relayOpen > 0; }
  /**
   * The last ping round trip on a relay connection, in ms; null while none is open or before the first pong. The remote
   * connection page shows it as the relay's round trip while relayed datagrams use the WebSocket (2026-11-17: it was always
   * empty); over UDP it shows that path's own round trip instead (`relayRoute`).
   */
  relayRttMs(): number | null { return this.relayOpen > 0 ? this.relayRtt : null; }
  private relayRtt: number | null = null;
  /** What the worker last reported about relayed datagrams (`status` messages, about once a second). */
  private relayVia: RelayRoute['via'] = 'websocket';
  private relayUdpRtt: number | null = null;
  /**
   * How datagrams relayed for this computer travel now — the relay's UDP port or this relay WebSocket — and the last round
   * trip on that path: the UDP registration round trip, or the WebSocket ping. Null while no relay connection is open.
   * The remote connection page writes both on the relay point (2026-11-18 owner: it could not tell Agent-Net over UDP from
   * the WebSocket fallback, and showed the WebSocket's round trip while the data went over UDP).
   */
  relayRoute(): RelayRoute | null {
    if (this.closed || this.relayOpen === 0) return null;
    return this.relayVia === 'udp' ? { via: 'udp', rttMs: this.relayUdpRtt } : { via: 'websocket', rttMs: this.relayRtt };
  }
  private noteRelayRoute(route: unknown): void {
    const reported = route && typeof route === 'object' ? route as Partial<RelayRoute> : null;
    const via: RelayRoute['via'] = reported?.via === 'udp' ? 'udp' : 'websocket';
    const rtt = via === 'udp' ? reported?.rttMs : null;
    this.relayUdpRtt = typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 ? rtt : null;
    if (via === this.relayVia) return;
    this.relayVia = via;
    this.options.log?.info(`agent-net relayed datagrams now go over the relay ${via === 'udp' ? 'UDP port' : 'WebSocket'}`);
    this.emit('relay-route', via);
  }
  private readonly pingSentAt = new WeakMap<WebSocket, number>();
  private pingRelay(ws: WebSocket): void {
    this.pingSentAt.set(ws, performance.now());
    ws.ping();
  }
  private relayCounted(delta: 1 | -1): void {
    const before = this.relayOpen > 0;
    this.relayOpen = Math.max(0, this.relayOpen + delta);
    if (!this.closed && before !== this.relayOpen > 0) this.emit('relay', this.relayOpen > 0);
  }
  private probeRelayConnection(ws: WebSocket): void {
    if (typeof ws.ping !== 'function' || ws.readyState !== WebSocket.OPEN || this.probing.has(ws)) return;
    this.probing.add(ws);
    let answered = false;
    const pong = () => { answered = true; };
    ws.once('pong', pong);
    const timer = setTimeout(() => {
      this.probing.delete(ws); ws.off('pong', pong);
      if (answered || this.closed || ws.readyState !== WebSocket.OPEN) return;
      this.options.log?.warn('agent-net relay connection did not answer after a network change; reconnecting');
      ws.terminate();
    }, this.options.networkChangeProbeMs ?? AGENT_NET_NETWORK_CHANGE_PROBE_MS);
    (timer as { unref?: () => void }).unref?.();
    try { this.pingRelay(ws); } catch { /* The close event follows. */ }
  }
  restrictPeers(rule: PeerRule): void {
    if (!this.closed) this.worker.postMessage({ type: 'restrict', rule: { allowed: rule.allowed && [...rule.allowed], refused: [...rule.refused] } });
  }
  get bufferedAmount() { return this.queued + this.remoteQueued; }
  /** See PortableSocket.onDrain: fires when `bufferedAmount` falls back to DRAIN_LOW_WATER_BYTES after having been above. */
  onDrain(listener: () => void): void { this.on('drain', listener); }
  private drainArmed = false;
  private drained(): void {
    if (!this.drainArmed || this.closed || this.bufferedAmount > DRAIN_LOW_WATER_BYTES) return;
    this.drainArmed = false;
    this.emit('drain');
  }
  private setRemoteQueued(queued: number): void {
    const before = this.remoteQueued;
    this.remoteQueued = queued;
    if (queued < before) this.drained();
  }
  knowsPeer(id: string) { return this.known.has(id); }
  supports(id: string) { return !this.closed && this.status.get(id)?.available === true; }
  certificateFor(id: string) { return this.directory.get(id); }
  lastKnownCertificateFor(id: string) { return this.directory.get(id) ?? this.lastCertificates.get(id); }
  scopedPeerTarget(peer: string): ScopedPeerTarget | null {
    this.options.assertCurrent?.();
    if (this.closed || this.closeTimer) return null;
    const own = this.client.delegation && this.delegations.find(d => delegationVisibleTo(d, this.client.identity, this.client.delegation));
    if (this.client.delegation) return own && verifyDelegation(this.client.rootPublicKey, own) ? delegatedPeerTarget(own, peer, 'guest') : null;
    for (const delegation of this.delegations) {
      // Each task sweep looks up one guest. Check the peer before revalidating
      // certificate lifetimes and signatures in the authenticated snapshot.
      const target = delegatedPeerTarget(delegation, peer, 'host');
      if (target && delegationVisibleTo(delegation, this.client.identity)
        && verifyDelegation(this.client.rootPublicKey, delegation)) return target;
    }
    return null;
  }
  /** `id`: a device, or a session key (its session's connection). */
  pathTo(id: string) { return this.status.get(this.sessions.device(id) ?? id)?.path ?? null; }
  peerSnapshot(id: string) {
    const status = this.status.get(this.sessions.device(id) ?? id);
    return status?.path ? { path: status.path, rttMs: status.rttMs } : null;
  }
  /** Actual and in-progress transport routes to devices in this account's directory. */
  peerRoutes(): Array<{ deviceId: string; path: 'direct' | 'relay' | 'connecting'; rttMs: number | null }> {
    if (this.closed || this.closeTimer) return [];
    const routes = [];
    for (const [deviceId, status] of this.status) {
      if (deviceId === this.deviceId || !this.directory.has(deviceId)) continue;
      const path = peerRoute(status);
      if (path) routes.push({ deviceId, path, rttMs: status.rttMs });
    }
    return routes;
  }
  send(frame: string): void {
    this.options.assertCurrent?.();
    const bytes = Buffer.byteLength(frame);
    if (this.closed) throw new Error('AGENT_NET_SOCKET_CLOSED');
    if (bytes > 2 * 1024 * 1024 || this.queued + bytes > 8 * 1024 * 1024) throw new Error('BACKPRESSURE');
    this.queued += bytes; this.worker.postMessage({ type: 'frame', frame, bytes });
    if (this.bufferedAmount > DRAIN_LOW_WATER_BYTES) this.drainArmed = true;
  }
  replaceClient(next: AgentNetClient): Promise<void> {
    this.options.assertCurrent?.();
    if (this.closed || this.renewals.size) return Promise.reject(new Error('AGENT_NET_SOCKET_CLOSED'));
    const id = ++this.request;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.renewals.delete(id); reject(new Error('AGENT_NET_RENEW_TIMEOUT')); }, 15_000); timer.unref();
      this.renewals.set(id, { resolve: () => { this.client = next; resolve(); }, reject, timer });
      this.worker.postMessage({ type: 'renew', id, client: workerClient(next) });
    });
  }
  private receive(message: any): void {
    // 已经报告关闭、还在等 worker 发完关闭包（见 terminate）：它关完就结束线程。
    if (this.closed) { if (message?.type === 'closed') void this.worker.terminate(); return; }
    if (this.sessions.receive(message)) return;
    if (message.type === 'http-request') { void this.controlRequest(message); return; }
    if (message.type === 'http-cancel') { this.http.get(message.id)?.abort(); return; }
    if (message.type === 'ack') { this.queued = Math.max(0, this.queued - message.bytes); this.drained(); return; }
    if (message.type === 'renewed') {
      const pending = this.renewals.get(message.id); if (!pending) return;
      this.renewals.delete(message.id); clearTimeout(pending.timer);
      if (message.code) pending.reject(new Error(message.code)); else pending.resolve(); return;
    }
    if (message.type === 'closed') { this.dispose(message.code); return; }
    if (message.type === 'delegation-requests') { this.options.onDelegationRequests?.(message.requests); return; }
    if (message.type === 'delegations') {
      this.delegations = Array.isArray(message.delegations) ? message.delegations.filter((d: unknown): d is Delegation =>
        verifyDelegation(this.client.rootPublicKey, d) && d.networkId === this.client.certificate.networkId
        && delegationVisibleTo(d, this.client.identity, this.client.delegation)) : [];
      this.options.onDelegations?.(this.delegations); return;
    }
    if (message.type === 'directory') {
      const directory = message.directory as DeviceView[];
      this.directory = new Map(directory.map((view) => [view.certificate.deviceId, view.certificate]));
      for (const view of directory) { this.known.add(view.certificate.deviceId); this.lastCertificates.set(view.certificate.deviceId, view.certificate); }
      if (!message.cached) this.options.onDirectory?.(directory); return;
    }
    if (message.type === 'status') {
      this.setRemoteQueued(message.queued);
      const previous = this.status;
      this.status = new Map(message.peers);
      for (const id of message.known) this.known.add(id);
      this.noteRelayRoute(message.relayRoute);
      if (this.listenerCount('peer-routes-changed') && peerRoutesChanged(previous, this.status)) this.emit('peer-routes-changed');
      return;
    }
    if (message.type === 'buffered') { this.setRemoteQueued(message.queued); return; }
    if (message.type === 'path') { this.logPath(message.id, message.path); this.options.onPathChanged?.(message.id, message.path); return; }
    if (message.type === 'frame-in') { this.emit('message', { toString: () => message.frame }); return; }
    if (message.type === 'tap') { this.options.tap?.(message.data, message.via); return; }
    if (message.type === 'ws-open') {
      const expected = this.client.base.replace(/^http/, 'ws') + this.client.path('/ws');
      if (message.url !== expected || this.network.size >= 4 || this.network.has(message.id)) { this.dispose(1006); return; }
      const factory = this.client.transport.createWebSocket ?? ((url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options));
      void Promise.resolve(factory(message.url, { headers: message.headers, maxPayload: MAX_CONTROL_BYTES })).then((ws) => {
        // The factory is async, so this socket may already be closed (e.g. device-link discarding it
        // on system resume). The new ws is still CONNECTING: terminate() then emits 'error' on the
        // next tick, and without a listener EventEmitter throws it as Main's uncaughtException.
        const discard = () => { ws.on('error', () => {}); ws.terminate(); };
        try { this.options.assertCurrent?.(); } catch { discard(); this.terminate(); return; }
        if (this.closed) { discard(); return; }
        this.network.set(message.id, ws);
        const relay = (event: string, value?: unknown, binary?: boolean) => { if (!this.closed) this.worker.postMessage({ type: 'ws-event', id: message.id, event, value, binary }); };
        let opened = false;
        ws.on('open', () => {
          opened = true;
          this.relayCounted(1);
          this.options.log?.info(`agent-net relay connection opened (${this.network.size} open)`);
          this.watchRelayConnection(ws);
          relay('open');
        });
        ws.on('message', (value, binary) => relay('message', new Uint8Array(Buffer.isBuffer(value) ? value : Buffer.from(value as ArrayBuffer)), binary));
        ws.on('error', () => relay('error'));
        ws.on('unexpected-response', (_req, response) => {
          response.resume();
          this.options.log?.warn(`agent-net relay connection refused status=${response.statusCode}`);
          relay('unexpected-response', response.statusCode);
        });
        ws.on('close', (code) => {
          this.network.delete(message.id);
          if (opened) this.relayCounted(-1);
          if (!this.closed) this.options.log?.info(`agent-net relay connection ${opened ? 'closed' : 'failed'} code=${code}`);
          relay('close', code);
        });
      }).catch(() => { if (!this.closed) this.worker.postMessage({ type: 'ws-event', id: message.id, event: 'error' }); });
      return;
    }
    const ws = this.network.get(message.id);
    if (message.type === 'ws-close') { ws?.terminate(); this.network.delete(message.id); }
    else if (message.type === 'ws-send' && ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < RELAY_SEND_BUFFER_CAP_BYTES) {
      this.sendToRelay(ws, message.data);
    }
  }
  /** Presence text bypasses the queue-age check; new datagrams stop joining a stalled queue. */
  private sendToRelay(ws: WebSocket, data: string | Uint8Array): void {
    let queue = this.relayQueues.get(ws);
    if (!queue) {
      queue = new DatagramSendQueue(ws, {
        stalled: (waitedMs, bufferedBytes) => this.options.log?.warn(`agent-net relay send queue has not moved for ${Math.round(waitedMs)}ms`
          + ` (${bufferedBytes} bytes waiting); dropping new datagrams until it does, the transport resends them`),
        moving: (dropped, droppedBytes, bufferedBytes) => {
          if (!this.closed) this.options.log?.info(`agent-net relay send queue moving again; dropped ${dropped} datagrams`
            + ` (${Math.round(droppedBytes / 1024)} KiB, ${bufferedBytes} bytes still waiting)`);
        },
      }, this.options.uplinkMaxQueueDelayMs);
      this.relayQueues.set(ws, queue);
    }
    if (typeof data === 'string') queue.sendControl(data);
    else queue.sendDatagram(Buffer.from(data));
  }
  /** Pings an open relay connection; without a pong in time it is closed, and the worker's
   * normal relay reconnect takes over. Peer connections survive the swap. */
  private watchRelayConnection(ws: WebSocket): void {
    if (typeof ws.ping !== 'function') return;
    const { intervalMs, timeoutMs } = this.options.uplinkKeepalive ?? AGENT_NET_UPLINK_KEEPALIVE;
    let lastPongAt = performance.now(), lastTickAt = lastPongAt;
    ws.on('pong', () => {
      lastPongAt = performance.now();
      const sent = this.pingSentAt.get(ws);
      if (sent !== undefined) { this.pingSentAt.delete(ws); this.relayRtt = Math.round(lastPongAt - sent); }
    });
    // A first round trip right away, so the remote connection page has it before the first keepalive.
    try { this.pingRelay(ws); } catch { /* The close event follows. */ }
    const timer = setInterval(() => {
      const now = performance.now();
      // A late timer (Main busy, system resumed) is not evidence that pongs went missing: start over.
      if (now - lastTickAt > intervalMs * 2) lastPongAt = now;
      lastTickAt = now;
      if (this.closed || ws.readyState !== WebSocket.OPEN) { clearInterval(timer); return; }
      const silentMs = now - lastPongAt;
      if (silentMs >= timeoutMs) {
        clearInterval(timer);
        this.options.log?.warn(`agent-net relay connection is not answering (no pong for ${Math.round(silentMs)}ms,`
          + ` ${ws.bufferedAmount} bytes waiting to be sent); reconnecting`);
        ws.terminate();
        return;
      }
      try { this.pingRelay(ws); } catch { /* The close event follows. */ }
    }, intervalMs);
    timer.unref?.();
    ws.once('close', () => clearInterval(timer));
  }
  private logPath(id: unknown, path: unknown): void {
    if (typeof id !== 'string' || !this.options.log) return;
    const next = path === 'direct' || path === 'relay' ? path : null;
    if (this.loggedPaths.has(id) && this.loggedPaths.get(id) === next) return;
    // A peer that was never connected has nothing to report when it is not connected.
    if (!this.loggedPaths.has(id) && next === null) return;
    this.loggedPaths.set(id, next);
    this.options.log.info(`agent-net peer ${shortDeviceRef(id)} ${next ? `connected via ${next}` : 'disconnected'}`);
  }
  private async controlRequest(message: any): Promise<void> {
    const controller = new AbortController();
    try {
      this.options.assertCurrent?.();
      // The worker can request only its fixed selected origin and these public
      // control operations. It cannot turn the Main proxy into arbitrary fetch.
      const expected = message.method === 'GET' ? this.client.path('/directory')
        : message.method === 'POST' ? this.client.path('/notify') : null;
      if (!expected || message.url !== this.client.base + expected || this.http.size >= 4 || this.http.has(message.id)
        || (message.body !== undefined && (typeof message.body !== 'string' || Buffer.byteLength(message.body) > 16_384))) {
        throw new Error('AGENT_NET_INVALID_CONTROL_REQUEST');
      }
      this.http.set(message.id, controller);
      const response = await (this.client.transport.fetch ?? fetch)(message.url, { method: message.method,
        headers: message.headers, ...(message.body ? { body: message.body } : {}), redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      const parts: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader) while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_CONTROL_BYTES) throw new Error('AGENT_NET_CONTROL_TOO_LARGE');
          parts.push(chunk.value);
        }
      } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      this.options.assertCurrent?.();
      if (!this.closed && !controller.signal.aborted) this.worker.postMessage({ type: 'http-result', id: message.id,
        status: response.status, body: new Uint8Array(Buffer.concat(parts)) });
    } catch {
      if (!this.closed) this.worker.postMessage({ type: 'http-result', id: message.id, error: true });
    } finally { if (this.http.get(message.id) === controller) this.http.delete(message.id); }
  }
  private dispose(code: number, drainWorker = false) {
    if (this.closed) return; this.closed = true;
    this.options.log?.info(`agent-net socket closed code=${code}`);
    this.loggedPaths.clear();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    for (const request of this.http.values()) request.abort(); this.http.clear();
    for (const ws of this.network.values()) ws.terminate(); this.network.clear();
    for (const request of this.renewals.values()) { clearTimeout(request.timer); request.reject(new Error('AGENT_NET_SOCKET_CLOSED')); }
    this.renewals.clear(); this.status.clear(); this.delegations = []; this.queued = 0; this.remoteQueued = 0;
    this.sessions.closeAll('DEVICE_OFFLINE');
    if (drainWorker) setTimeout(() => void this.worker.terminate(), TERMINATE_DRAIN_MS).unref();
    else void this.worker.terminate();
    setImmediate(() => this.emit('close', code, ''));
  }
  close(code = 1000) { if (!this.closed && !this.closeTimer) { this.worker.postMessage({ type: 'close', code }); this.closeTimer = setTimeout(() => this.dispose(code), 2000); this.closeTimer.unref(); } }
  /**
   * Device Link 拆连接（关 Agent-Net、换中转、换账号）时用：马上报告关闭，但先让 worker 把各条连接的关闭包发出去，
   * 直连的对端马上知道、不用等约 30 秒判断断开；worker 报告关完就结束线程，最多等 {@link TERMINATE_DRAIN_MS}。
   */
  terminate() {
    if (this.closed) return;
    if (!this.closeTimer) this.worker.postMessage({ type: 'close', code: 1006 });
    this.dispose(1006, true);
  }
}
