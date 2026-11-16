/**
 * EdgeHub 下面的点对点传输。EdgeHub 只要两样东西：经过认证的对端身份，和一条双向、可靠、有序的字节流。
 * 第 0 阶段用 QUIC（`transport-quic.ts`，iroh），第 6 步换成自研核心（`transport-core.ts`），两者跑同一套检查。
 * 第 7 步起自研核心还能经中转转发（`relay-client.ts`），先经中转连上，再打洞换到直连。
 */
import type { KeyObject } from 'node:crypto';
import type { RelayUplink } from './relay-client.ts';

/** 名册里的一台设备：传输层身份的文本形式，和怎么连上它。 */
export interface RosterEntry {
  id: string;
  dial: unknown;
}

export interface PeerChannel {
  /** 握手验证过的对端身份，和 {@link RosterEntry.id} 同一种写法。 */
  readonly remoteId: string;
  send(bytes: Uint8Array): void;
  /** 收到的字节按序给出。注册之前到达的会先存着。 */
  onData(handler: (bytes: Uint8Array) => void): void;
  /** 本端关掉、对端关掉或连接断开都会调用，只调一次。 */
  onClose(handler: () => void): void;
  close(): void;
  /** 数据现在走直连还是中转。只有自研传输知道。 */
  path?(): 'direct' | 'relay' | null;
  /** 数据现在发往哪类地址：中转、本机回环、私有地址（局域网、VPN 内网、运营商 NAT）、公网。只给类别，不给地址。 */
  addressKind?(): 'relay' | 'loopback' | 'private' | 'public' | null;
  /** 连接的计数，测试用。只有自研传输有。 */
  stats?(): Record<string, number> | null;
}

export interface Transport {
  readonly id: string;
  readonly dial: unknown;
  connect(entry: RosterEntry): Promise<PeerChannel>;
  close(): Promise<void>;
}

export interface TransportOptions {
  /** 对端身份不在名册里时返回 false，连接被拒绝。 */
  admit(remoteId: string): boolean;
  onIncoming(channel: PeerChannel): void;
  /** 线上的每个数据报。只有能看到数据报的传输会调用，测试用来检查有没有明文。 */
  tap?(datagram: Uint8Array, via: 'udp' | 'relay'): void;
  /** 经中转转发数据报（只有自研传输支持）。有它时先经中转连上，再交换候选地址打洞。 */
  relay?: { uplink: RelayUplink; deviceId: string };
  /** `false` 时不用 UDP，只走中转，和 UDP 全被挡一样。默认 `true`。 */
  udp?: boolean;
  /** 还在走中转时每隔这么久再验证一轮候选地址。 */
  reprobeMs?: number;
  /** 名册里登记这个身份的设备在中转上的设备号：经中转来的握手请求要和它一致。 */
  relayIdOf?(remoteId: string): string | undefined;
  /** UDP 绑在哪个本地地址，默认 `127.0.0.1`。`0.0.0.0` 时各网卡的地址都当候选地址。 */
  bindAddress?: string;
  /** 查公网地址用的 STUN 服务器（`主机:端口`），查到的外部地址也当候选地址。 */
  stunServers?: string[];
  /** 只交换、只验证公网候选地址：两台机器在同一个局域网时，用它强制走各自路由器之间的那条路（测试用）。 */
  publicCandidatesOnly?: boolean;
  /** 长期身份（X25519 私钥），不给就每次新生成。 */
  identity?: KeyObject;
}

export type TransportKind = 'core' | 'quic';

export async function createTransport(kind: TransportKind, options: TransportOptions): Promise<Transport> {
  // 按需加载：跑自研传输时不需要装 iroh。
  if (kind === 'quic') return (await import('./transport-quic.ts')).createQuicTransport(options);
  return (await import('./transport-core.ts')).createCoreTransport(options);
}

/** 先存着注册处理函数之前到达的数据和关闭事件。 */
export class ChannelEvents {
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly early: Uint8Array[] = [];
  private closedEarly = false;
  closed = false;

  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
    for (const bytes of this.early.splice(0)) handler(bytes);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closedEarly) handler();
  }

  data(bytes: Uint8Array): void {
    if (this.closed) return;
    if (this.dataHandler) this.dataHandler(bytes);
    else this.early.push(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeHandler) this.closeHandler();
    else this.closedEarly = true;
  }
}
