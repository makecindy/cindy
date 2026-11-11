/**
 * EdgeHub 原型：节点内嵌的迷你中转。对 DeviceLinkClient 它就是一条 WebSocket，
 * 语义照搬 packages/device-link-relay/src/hub.ts；区别是帧不去服务器，而是按目标设备走点对点传输
 * （`transport.ts`：第 6 步起默认是自研核心，QUIC 留作对照）。
 * 这里只验证接缝是否成立，不是产品实现：名册写死、没有加密封装回退、没有上游 WSS 合并。
 */
import {
  CONTROL_KINDS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ROUTED_KINDS,
  type Envelope,
  type PresenceSnapshot,
} from '@cindy/device-link-protocol';
import type { KeyObject } from 'node:crypto';
import type { WsLike } from '../../packages/device-link/src/client';
import type { RelayUplink } from './relay-client.ts';
import { createTransport, type PeerChannel, type RosterEntry, type Transport, type TransportKind } from './transport.ts';

interface NodeInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  remoteControlEnabled: boolean;
  busy: boolean;
}

interface PeerLink {
  deviceId: string;
  channel: PeerChannel;
  info: NodeInfo | null;
}

class EdgeSocket implements WsLike {
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  private closed = false;

  constructor(private readonly hub: EdgeHub) {
    setImmediate(() => this.emit('open'));
  }
  on(event: string, cb: (...args: any[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    this.hub.fromClient(data);
  }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit('close', code, reason));
  }
  terminate(): void {
    this.close(1006, 'terminated');
  }
  deliver(frame: Envelope): void {
    if (this.closed) return;
    const text = JSON.stringify(frame);
    this.emit('message', { toString: () => text });
  }
}

/** 字节流上的帧：4 字节大端长度加 JSON。 */
class FrameReader {
  private buffered: Buffer[] = [];
  private size = 0;
  private expected: number | null = null;

  push(bytes: Uint8Array, onFrame: (frame: Envelope) => void): void {
    this.buffered.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.size += bytes.byteLength;
    for (;;) {
      if (this.expected === null) {
        if (this.size < 4) return;
        this.expected = this.take(4).readUInt32BE(0);
      }
      if (this.size < this.expected) return;
      const body = this.take(this.expected);
      this.expected = null;
      onFrame(JSON.parse(body.toString('utf8')) as Envelope);
    }
  }

  /** 从前面取 `n` 个字节，一帧最多拼接一次。 */
  private take(n: number): Buffer {
    this.size -= n;
    const first = this.buffered[0];
    if (first.length >= n) {
      if (first.length === n) this.buffered.shift();
      else this.buffered[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const all = Buffer.concat(this.buffered);
    this.buffered = all.length > n ? [all.subarray(n)] : [];
    return all.subarray(0, n);
  }
}

export interface EdgeHubOptions {
  /** V2 directory certificate binds this exact Noise identity. */
  identity?: KeyObject;
  deviceId: string;
  userId: string;
  roster: Map<string, RosterEntry>;
  transport?: TransportKind;
  /** 线上的每个数据报，见 `TransportOptions.tap`。 */
  tap?: (datagram: Uint8Array, via: 'udp' | 'relay') => void;
  /** 经中转转发数据报（第 7 步），见 `TransportOptions.relay`。 */
  relay?: { uplink: RelayUplink; deviceId: string };
  /** `false` 时不用 UDP，只走中转。 */
  udp?: boolean;
  reprobeMs?: number;
  bindAddress?: string;
  stunServers?: string[];
}

export class EdgeHub {
  private transport!: Transport;
  private socket: EdgeSocket | null = null;
  private ready = false;
  private readonly peers = new Map<string, PeerLink>();
  private info: NodeInfo;
  /** 模拟手机挂起：连接还在，但这个节点不再收发。 */
  muted = false;
  /** `rejected`：被拒绝的握手。自研传输在握手阶段就拒绝，对方重发的请求也各算一次。 */
  readonly stats = { routedOut: 0, routedIn: 0, rejected: 0, relayConnections: 0 };

  private constructor(private readonly options: EdgeHubOptions) {
    this.info = {
      deviceId: options.deviceId,
      deviceName: options.deviceId,
      platform: 'darwin',
      appVersion: 'spike',
      remoteControlEnabled: false,
      busy: false,
    };
  }

  static async create(options: EdgeHubOptions) {
    const hub = new EdgeHub(options);
    hub.transport = await createTransport(options.transport ?? 'core', {
      admit: (remoteId) => {
        if (hub.deviceOf(remoteId)) return true;
        hub.stats.rejected += 1;
        return false;
      },
      onIncoming: (channel) => hub.adopt(channel),
      relayIdOf: (remoteId) => {
        for (const entry of options.roster.values()) {
          if (entry.id === remoteId) return (entry.dial as { relayId?: string } | undefined)?.relayId;
        }
        return undefined;
      },
      ...(options.tap ? { tap: options.tap } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.relay ? { relay: options.relay } : {}),
      ...(options.udp === false ? { udp: false } : {}),
      ...(options.reprobeMs ? { reprobeMs: options.reprobeMs } : {}),
      ...(options.bindAddress ? { bindAddress: options.bindAddress } : {}),
      ...(options.stunServers ? { stunServers: options.stunServers } : {}),
    });
    const certified = options.roster.get(options.deviceId);
    if (options.identity && certified && certified.id !== hub.transport.id) throw new Error('CERTIFICATE_TRANSPORT_IDENTITY_MISMATCH');
    options.roster.set(options.deviceId, { id: hub.transport.id, dial: hub.transport.dial });
    return hub;
  }

  /** 交给 DeviceLinkClient 的 createWebSocket。 */
  createSocket = (): WsLike => {
    this.ready = false;
    this.socket?.close(1000, 'replaced');
    this.socket = new EdgeSocket(this);
    return this.socket;
  };

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  /** 到这台设备的数据现在走直连还是中转。 */
  pathTo(deviceId: string): 'direct' | 'relay' | null {
    return this.peers.get(deviceId)?.channel.path?.() ?? null;
  }

  async dial(deviceId: string): Promise<void> {
    if (this.peers.has(deviceId)) return;
    const entry = this.options.roster.get(deviceId);
    if (!entry) throw new Error(`unknown peer ${deviceId}`);
    this.adopt(await this.transport.connect(entry));
  }

  async dropPeer(deviceId: string): Promise<void> {
    this.peers.get(deviceId)?.channel.close();
  }

  /** 测试入口：绕过 DeviceLinkClient 直接写一帧，用来验证接收端不信任帧内 src。 */
  injectRaw(dst: string, frame: Envelope): void {
    const peer = this.peers.get(dst);
    if (peer) this.write(peer, frame);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  fromClient(text: string): void {
    if (this.muted) return;
    const env = JSON.parse(text) as Envelope;
    if (!this.ready) {
      if (env.kind === 'hello') this.handleHello(env.payload as Record<string, any>);
      return;
    }
    switch (env.kind) {
      case 'ping':
        this.toClient({ v: PROTOCOL_VERSION, kind: 'pong' });
        return;
      case 'presence-set':
        Object.assign(this.info, env.payload as object);
        for (const peer of this.peers.values()) {
          this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info });
        }
        return;
      case 'notify':
        return;
      default:
        if (ROUTED_KINDS.has(env.kind)) this.route(env);
    }
  }

  private handleHello(hello: Record<string, any>): void {
    this.info = { ...this.info, ...hello, deviceId: this.options.deviceId };
    this.ready = true;
    this.toClient({
      v: PROTOCOL_VERSION,
      kind: 'hello-ack',
      payload: {
        serverProtocolVersion: PROTOCOL_VERSION,
        deviceId: this.options.deviceId,
        userId: this.options.userId,
        capabilities: [],
      },
    });
    for (const peer of this.peers.values()) {
      if (peer.info) this.toClient(this.presenceFrame(peer.info, true));
      this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info });
    }
  }

  private route(env: Envelope): void {
    const peer = env.dst ? this.peers.get(env.dst) : undefined;
    if (!peer) {
      this.relayError(env, 'DEVICE_OFFLINE', 'target device is offline');
      return;
    }
    if (Buffer.byteLength(JSON.stringify(env)) > MAX_FRAME_BYTES) {
      this.relayError(env, 'PAYLOAD_TOO_LARGE', 'frame exceeds the size limit');
      return;
    }
    this.stats.routedOut += 1;
    this.write(peer, env);
  }

  private relayError(env: Envelope, code: string, message: string): void {
    this.toClient({
      v: PROTOCOL_VERSION,
      kind: 'relay-error',
      ...(env.id ? { id: env.id } : {}),
      payload: { code, message, ...(env.dst ? { dst: env.dst } : {}) },
    } as Envelope);
  }

  private toClient(frame: Envelope): void {
    this.socket?.deliver(frame);
  }

  private presenceFrame(info: NodeInfo, online: boolean): Envelope {
    const snapshot: PresenceSnapshot = {
      deviceId: info.deviceId,
      online,
      deviceName: info.deviceName,
      platform: info.platform,
      appVersion: info.appVersion,
      lastSeenAt: Date.now(),
      remoteControlEnabled: online && info.remoteControlEnabled,
      busy: info.busy,
    };
    return { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: snapshot };
  }

  /** 身份来自传输层握手验证过的公钥；名册外的节点传输层已经拒绝，这里再核对一次。 */
  private adopt(channel: PeerChannel): void {
    const deviceId = this.deviceOf(channel.remoteId);
    if (!deviceId) {
      channel.close();
      return;
    }
    const peer: PeerLink = { deviceId, channel, info: null };
    // 同一台设备重新连上来：新连接取代旧的，旧连接关掉时不再报离线。
    const previous = this.peers.get(deviceId);
    this.peers.set(deviceId, peer);
    previous?.channel.close();
    const reader = new FrameReader();
    // 静默时整帧丢掉，字节流照常拆帧，恢复后帧边界不乱。
    channel.onData((bytes) =>
      reader.push(bytes, (frame) => {
        if (!this.muted) this.fromPeer(peer, frame);
      }),
    );
    channel.onClose(() => {
      if (this.peers.get(deviceId) !== peer) return;
      this.peers.delete(deviceId);
      if (peer.info) this.toClient(this.presenceFrame(peer.info, false));
    });
    this.write(peer, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.info });
  }

  private deviceOf(remoteId: string): string | undefined {
    for (const [deviceId, entry] of this.options.roster) {
      if (entry.id === remoteId && deviceId !== this.options.deviceId) return deviceId;
    }
    return undefined;
  }

  private write(peer: PeerLink, frame: Envelope): void {
    const body = Buffer.from(JSON.stringify(frame));
    const bytes = Buffer.alloc(4 + body.length);
    bytes.writeUInt32BE(body.length, 0);
    body.copy(bytes, 4);
    peer.channel.send(bytes);
  }

  private fromPeer(peer: PeerLink, env: Envelope): void {
    if (env.kind === 'presence-changed') {
      peer.info = { ...(env.payload as NodeInfo), deviceId: peer.deviceId };
      this.toClient(this.presenceFrame(peer.info, true));
      return;
    }
    if (env.kind === 'relay-error') {
      this.toClient(env);
      return;
    }
    if (!ROUTED_KINDS.has(env.kind)) return;
    // 远控开关由目标节点自己裁决，不再依赖中继检查。
    if (CONTROL_KINDS.has(env.kind) && !this.info.remoteControlEnabled) {
      this.write(peer, {
        v: PROTOCOL_VERSION,
        kind: 'relay-error',
        ...(env.id ? { id: env.id } : {}),
        payload: {
          code: 'REMOTE_DISABLED',
          message: 'target device does not allow remote control',
          dst: this.options.deviceId,
        },
      } as Envelope);
      return;
    }
    this.stats.routedIn += 1;
    // 来源只取已认证连接，帧内 src 一律覆盖。
    this.toClient({ ...env, src: peer.deviceId });
  }
}
