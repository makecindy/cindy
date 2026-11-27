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
} from '../../packages/agent-net-core/wasm/node.mts';
import os from 'node:os';
import { StunClient } from './stun.ts';
import { ChannelEvents, type PeerChannel, type RosterEntry, type Transport, type TransportOptions } from './transport.ts';

const PROLOGUE = 'cindy/agent-net-spike/edgehub/1';
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

/** 名册里怎么连上一台设备：UDP 地址、中转上的设备号，有哪个用哪个。 */
export interface CoreDial {
  udp?: Address;
  relayId?: string;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

class CoreChannel implements PeerChannel {
  readonly remoteId: string;
  private readonly events = new ChannelEvents();
  private readonly outbound: SendStream;
  private readonly control: SendStream;
  private candidates: Address[] = [];
  /** 下一轮从第几个候选地址验起。 */
  private nextCandidate = 0;
  private reprobe: NodeJS.Timeout | null = null;

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
    if (localCandidates.length) this.control.write(Buffer.from(`${JSON.stringify({ candidates: localCandidates })}\n`));
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
    let message: { candidates?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!Array.isArray(message.candidates)) return;
    this.candidates = message.candidates
      .filter((value): value is Address => !!value && typeof value.address === 'string' && Number.isInteger(value.port))
      .filter((value) => !this.publicOnly || !isPrivate(value.address))
      .sort((a, b) => Number(isPrivate(a.address)) - Number(isPrivate(b.address)))
      .slice(0, MAX_CANDIDATES);
    this.nextCandidate = 0;
    this.probeCandidates();
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
    if (!this.events.closed) this.outbound.write(bytes);
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.events.onData(handler);
  }

  onClose(handler: () => void): void {
    this.events.onClose(handler);
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

  close(): void {
    if (this.events.closed) return;
    this.stopReprobe();
    this.events.close();
    this.outbound.finish();
    this.control.finish();
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
  const linkFor = (relayId: string): Link => {
    let link = links.get(relayId);
    if (!link) {
      link = endpoint.createLink((datagram) => relay!.uplink.send(relayId, datagram), relay!.uplink.kind === 'agent-net' ? 1 : 2);
      links.set(relayId, link);
      relayIdOf.set(link.id, relayId);
    }
    return link;
  };

  // 被拒绝的一方收不到回复，会按重传节奏重发同一个握手请求；同一来源、同一身份在这段时间里只问一次名册。
  const refused = new Map<string, number>();
  const admit = ({ publicKey, from }: { publicKey: Uint8Array; from: PeerAddress }) => {
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
    bind: { address: options.bindAddress ?? '127.0.0.1' },
    udp,
    accept: { admit },
    intercept: (datagram) => stun?.intercept(datagram) ?? false,
    ...(options.tap
      ? {
          // 只记发出的：每个节点都接了抓包时，线上每个数据报正好记一次。
          tap: (direction: 'in' | 'out', datagram: Uint8Array, address: PeerAddress) =>
            direction === 'out' && options.tap!(datagram, isLinkAddress(address) ? 'relay' : 'udp'),
        }
      : {}),
  });
  relay?.uplink.onDatagram((relayId, datagram) => linkFor(relayId).deliver(datagram));
  const publicOnly = options.publicCandidatesOnly === true;
  const gathered = udp ? await gatherCandidates(endpoint, options.stunServers ?? [], (client) => (stun = client)) : [];
  const candidates = publicOnly ? gathered.filter((address) => !isPrivate(address.address)) : gathered;
  endpoint.on('connection', (connection: Connection) => options.onIncoming(new CoreChannel(connection, candidates, reprobeMs, publicOnly)));
  const dial: CoreDial = { ...(udp ? { udp: endpoint.address() } : {}), ...(relay ? { relayId: relay.deviceId } : {}) };
  return {
    id: hex(endpoint.publicKey),
    dial,
    async connect(entry: RosterEntry): Promise<PeerChannel> {
      if (!options.admit(entry.id)) throw new Error('peer is not in the roster');
      const target = entry.dial as CoreDial;
      // 有中转先走中转：一定连得上，之后再打洞。没有中转才直接走 UDP。
      const via: PeerAddress | null = relay && target.relayId ? linkFor(target.relayId).address : udp && target.udp ? target.udp : null;
      if (!via) throw new Error('no way to reach the peer');
      const connection = endpoint.connect(Buffer.from(entry.id, 'hex'), via);
      // 流的监听要在连接建好之前挂上，否则对端开流时的第一批数据没人接。
      const channel = new CoreChannel(connection, candidates, reprobeMs, publicOnly);
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
    async close() {
      endpoint.close();
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
