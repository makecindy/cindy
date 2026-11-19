/**
 * 自研传输：`packages/agent-net-core` 编成 WebAssembly，由它的 Node 驱动跑在本机 UDP 上，也可以经中转转发（第 7 步）。
 * 身份是 X25519 公钥（十六进制），名册外的公钥在 Noise 握手时就被拒绝，连回复都不给。
 *
 * - 每个方向开两条流：数据流（第一个字节 `D`）和控制流（第一个字节 `C`）。控制流只传候选地址，不交给 EdgeHub。
 * - 有中转时先经中转连上（中转通道的代价是 1 或 2，UDP 是 0），连上以后两端互相告诉自己的候选地址、同时去验证对方的，
 *   通了核心就换到直连；直连断了核心自己退回中转，这里每隔一阵再验证一轮，恢复了再换回来。
 * - 中转上的设备号由中转按凭证认定，经中转来的握手请求还要核对：那台设备在名册里登记的公钥必须就是握手里的公钥。
 * - 关闭 = 结束自己的流、等对端确认后再关连接；对端看到流结束就知道这一端走了，关连接时核心还会发关闭包（2026-11-06）。
 */
import {
  Endpoint,
  generateIdentity,
  isLinkAddress,
  type Address,
  type Connection,
  type Link,
  type PeerAddress,
  type RecvStream,
  type SendStream,
} from '@cindy/agent-net-core/node';
import os from 'node:os';
import { StunClient } from './stun.js';
import { RelayUdpPath } from './relayUdp.js';
import { UDP_RELAY_UP_OVERHEAD } from '@cindy/agent-net-relay/client';
import {
  AGENT_NET_SESSION_V1, ChannelEvents, MAX_CHANNEL_PENDING_BYTES, MAX_EARLY_SESSION_BYTES, SESSION_LANE_KINDS,
  SESSION_LANE_PRIORITY as SESSION_PRIORITY, type PeerChannel, type RosterEntry, type SessionLaneName, type Transport, type TransportOptions,
} from './types.js';

const PROLOGUE = 'cindy/agent-net/device-link/2';
/**
 * 发出的 UDP 载荷不超过 1350 字节：VPN、PPPoE、运营商隧道在包外再套一层，整包超过路径 MTU 时被拆成两片，高速时丢包和排队陡增。
 * 2026-11-16 两台电脑之间的 VPN 上，每秒 12 MB 时 1400 字节的 UDP 丢 32%、往返 10 → 184 毫秒，1372 字节以下不丢，
 * Agent-Net 回传只跑到线路的一半（docs/benchmarks/agent-net-session-2026-11-13/README.md「真实网络对比」）。
 * 经 UDP 中转时中转在包外再加 33 字节（上行），核心的包要留出来。收包上限仍是核心默认的 1400：旧版照样发 1400，照样收得下。
 */
const SEND_PACKET_SIZE = 1350 - UDP_RELAY_UP_OVERHEAD;
/** 握手要在这么久内完成，否则放弃这次连接（名册外的节点收不到任何回复）。 */
const CONNECT_TIMEOUT_MS = 3_000;
/** 关闭时最多等这么久让对端确认已写入的数据。 */
const DRAIN_TIMEOUT_MS = 2_000;
/** 和核心放弃握手的时间（`dead_after_us`）一样长。 */
const REFUSAL_MEMORY_MS = 30_000;
const DEFAULT_REPROBE_MS = 10_000;
/** 核心一次最多同时验证 4 条路径，再多会把先开始的挤掉，所以每轮最多验这么多个，下一轮接着验后面的。 */
const PROBES_PER_ROUND = 4;
/** 对端给的候选地址最多收这么多个。 */
const MAX_CANDIDATES = 16;
const DATA = 0x44;
const CONTROL = 0x43;
const SESSION_LANE_BY_KIND = new Map<number, SessionLaneName>(Object.entries(SESSION_LANE_KINDS).map(([lane, kind]) => [kind, lane as SessionLaneName]));
export { AGENT_NET_SESSION_V1 };

/** 名册里怎么连上一台设备：UDP 地址、中转上的设备号，有哪个用哪个。 */
export interface CoreDial {
  udp?: Address;
  relayId?: string;
  preferUdp?: boolean;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

class CoreChannel implements PeerChannel {
  readonly remoteId: string;
  private readonly events = new ChannelEvents();
  private readonly outbound: SendStream;
  private readonly control: SendStream;
  private readonly localCandidates: Address[];
  private candidates: Address[] = [];
  /** 下一轮从第几个候选地址验起。 */
  private nextCandidate = 0;
  private reprobe: NodeJS.Timeout | null = null;
  private sessionCapable = false;
  private sessionsDeclared = false;
  /** What the peer declared besides session support itself (opaque to this layer; see `declareSessions`). */
  private peerSessionFeatures: string[] = [];
  private readonly sessionCapableHandlers: Array<() => void> = [];
  private sessionStreams: Record<SessionLaneName, SendStream> | null = null;
  private sessionHandler: ((lane: SessionLaneName, bytes: Uint8Array) => void) | null = null;
  private earlySession: Array<[SessionLaneName, Uint8Array]> = [];
  private earlySessionBytes = 0;

  constructor(
    private readonly connection: Connection,
    localCandidates: Address[],
    reprobeMs: number,
    private readonly publicOnly = false,
  ) {
    this.remoteId = hex(connection.remotePublicKey);
    this.outbound = connection.openStream('normal');
    this.outbound.write(Uint8Array.of(DATA));
    this.control = connection.openStream('interactive');
    this.control.write(Uint8Array.of(CONTROL));
    this.localCandidates = localCandidates;
    this.announceCandidates();
    connection.on('stream', (stream: RecvStream) => {
      let kind: number | null = null;
      let text = '';
      stream.on('data', (bytes: Uint8Array) => {
        let chunk = bytes;
        if (kind === null) {
          kind = chunk[0];
          chunk = chunk.subarray(1);
        }
        if (kind === DATA) {
          if (chunk.length) this.events.data(chunk);
          return;
        }
        const lane = SESSION_LANE_BY_KIND.get(kind);
        if (lane) {
          if (chunk.length) this.sessionData(lane, chunk);
          return;
        }
        if (kind !== CONTROL || text.length + chunk.length > 8192) { this.close(); return; }
        text += Buffer.from(chunk).toString('utf8');
        for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
          this.onControl(text.slice(0, end));
          text = text.slice(end + 1);
        }
      });
      // 对端结束了它的数据流：它要走了，这一端也收尾。
      stream.on('end', () => {
        if (kind === DATA) this.close();
      });
    });
    connection.on('close', () => {
      this.stopReprobe();
      this.events.close();
    });
    // 还在走中转时每隔一阵再验证一轮：先前没打通，或者直连断了退回了中转。
    this.reprobe = setInterval(() => {
      if (this.path() === 'relay') this.probeCandidates();
    }, reprobeMs);
    this.reprobe.unref();
  }

  private onControl(line: string): void {
    let message: { candidates?: unknown; session?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Array.isArray(message.session) && message.session.includes(AGENT_NET_SESSION_V1) && !this.sessionCapable) {
      this.sessionCapable = true;
      this.peerSessionFeatures = message.session
        .filter((value): value is string => typeof value === 'string' && value !== AGENT_NET_SESSION_V1 && value.length <= 64).slice(0, 16);
      for (const handler of this.sessionCapableHandlers.splice(0)) handler();
    }
    if (!Array.isArray(message.candidates)) return;
    this.candidates = message.candidates
      .filter((value): value is Address => !!value && typeof value.address === 'string' && value.address.length <= 128 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535)
      .filter((value) => !this.publicOnly || !isPrivate(value.address))
      .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)))
      .slice(0, MAX_CANDIDATES);
    this.nextCandidate = 0;
    this.probeCandidates();
  }
  announceCandidates(): void {
    if (!this.events.closed && this.localCandidates.length) this.control.write(Buffer.from(`${JSON.stringify({ candidates: this.localCandidates })}\n`));
  }

  private probeCandidates(): void {
    if (this.events.closed) return;
    // 公网地址排在前面（查公网地址得到的那些），内网地址在后。装了 Docker 之类的机器有很多内网地址，
    // 2026-11-05 真实网络测试里公网地址排在第 9 个，被截掉了，两台本来能直连的电脑一直走中转。
    const count = Math.min(PROBES_PER_ROUND, this.candidates.length);
    for (let i = 0; i < count; i++) this.connection.probe(this.candidates[(this.nextCandidate + i) % this.candidates.length]);
    this.nextCandidate = (this.nextCandidate + count) % Math.max(1, this.candidates.length);
  }

  private stopReprobe(): void {
    if (this.reprobe) clearInterval(this.reprobe);
    this.reprobe = null;
  }

  send(bytes: Uint8Array): void {
    if (this.events.closed) return;
    if (this.bufferedAmount + bytes.length > MAX_CHANNEL_PENDING_BYTES) throw new Error('AGENT_NET_TRANSPORT_BACKPRESSURE');
    this.outbound.write(bytes);
  }

  get bufferedAmount(): number { return this.outbound.pendingBytes + this.control.pendingBytes; }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.events.onData(handler);
  }

  onClose(handler: () => void): void {
    this.events.onClose(handler);
  }

  onDrain(handler: () => void): void {
    this.connection.on('drain', handler);
  }

  /**
   * Tells the peer this node's upper layer uses sessions. Only then may the peer open session streams: a node that
   * declared without anyone reading its sessions would leave the peer's `open` waiting for its timeout. Once per
   * connection; older nodes only read `candidates` from control lines and ignore this one. `features`: what else the
   * upper layer reads on its sessions, sent along in the same line (older session nodes look only for the version).
   */
  declareSessions(features: readonly string[] = []): void {
    if (this.sessionsDeclared || this.events.closed) return;
    this.sessionsDeclared = true;
    this.control.write(Buffer.from(`${JSON.stringify({ session: [AGENT_NET_SESSION_V1, ...features] })}\n`));
  }

  /** The features the peer declared with its session support (empty until it did, or if it declared none). */
  sessionFeatures(): readonly string[] { return this.peerSessionFeatures; }

  onSessionCapable(handler: () => void): void {
    if (this.sessionCapable) handler(); else this.sessionCapableHandlers.push(handler);
  }

  sessionWire(): import('./types.js').SessionWire | null {
    if (!this.sessionCapable || this.events.closed) return null;
    if (!this.sessionStreams) {
      const open = (lane: SessionLaneName) => {
        const stream = this.connection.openStream(SESSION_PRIORITY[lane]);
        stream.write(Uint8Array.of(SESSION_LANE_KINDS[lane]));
        return stream;
      };
      this.sessionStreams = { control: open('control'), normal: open('normal'), background: open('background') };
    }
    const streams = this.sessionStreams;
    return {
      write: (lane, bytes) => { if (!this.events.closed) streams[lane].write(bytes); },
      // 控制与普通通道连核心缓冲里的一起算：慢线路上核心里能排上 1 MiB 推送，只算 JS 这边的话读数一直是 0，业务照样往里灌，交互回复
      // 排在后面几秒（2026-11-17 审查）。后台通道（文件块）只算 JS 这边的，下载时不压住任务文字。
      get bufferedAmount() {
        return streams.control.pendingBytes + streams.control.coreBufferedBytes + streams.normal.pendingBytes + streams.normal.coreBufferedBytes
          + streams.background.pendingBytes;
      },
      onData: (handler) => {
        this.sessionHandler = handler;
        for (const [lane, bytes] of this.earlySession.splice(0)) handler(lane, bytes);
        this.earlySessionBytes = 0;
      },
    };
  }

  private sessionData(lane: SessionLaneName, bytes: Uint8Array): void {
    if (this.sessionHandler) { this.sessionHandler(lane, bytes); return; }
    this.earlySessionBytes += bytes.length;
    if (this.earlySessionBytes > MAX_EARLY_SESSION_BYTES) { this.close(); return; }
    this.earlySession.push([lane, bytes.slice()]);
  }

  stats(): Record<string, number> | null {
    return this.connection.closed ? null : (this.connection.stats() as unknown as Record<string, number> | null);
  }

  addressKind(): 'relay' | 'loopback' | 'private' | 'public' | null {
    const address = this.connection.closed ? null : this.connection.peerAddress();
    if (!address) return null;
    if (isLinkAddress(address)) return 'relay';
    const [a, b] = address.address.split('.').map(Number);
    if (address.address.includes(':')) return /^(::1|fe80:|fc|fd)/i.test(address.address) ? 'private' : 'public';
    if (a === 127) return 'loopback';
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
    return isPrivate ? 'private' : 'public';
  }

  path(): 'direct' | 'relay' | null {
    const address = this.connection.closed ? null : this.connection.peerAddress();
    return address ? (isLinkAddress(address) ? 'relay' : 'direct') : null;
  }

  close(options?: { drain?: boolean }): void {
    if (this.events.closed) return;
    this.stopReprobe();
    this.events.close();
    if (options?.drain === false) { this.connection.close(); return; }
    this.outbound.finish();
    this.control.finish();
    if (this.sessionStreams) for (const stream of Object.values(this.sessionStreams)) stream.finish();
    void this.connection.closeWhenDrained(DRAIN_TIMEOUT_MS);
  }
}

export async function createCoreTransport(options: TransportOptions): Promise<Transport> {
  const relay = options.relay;
  const udp = options.udp !== false;
  const reprobeMs = options.reprobeMs ?? DEFAULT_REPROBE_MS;
  // 中转上的设备号 ↔ 通道。专用通道开销小，代价 1；夹带在 push 里的代价 2，两种都有时优先专用通道。
  const links = new Map<string, Link>();
  const relayIdOf = new Map<number, string>();
  let endpoint: Endpoint;
  // 中继给了 UDP 凭据时经中继的数据报走 UDP，否则（或 UDP 不通时）走中继 WebSocket，见 relayUdp.ts。
  let relayUdp: RelayUdpPath | null = null;
  const linkFor = (relayId: string): Link => {
    let link = links.get(relayId);
    if (!link) {
      link = endpoint.createLink((datagram) => { if (!relayUdp?.send(relayId, datagram)) relay!.uplink.send(relayId, datagram); }, 1);
      links.set(relayId, link);
      relayIdOf.set(link.id, relayId);
    }
    return link;
  };

  // 被拒绝的一方收不到回复，会按重传节奏重发同一个握手请求；同一来源、同一身份在这段时间里只问一次名册。
  const refused = new Map<string, number>();
  let admissionVersion = options.admissionVersion?.();
  const admit = ({ publicKey, from }: { publicKey: Uint8Array; from: PeerAddress }) => {
    const version = options.admissionVersion?.();
    if (version !== admissionVersion) { refused.clear(); admissionVersion = version; }
    const id = hex(publicKey);
    const source = isLinkAddress(from) ? `relay:${relayIdOf.get(from.link)}` : `${from.address}|${from.port}`;
    const key = `${id}|${source}`;
    const now = performance.now();
    const at = refused.get(key);
    if (at !== undefined && now - at < REFUSAL_MEMORY_MS) return false;
    // 经中转来的：中转认定的设备号必须和名册里登记这把公钥的设备一致。
    // 先问名册（名册外的身份由 EdgeHub 记一次拒绝），再核对中转设备号。
    const known = options.admit(id);
    const bound = !isLinkAddress(from) || options.relayIdOf?.(id) === relayIdOf.get(from.link);
    if (known && bound) return true;
    if (refused.size >= 1024) refused.clear();
    refused.set(key, now);
    return false;
  };
  let stun: StunClient | null = null;
  endpoint = await Endpoint.create({
    identity: options.identity ?? generateIdentity(),
    prologue: PROLOGUE,
    sendPacketSize: SEND_PACKET_SIZE,
    ...(options.module ? { module: options.module } : {}),
    bind: { address: options.bindAddress ?? '0.0.0.0' },
    udp,
    accept: { admit },
    intercept: (datagram) => relayUdp?.intercept(datagram) || (stun?.intercept(datagram) ?? false),
    ...(options.tap
      ? {
          // 只记发出的：每个节点都接了抓包时，线上每个数据报正好记一次。
          tap: (direction: 'in' | 'out', datagram: Uint8Array, address: PeerAddress) =>
            direction === 'out' && options.tap!(datagram, isLinkAddress(address) ? 'relay' : 'udp'),
        }
      : {}),
  });
  relay?.uplink.onDatagram((relayId, datagram) => linkFor(relayId).deliver(datagram));
  if (udp && relay?.udpCredentials && options.relayUdpServer) {
    const credentials = relay.udpCredentials;
    relayUdp = new RelayUdpPath({
      sendUdp: (to, datagram) => endpoint.sendUdp(to, datagram),
      server: options.relayUdpServer,
      credentials: () => credentials(),
      peers: () => (options.admittedPeers?.() ?? []).map((peer) => peer.relayId),
      deliver: (relayId, datagram) => linkFor(relayId).deliver(datagram),
    });
  }
  const publicOnly = options.publicCandidatesOnly === true;
  const candidates: Address[] = [];
  const channels = new Set<CoreChannel>();
  let closed = false;
  const channelFor = (connection: Connection) => {
    const channel = new CoreChannel(connection, candidates, reprobeMs, publicOnly);
    channels.add(channel); connection.once('close', () => channels.delete(channel)); return channel;
  };
  // Install admission listeners before any DNS/STUN wait. Relay RPC never waits for a UDP response.
  endpoint.on('connection', (connection: Connection) => options.onIncoming(channelFor(connection)));
  let gathering = 0;
  const gather = () => {
    const round = ++gathering;
    void gatherCandidates(endpoint, options.stunServers ?? [], (client) => { stun?.close(); stun = client; }).then((gathered) => {
      if (closed || round !== gathering) return;
      candidates.splice(0, candidates.length, ...gathered.filter((address) => !publicOnly || !isPrivate(address.address))
        .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address))).slice(0, MAX_CANDIDATES));
      for (const channel of channels) channel.announceCandidates();
    }).catch(() => undefined);
  };
  if (udp) gather();
  const dial: CoreDial = { ...(udp ? { udp: endpoint.address() } : {}), ...(relay ? { relayId: relay.deviceId } : {}) };
  return {
    id: hex(endpoint.publicKey),
    dial,
    async connect(entry: RosterEntry): Promise<PeerChannel> {
      if (!options.admit(entry.id)) throw new Error('peer is not in the roster');
      const target = entry.dial as CoreDial;
      // 有中转先走中转：一定连得上，之后再打洞。没有中转才直接走 UDP。
      const via: PeerAddress | null = udp && target.udp && target.preferUdp ? target.udp : relay && target.relayId ? linkFor(target.relayId).address : udp && target.udp ? target.udp : null;
      if (!via) throw new Error('no way to reach the peer');
      const connection = endpoint.connect(Buffer.from(entry.id, 'hex'), via);
      // 流的监听要在连接建好之前挂上，否则对端开流时的第一批数据没人接。
      const channel = channelFor(connection);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.close();
          reject(new Error('handshake timed out'));
        }, CONNECT_TIMEOUT_MS);
        connection.once('established', () => {
          clearTimeout(timer);
          resolve();
        });
        connection.once('close', () => {
          clearTimeout(timer);
          reject(new Error('connection closed'));
        });
      });
      return channel;
    },
    networkChanged() {
      if (closed) return;
      // 换了网络：每条连接马上从新地址发包，对端看到新地址就跟过来（不等下一次保活）；候选地址按新网络重新收集。
      endpoint.localAddressChanged();
      if (udp) gather();
    },
    relayRoute() {
      if (!relay || closed) return null;
      // 和 linkFor 里发数据报的判断是同一个：UDP 通着就走 UDP，否则走中转 WebSocket。
      return relayUdp?.up ? { via: 'udp', rttMs: relayUdp.rttMs } : { via: 'websocket', rttMs: null };
    },
    async close() {
      closed = true; stun?.close();
      // 端点先关：各条连接的关闭包经直连、UDP 中转或 WebSocket 中转发出去，等它们交给系统后再关中转。
      await endpoint.close();
      relayUdp?.close();
      relay?.uplink.close();
    },
  };
}

/**
 * 候选地址：本机 UDP 地址（绑在 `0.0.0.0` 时是各网卡的 IPv4 地址），加上各 STUN 服务器看到的外部地址。
 * 同一台机器问不同的 STUN 服务器可能看到不同的外部地址（国内外分流出口不同），所以每个都问、去重后都给对端。
 */
async function gatherCandidates(endpoint: Endpoint, stunServers: string[], install: (client: StunClient) => void): Promise<Address[]> {
  const local = endpoint.address();
  const found: Address[] = [];
  if (local.address === '0.0.0.0') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) found.push({ address: entry.address, port: local.port });
    }
  } else {
    found.push(local);
  }
  if (stunServers.length) {
    const client = new StunClient((to, datagram) => endpoint.sendUdp(to, datagram));
    install(client);
    const mapped = await Promise.all(stunServers.map((server) => client.query(server).catch(() => null)));
    for (const address of mapped) if (address) found.push(address);
  }
  const seen = new Set<string>();
  return found.filter((address) => {
    const key = `${address.address}:${address.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 私有地址：局域网、运营商 NAT、链路本地。 */
function isPrivate(address: string): boolean {
  if (address.includes(':')) return /^(fe80:|fc|fd)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
