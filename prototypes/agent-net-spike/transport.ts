/**
 * EdgeHub 下面的点对点传输。EdgeHub 只要两样东西：经过认证的对端身份，和一条双向、可靠、有序的字节流。
 * 第 0 阶段用 QUIC（`transport-quic.ts`，iroh），第 6 步换成自研核心（`transport-core.ts`），两者跑同一套检查。
 */

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
  tap?(datagram: Uint8Array): void;
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
