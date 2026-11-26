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
import { RelaySendCounters, RelayUdpPath } from './relayUdp.js';
import { PathRouter } from './pathRouter.js';
import { UDP_RELAY_UP_OVERHEAD } from '@cindy/agent-net-relay/client';
import {
  AGENT_NET_SESSION_V1, AGENT_NET_SESSION_V2, ChannelEvents, EARLY_BODY_EVENT_BYTES, MAX_CHANNEL_PENDING_BYTES, MAX_EARLY_SESSION_BYTES,
  SESSION_BODY_KIND, SESSION_LANE_KINDS,
  SESSION_LANE_PRIORITY as SESSION_PRIORITY, type PathPreference, type PeerChannel, type PeerPathMetrics, type RosterEntry, type SessionBodyWriter, type SessionLaneName, type Transport,
  type TransportOptions, type UdpRebindReason,
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
// 选路的门槛与判断在 pathRouter.ts（原生引擎的传输共用），这里照旧导出给已有的调用方。
export { AUTO_DIRECT_RECOVER_DELTA_MS, AUTO_DIRECT_RECOVER_RATIO, AUTO_RELAY_DELTA_MS, AUTO_RELAY_RATIO, AUTO_SWITCH_COOLDOWN_MS, decideAutoPreferRelay } from './pathRouter.js';
/** 显式换网触发重建 UDP 套接字的最短间隔：合并短时间内连续到达的网卡/代理/中转重连事件，避免高频抖动。 */
const DEFAULT_NETWORK_REBIND_COOLDOWN_MS = 3_000;
/** 连续 UDP 发送报错达到该次数，或出现套接字 fd 已失效错误时，触发重建 UDP 套接字。 */
const UDP_SEND_ERROR_THRESHOLD = 3;
const FATAL_UDP_SOCKET_ERRORS = new Set(['EBADF', 'ENOTSOCK', 'EPIPE']);
/** 非显式换网（自动检测）触发重建 UDP 套接字的退避阶梯，防止 UDP 被彻底封禁或系统持续报错时死循环重绑。 */
const AUTO_REBIND_BACKOFF_MS = [10_000, 30_000, 120_000] as const;
/** 自动重建后若新套接字一直没有收到任何合法 UDP 回包，最多再自动尝试这么多次，之后等显式换网或收到合法回包再恢复。 */
const MAX_AUTO_REBINDS_WITHOUT_INBOUND = 2;
/** 全部直连掉回中转，或中转 UDP 登记持续无回包且期间没有任何合法 UDP 入站超过这么久时，判定旧套接字疑似黑洞。 */
const DEFAULT_UDP_BLACKHOLE_TIMEOUT_MS = 5_000;
/** 巡检 UDP 套接字健康状态的默认周期。 */
const DEFAULT_UDP_HEALTH_POLL_MS = 1_000;
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
  /** Direct or relayed, and when to probe or measure which path (pathRouter.ts, shared with the native engine's transport). */
  private readonly router: PathRouter<PeerAddress>;
  private sessionCapable = false;
  private sessionsDeclared = false;
  /** What the peer declared besides session support itself (opaque to this layer; see `declareSessions`). */
  private peerSessionFeatures: string[] = [];
  private readonly sessionCapableHandlers: Array<() => void> = [];
  private sessionStreams: Record<SessionLaneName, SendStream> | null = null;
  private sessionHandler: ((lane: SessionLaneName, bytes: Uint8Array) => void) | null = null;
  private earlySession: Array<[SessionLaneName, Uint8Array]> = [];
  private earlySessionBytes = 0;
  /** Session v2: this channel reads and opens body streams (`SessionWire.openBody`). */
  readonly sessionBodies = true;
  /**
   * Session v2: body streams this side opened, counted in the session's backlog: those on the control and normal lanes until the core
   * holds none of them, those on the background lane (file blocks) while bytes of them still wait here, as the lanes are counted.
   */
  private readonly bodyStreams = new Map<SendStream, SessionLaneName>();
  private bodyHandler: ((key: number, bytes: Uint8Array | null) => void) | null = null;
  private earlyBodies: Array<[number, Uint8Array | null]> = [];
  /** This side declared `AGENT_NET_SESSION_V2`: the peer may open body streams. */
  private bodiesDeclared = false;

  constructor(
    private readonly connection: Connection,
    localCandidates: Address[],
    reprobeMs: number,
    private readonly publicOnly = false,
    relayAddress: () => PeerAddress | null = () => null,
  ) {
    this.remoteId = hex(connection.remotePublicKey);
    this.outbound = connection.openStream('normal');
    this.outbound.write(Uint8Array.of(DATA));
    this.control = connection.openStream('interactive');
    this.control.write(Uint8Array.of(CONTROL));
    this.localCandidates = localCandidates;
    this.router = new PathRouter<PeerAddress>({
      closed: () => this.events.closed || connection.closed,
      path: () => this.path(),
      directAddress: () => { const address = connection.closed ? null : connection.peerAddress(); return address && !isLinkAddress(address) ? address : null; },
      activeRttMs: () => { const srtt = this.stats()?.srttUs; return typeof srtt === 'number' && srtt > 0 ? srtt / 1000 : null; },
      relayAddress,
      probe: (address) => { connection.probe(address); },
      measure: (address) => { connection.measure(address); },
      setPreferRelay: (prefer) => connection.setPreferRelay(prefer),
      writeControl: (line) => this.control.write(Buffer.from(line)),
    }, reprobeMs);
    this.announceCandidates();
    connection.on('probe-rtt', (address: PeerAddress, rttUs: number) => this.router.onProbeRtt(address, isLinkAddress(address), rttUs));
    connection.on('stream', (stream: RecvStream) => {
      let kind: number | null = null;
      let text = '';
      // Session v2 body stream: its key (4 bytes) follows the kind byte; they may arrive in separate chunks.
      let bodyKey: number | null = null, keyBytes: number[] = [];
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
        if (kind === SESSION_BODY_KIND) {
          // Only after this side declared v2: before that it is a stream kind this node does not take, as on older nodes.
          if (!this.bodiesDeclared) { this.close(); return; }
          while (bodyKey === null && chunk.length) { keyBytes.push(chunk[0]); chunk = chunk.subarray(1); if (keyBytes.length === 4) bodyKey = new DataView(Uint8Array.from(keyBytes).buffer).getUint32(0, false); }
          if (bodyKey !== null && chunk.length) this.sessionBody(bodyKey, chunk);
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
        if (kind === SESSION_BODY_KIND && bodyKey !== null) this.sessionBody(bodyKey, null);
      });
    });
    connection.on('close', () => {
      this.router.stop();
      this.events.close();
    });
    // 还在走中转时每隔一阵再验证一轮（先前没打通，或者直连断了退回了中转），并定期轻测备用路径往返。
    this.router.start();
  }

  private onControl(line: string): void {
    let message: { candidates?: unknown; session?: unknown; pathPreference?: unknown; autoRelay?: unknown };
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
    this.router.onPeerPreference(message);
    if (!Array.isArray(message.candidates)) return;
    this.router.setCandidates(message.candidates
      .filter((value): value is Address => !!value && typeof value.address === 'string' && value.address.length <= 128 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535)
      .filter((value) => !this.publicOnly || !isPrivate(value.address))
      .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)))
      .slice(0, MAX_CANDIDATES));
  }
  announceCandidates(): void {
    if (!this.events.closed && this.localCandidates.length) this.control.write(Buffer.from(`${JSON.stringify({ candidates: this.localCandidates })}\n`));
  }

  pathMetrics(): PeerPathMetrics { return this.router.pathMetrics(); }

  setPathPreference(preference: PathPreference): void { this.router.setPathPreference(preference); }

  /** 当前连接是否因用户选择或自动选路主动偏好中转（与被动断直连区分）。 */
  isPreferringRelay(): boolean {
    return this.router.effectivePreferRelay();
  }

  /** 本机换网或重建 UDP 套接字后：清掉旧网络的直连测速缓存与自动切路冷却，若此刻走中转则立即重新探测直连。 */
  onLocalNetworkChanged(): void {
    this.router.onLocalNetworkChanged();
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
    this.bodiesDeclared = features.includes(AGENT_NET_SESSION_V2);
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
    const streams = this.sessionStreams, channel = this;
    return {
      write: (lane, bytes) => { if (!this.events.closed) streams[lane].write(bytes); },
      // 控制与普通通道连核心缓冲里的一起算：慢线路上核心里能排上 1 MiB 推送，只算 JS 这边的话读数一直是 0，业务照样往里灌，交互回复
      // 排在后面几秒（2026-11-17 审查）。后台通道（文件块）只算 JS 这边的，下载时不压住任务文字。
      get bufferedAmount() {
        return streams.control.pendingBytes + streams.control.coreBufferedBytes + streams.normal.pendingBytes + streams.normal.coreBufferedBytes
          + streams.background.pendingBytes + channel.bodiesBuffered();
      },
      onData: (handler) => {
        this.sessionHandler = handler;
        for (const [lane, bytes] of this.earlySession.splice(0)) handler(lane, bytes);
        this.earlySessionBytes = 0;
      },
      openBody: (lane, key) => this.openBody(lane, key),
      onBody: (handler) => {
        this.bodyHandler = handler;
        for (const [key, bytes] of this.earlyBodies.splice(0)) handler(key, bytes);
      },
      onDrain: (handler) => this.onDrain(handler),
    };
  }

  /**
   * Session v2: bodies count like their lanes: on the control and normal lanes with what the core still buffers, on the background
   * lane what still waits here. A stream leaves the count once it holds nothing more.
   */
  private bodiesBuffered(): number {
    let total = 0;
    for (const [stream, lane] of this.bodyStreams) {
      const buffered = stream.pendingBytes + (lane === 'background' ? 0 : stream.coreBufferedBytes);
      if (buffered === 0 && stream.handedOver) this.bodyStreams.delete(stream); else total += buffered;
    }
    return total;
  }

  /** Session v2: a stream of its own for one message body (types.ts SESSION_BODY_KIND), at its lane's priority. */
  private openBody(lane: SessionLaneName, key: number): SessionBodyWriter | null {
    if (this.events.closed) return null;
    let stream: SendStream;
    try { stream = this.connection.openStream(SESSION_PRIORITY[lane]); } catch { return null; }
    const head = new Uint8Array(5);
    head[0] = SESSION_BODY_KIND;
    new DataView(head.buffer).setUint32(1, key, false);
    stream.write(head);
    this.bodyStreams.set(stream, lane);
    return {
      write: (bytes) => { if (!this.events.closed) stream.write(bytes); },
      finish: () => stream.finish(),
      // A core from before abandoned streams (no `conn_abandon`): what was written still goes, the stream ends after it.
      abandon: () => { if (stream.abandon() === null) stream.finish(); this.bodyStreams.delete(stream); },
    };
  }

  private sessionBody(key: number, bytes: Uint8Array | null): void {
    if (this.bodyHandler) { this.bodyHandler(key, bytes); return; }
    // Every event counts, an end too: a peer that never attaches its session cannot pile up empty streams for free.
    this.earlySessionBytes += (bytes?.length ?? 0) + EARLY_BODY_EVENT_BYTES;
    if (this.earlySessionBytes > MAX_EARLY_SESSION_BYTES) { this.close(); return; }
    this.earlyBodies.push([key, bytes && bytes.slice()]);
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
    this.router.stop();
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
  const relaySends = new RelaySendCounters();
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
  let closed = false;
  let rawUdpInboundCount = 0;
  let triggerRebind: (reason: UdpRebindReason) => boolean = () => false;
  const identity = options.identity ?? generateIdentity();
  const bindAddress = options.bindAddress ?? '0.0.0.0';
  const requestedPort = validBindPort(options.bindPort);
  if (options.bindPort !== undefined && options.bindPort !== 0 && requestedPort === undefined) {
    options.onLog?.('warn', `agent-net ignoring invalid bindPort=${String(options.bindPort)}; using ephemeral UDP port`);
  }
  const createEndpoint = (port: number) => Endpoint.create({
    identity,
    prologue: PROLOGUE,
    sendPacketSize: SEND_PACKET_SIZE,
    ...(options.module ? { module: options.module } : {}),
    bind: { address: bindAddress, port },
    udp,
    udpTraffic: options.udpTraffic,
    accept: { admit },
    intercept: (datagram) => {
      rawUdpInboundCount += 1;
      return relayUdp?.intercept(datagram) || (stun?.intercept(datagram) ?? false);
    },
    onUdpSendError: (error, { consecutiveErrors }) => {
      if (closed || !udp) return;
      const errCode = (error as NodeJS.ErrnoException).code;
      if (consecutiveErrors >= UDP_SEND_ERROR_THRESHOLD || (errCode !== undefined && FATAL_UDP_SOCKET_ERRORS.has(errCode))) {
        triggerRebind('send-errors');
      }
    },
    ...(options.tap
      ? {
          // 只记发出的：每个节点都接了抓包时，线上每个数据报正好记一次。
          tap: (direction: 'in' | 'out', datagram: Uint8Array, address: PeerAddress) =>
            direction === 'out' && options.tap!(datagram, isLinkAddress(address) ? 'relay' : 'udp'),
        }
      : {}),
  });
  if (udp && requestedPort !== undefined) {
    try {
      endpoint = await createEndpoint(requestedPort);
      options.onLog?.('info', `agent-net UDP listening on fixed port ${endpoint.address().port}`);
    } catch (error) {
      const errCode = (error as NodeJS.ErrnoException | null)?.code;
      if (errCode !== 'EADDRINUSE' && errCode !== 'EACCES') throw error;
      endpoint = await createEndpoint(0);
      options.onLog?.('warn', `agent-net fixed UDP port ${requestedPort} unavailable (${errCode}); fell back to ephemeral port ${endpoint.address().port}`);
    }
  } else {
    endpoint = await createEndpoint(0);
  }
  relay?.uplink.onDatagram((relayId, datagram) => { relayUdp?.noteInbound(false); linkFor(relayId).deliver(datagram); });
  if (udp && relay?.udpCredentials && options.relayUdpServer) {
    const credentials = relay.udpCredentials;
    relayUdp = new RelayUdpPath({
      sendUdp: (to, datagram) => endpoint.sendUdp(to, datagram),
      server: options.relayUdpServer,
      credentials: () => credentials(),
      peers: () => (options.admittedPeers?.() ?? []).map((peer) => peer.relayId),
      deliver: (relayId, datagram) => linkFor(relayId).deliver(datagram),
      // 只算一直走中转的那段，并按连接拆分：直连的历史重传不算进来，单一对端抖动/掉线也不连坐其他健康对端（RelaySendCounters）。
      relayedSendCounters: () => relaySends.sampleDetailed(function* () {
        for (const channel of channels) {
          const stats = channel.stats();
          if (stats) yield {
            key: channel, relay: channel.addressKind() === 'relay',
            retransmitted: stats.retransmittedSegments ?? 0, sent: stats.packetsSent ?? 0,
            acknowledgedBytes: stats.acknowledgedBytes ?? 0,
          };
        }
      }()),
    });
  }
  const publicOnly = options.publicCandidatesOnly === true;
  const candidates: Address[] = [];
  const channels = new Set<CoreChannel>();
  const channelFor = (connection: Connection) => {
    const remoteId = hex(connection.remotePublicKey);
    const channel = new CoreChannel(connection, candidates, reprobeMs, publicOnly, () => {
      const id = relay && options.relayIdOf?.(remoteId);
      return id ? linkFor(id).address : null;
    });
    channels.add(channel); connection.once('close', () => channels.delete(channel)); return channel;
  };
  // Install admission listeners before any DNS/STUN wait. Relay RPC never waits for a UDP response.
  endpoint.on('connection', (connection: Connection) => options.onIncoming(channelFor(connection)));
  const dial: CoreDial = { ...(udp ? { udp: endpoint.address() } : {}), ...(relay ? { relayId: relay.deviceId } : {}) };

  const networkRebindCooldownMs = options.udpRebindCooldownMs ?? DEFAULT_NETWORK_REBIND_COOLDOWN_MS;
  const blackholeTimeoutMs = options.udpBlackholeTimeoutMs ?? DEFAULT_UDP_BLACKHOLE_TIMEOUT_MS;
  const autoRebindCooldownMs = (streak: number): number => {
    const base = AUTO_REBIND_BACKOFF_MS[Math.min(streak, AUTO_REBIND_BACKOFF_MS.length - 1)];
    if (options.udpRebindCooldownMs === undefined) return base;
    return Math.max(options.udpRebindCooldownMs, Math.round(options.udpRebindCooldownMs * (base / AUTO_REBIND_BACKOFF_MS[0])));
  };
  let socketOpenedAt = performance.now();
  let lastRebindAt = Number.NEGATIVE_INFINITY;
  let lastUdpAliveAt = Number.NEGATIVE_INFINITY;
  let autoRebindStreak = 0;
  let autoRebindsWithoutInbound = 0;
  let directCollapseAt: number | null = null;
  let rebinding: Promise<void> | null = null;
  let pendingNetworkRefresh = false;
  let lastObservedRawUdpInbound = 0;
  const channelDirectState = new WeakMap<CoreChannel, { direct: boolean; packetsReceived: number; retransmitted: number }>();

  const noteUdpAlive = (at = performance.now()) => {
    if (at > lastUdpAliveAt) lastUdpAliveAt = at;
    if (at > socketOpenedAt) {
      autoRebindStreak = 0;
      autoRebindsWithoutInbound = 0;
    }
  };

  let activeStunServers = dedupeStunServers(options.stunServers ?? []);
  let gathering = 0;
  let roundFound: Address[] = [];
  const publishCandidates = () => {
    const next = normalizeCandidates(roundFound, publicOnly);
    if (sameCandidateList(candidates, next)) return;
    candidates.splice(0, candidates.length, ...next);
    for (const channel of channels) channel.announceCandidates();
  };
  const queryStunServers = (round: number, servers: readonly string[]) => {
    if (!servers.length || closed || round !== gathering) return;
    if (!stun) stun = new StunClient((to, datagram) => endpoint.sendUdp(to, datagram));
    const client = stun;
    // 每个 STUN 独立并行查询、先到先公布，避免慢区或被墙的 STUN 阻塞本地与本区公网候选。
    for (const server of servers) {
      void client.query(server).then((mapped) => {
        if (closed || round !== gathering || !mapped) return;
        noteUdpAlive();
        roundFound.push(mapped);
        publishCandidates();
      }).catch(() => undefined);
    }
  };
  const gather = () => {
    const round = ++gathering;
    stun?.close();
    stun = null;
    roundFound = localInterfaceCandidates(endpoint);
    publishCandidates();
    queryStunServers(round, activeStunServers);
  };

  const refreshAfterNetworkChange = () => {
    if (closed) return;
    endpoint.localAddressChanged();
    if (udp) gather();
    relayUdp?.networkChanged();
    for (const channel of channels) channel.onLocalNetworkChanged();
  };

  /**
   * 受冷却与退避保护地重建底层 UDP 套接字（macOS 透明代理/VPN 启停后旧 UDP fd 会被系统永久废掉）：
   * 不关闭既有连接和中转通道，绑定新端口后立即同步发现端口、通知核心迁移、重置中转 UDP 冷却并重新收集/广播候选。
   */
  triggerRebind = (reason: UdpRebindReason): boolean => {
    if (closed || !udp) return false;
    if (rebinding) {
      if (reason === 'network-changed') pendingNetworkRefresh = true;
      return true;
    }
    const now = performance.now();
    if (reason !== 'network-changed') {
      // UDP 被防火墙彻底封禁时，自动重建在收不到任何合法 UDP 回包的情况下必须有上限，不能死循环重绑。
      const maxAuto = reason === 'udp-blackhole' && lastUdpAliveAt < socketOpenedAt ? 1 : MAX_AUTO_REBINDS_WITHOUT_INBOUND;
      if (autoRebindsWithoutInbound >= maxAuto) return false;
      if (now - lastRebindAt < autoRebindCooldownMs(autoRebindStreak)) return false;
      autoRebindStreak += 1;
      autoRebindsWithoutInbound += 1;
    } else if (now - lastRebindAt < networkRebindCooldownMs) {
      return false;
    }
    lastRebindAt = now;
    directCollapseAt = null;
    const run = (async () => {
      try {
        if (requestedPort !== undefined) {
          try {
            await endpoint.rebind({ address: bindAddress, port: requestedPort }, false);
          } catch (error) {
            const errCode = (error as NodeJS.ErrnoException | null)?.code;
            if (errCode !== 'EADDRINUSE' && errCode !== 'EACCES') throw error;
            await endpoint.rebind({ address: bindAddress, port: 0 }, false);
            options.onLog?.('warn', `agent-net fixed UDP port ${requestedPort} unavailable on rebind (${errCode}); fell back to ephemeral port ${endpoint.address().port}`);
          }
        } else {
          await endpoint.rebind({ address: bindAddress, port: 0 }, false);
        }
        if (closed) return;
        socketOpenedAt = performance.now();
        dial.udp = endpoint.address();
        options.onLocalPortChanged?.(dial.udp.port, reason);
        refreshAfterNetworkChange();
      } catch {
        if (!closed) refreshAfterNetworkChange();
      }
    })();
    rebinding = run;
    void run.finally(() => {
      if (rebinding === run) rebinding = null;
      if (pendingNetworkRefresh && !closed) {
        pendingNetworkRefresh = false;
        refreshAfterNetworkChange();
      }
    });
    return true;
  };

  /** 巡检 UDP 套接字是否陷入静默黑洞（全部直连退回中转，或曾经正常的中转 UDP 登记持续无回包且无任何合法 UDP 入站）。 */
  const checkUdpHealth = () => {
    if (closed || !udp || rebinding) return;
    const now = performance.now();
    const udpInboundMoved = rawUdpInboundCount > lastObservedRawUdpInbound;
    lastObservedRawUdpInbound = rawUdpInboundCount;
    if (relayUdp && relayUdp.verifiedAt > lastUdpAliveAt) noteUdpAlive(relayUdp.verifiedAt);
    let directCount = 0;
    let directRetransmittingWithoutUdp = false;
    let unwantedRelayCount = 0;
    let collapsedThisTick = false;
    for (const channel of channels) {
      const path = channel.path();
      const prev = channelDirectState.get(channel);
      const stats = channel.stats();
      const packetsReceived = stats?.packetsReceived ?? prev?.packetsReceived ?? 0;
      const retransmitted = stats?.retransmittedSegments ?? prev?.retransmitted ?? 0;
      if (path === 'direct') {
        directCount += 1;
        // 只有真实 UDP 入站与连接合法收包同时增长（或首次进入直连）才算直连 UDP 存活，避免 WebSocket 中转回包或垃圾 UDP 误判。
        if (!prev || !prev.direct || (packetsReceived > prev.packetsReceived && udpInboundMoved)) noteUdpAlive(now);
        else if (!udpInboundMoved && retransmitted > prev.retransmitted) directRetransmittingWithoutUdp = true;
        channelDirectState.set(channel, { direct: true, packetsReceived, retransmitted });
      } else if (path === 'relay') {
        if (!channel.isPreferringRelay()) {
          unwantedRelayCount += 1;
          if (prev?.direct) collapsedThisTick = true;
        }
        channelDirectState.set(channel, { direct: false, packetsReceived, retransmitted });
      }
    }
    if (directCount > 0) {
      directCollapseAt = null;
      // 直连正在重传且完全收不到 UDP 包时，立刻用轻量中转登记测一次底层 UDP 套接字是否还活着；
      // 曾在该套接字上正常收过回包的中转 UDP 若持续无确认且完全无 UDP 入站，不等 30 秒服务端超时即可提前重建。
      if (directRetransmittingWithoutUdp) relayUdp?.probeRegistrationNow();
      if (relayUdp && relayUdp.verifiedAt >= socketOpenedAt
        && relayUdp.unackedDurationMs(now) >= blackholeTimeoutMs
        && now - lastUdpAliveAt >= blackholeTimeoutMs) {
        triggerRebind('udp-blackhole');
      }
      return;
    }
    if (collapsedThisTick && unwantedRelayCount > 0) {
      directCollapseAt ??= now;
      // 立即用轻量中转登记探一下底层 UDP 套接字是否还活着（不改变冷却），活着就能在几十毫秒内取消重建。
      relayUdp?.probeRegistrationNow();
    }
    if (directCollapseAt !== null) {
      if (lastUdpAliveAt > directCollapseAt || unwantedRelayCount === 0) {
        directCollapseAt = null;
      } else if (now - directCollapseAt >= blackholeTimeoutMs) {
        triggerRebind('udp-blackhole');
        return;
      } else {
        // 持续尝试轻量中转登记（内部带 1s 节流），避免坍塌前不到 1s 刚发过登记导致跳过探测而误判黑洞。
        relayUdp?.probeRegistrationNow();
      }
    }
    if (relayUdp && relayUdp.unackedDurationMs(now) >= blackholeTimeoutMs && now - lastUdpAliveAt >= blackholeTimeoutMs) {
      triggerRebind('udp-blackhole');
    }
  };

  const healthPollMs = Math.min(DEFAULT_UDP_HEALTH_POLL_MS, Math.max(50, Math.floor(blackholeTimeoutMs / 4)));
  const healthTimer = udp ? setInterval(checkUdpHealth, healthPollMs) : null;
  healthTimer?.unref();

  if (udp) gather();
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
      // 显式换网（网卡/代理变更、中转意外断线重连等）：解除旧网络的自动重绑上限，优先重建 UDP 套接字以摆脱
      // macOS 透明代理废掉的旧 fd；若刚重建仍在冷却期内，仍刷新核心迁移、候选地址、中转 UDP 与直连重探。
      autoRebindsWithoutInbound = 0;
      autoRebindStreak = 0;
      directCollapseAt = null;
      if (udp && triggerRebind('network-changed')) return;
      refreshAfterNetworkChange();
    },
    setStunServers(servers: readonly string[]) {
      if (closed) return;
      const next = dedupeStunServers(servers);
      const previous = new Set(activeStunServers);
      const added = next.filter((server) => !previous.has(server));
      activeStunServers = next;
      if (udp && added.length) queryStunServers(gathering, added);
    },
    relayStalled() { relayUdp?.noteStall(); },
    relayRoute() {
      if (!relay || closed) return null;
      // 和 linkFor 里发数据报的判断是同一个：UDP 通着就走 UDP，否则走中转 WebSocket。
      if (relayUdp?.up) return { via: 'udp', rttMs: relayUdp.rttMs };
      const suspension = relayUdp?.suspension;
      return suspension ? { via: 'websocket', rttMs: null, udpSuspension: suspension } : { via: 'websocket', rttMs: null };
    },
    async close() {
      closed = true;
      if (healthTimer) clearInterval(healthTimer);
      stun?.close();
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
function localInterfaceCandidates(endpoint: Endpoint): Address[] {
  const local = endpoint.address();
  const found: Address[] = [];
  if (local.address === '0.0.0.0') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) found.push({ address: entry.address, port: local.port });
    }
  } else {
    found.push(local);
  }
  return found;
}

function normalizeCandidates(found: readonly Address[], publicOnly: boolean): Address[] {
  const seen = new Set<string>();
  return found
    .filter((address) => {
      if (publicOnly && isPrivate(address.address)) return false;
      const key = `${address.address}:${address.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)))
    .slice(0, MAX_CANDIDATES);
}

function sameCandidateList(a: readonly Address[], b: readonly Address[]): boolean {
  return a.length === b.length && a.every((item, index) => item.address === b[index].address && item.port === b[index].port);
}

function dedupeStunServers(servers: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of servers) {
    const server = typeof raw === 'string' ? raw.trim() : '';
    if (!server || seen.has(server)) continue;
    seen.add(server);
    out.push(server);
  }
  return out;
}

function validBindPort(port: unknown): number | undefined {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** 私有地址：局域网、运营商 NAT、链路本地。 */
function isPrivate(address: string): boolean {
  if (address.includes(':')) return /^(fe80:|fc|fd)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
