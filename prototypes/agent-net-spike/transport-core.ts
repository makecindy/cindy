/**
 * 自研传输：`packages/agent-net-core` 编成 WebAssembly，由它的 Node 驱动跑在本机 UDP 上。
 * 身份是 X25519 公钥（十六进制），名册外的公钥在 Noise 握手时就被拒绝，连回复都不给。
 * 每个方向开一条流传字节。协议里没有关闭通知，所以关闭 = 结束自己的流、等对端确认后再关连接；
 * 对端看到流结束就知道这一端走了。
 */
import {
  Endpoint,
  generateIdentity,
  type Address,
  type Connection,
  type RecvStream,
  type SendStream,
} from '../../packages/agent-net-core/wasm/node.mts';
import { ChannelEvents, type PeerChannel, type RosterEntry, type Transport, type TransportOptions } from './transport.ts';

const PROLOGUE = 'cindy/agent-net-spike/edgehub/1';
/** 握手要在这么久内完成，否则放弃这次连接（名册外的节点收不到任何回复）。 */
const CONNECT_TIMEOUT_MS = 3_000;
/** 关闭时最多等这么久让对端确认已写入的数据。 */
const DRAIN_TIMEOUT_MS = 2_000;
/** 和核心放弃握手的时间（`dead_after_us`）一样长。 */
const REFUSAL_MEMORY_MS = 30_000;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

class CoreChannel implements PeerChannel {
  readonly remoteId: string;
  private readonly events = new ChannelEvents();
  private readonly outbound: SendStream;

  constructor(private readonly connection: Connection) {
    this.remoteId = hex(connection.remotePublicKey);
    this.outbound = connection.openStream('normal');
    connection.on('stream', (stream: RecvStream) => {
      stream.on('data', (bytes: Uint8Array) => this.events.data(bytes));
      // 对端结束了它的流：它要走了，这一端也收尾。
      stream.on('end', () => this.close());
    });
    connection.on('close', () => this.events.close());
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

  close(): void {
    if (this.events.closed) return;
    this.events.close();
    this.outbound.finish();
    void this.connection.closeWhenDrained(DRAIN_TIMEOUT_MS);
  }
}

export async function createCoreTransport(options: TransportOptions): Promise<Transport> {
  // 被拒绝的一方收不到回复，会按重传节奏重发同一个握手请求；同一来源、同一身份在这段时间里只问一次名册。
  const refused = new Map<string, number>();
  const admit = ({ publicKey, from }: { publicKey: Uint8Array; from: Address }) => {
    const id = hex(publicKey);
    const key = `${id}|${from.address}|${from.port}`;
    const now = performance.now();
    const at = refused.get(key);
    if (at !== undefined && now - at < REFUSAL_MEMORY_MS) return false;
    if (options.admit(id)) return true;
    if (refused.size >= 1024) refused.clear();
    refused.set(key, now);
    return false;
  };
  const endpoint = await Endpoint.create({
    identity: generateIdentity(),
    prologue: PROLOGUE,
    bind: { address: '127.0.0.1' },
    accept: { admit },
    // 只记发出的：每个节点都接了抓包时，线上每个数据报正好记一次。
    ...(options.tap ? { tap: (direction: 'in' | 'out', datagram: Uint8Array) => direction === 'out' && options.tap!(datagram) } : {}),
  });
  endpoint.on('connection', (connection: Connection) => options.onIncoming(new CoreChannel(connection)));
  return {
    id: hex(endpoint.publicKey),
    dial: endpoint.address(),
    async connect(entry: RosterEntry): Promise<PeerChannel> {
      if (!options.admit(entry.id)) throw new Error('peer is not in the roster');
      const connection = endpoint.connect(Buffer.from(entry.id, 'hex'), entry.dial as Address);
      // 流的监听要在连接建好之前挂上，否则对端开流时的第一批数据没人接。
      const channel = new CoreChannel(connection);
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
    },
  };
}
