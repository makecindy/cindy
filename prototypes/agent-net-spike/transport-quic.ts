/**
 * 第 0 阶段的 QUIC 传输（iroh 官方 Node 绑定），只作对照，不进产品。
 * 身份是 iroh 的 EndpointId；QUIC 握手不看名册，握手完成后名册外的连接立即关掉。每个方向一条单向流。
 */
import { ALPN, addrOf, bindEndpoint } from './lib.mjs';
import { ChannelEvents, type PeerChannel, type RosterEntry, type Transport, type TransportOptions } from './transport.ts';

const READ_CHUNK = 256 * 1024;

class QuicChannel implements PeerChannel {
  readonly remoteId: string;
  private readonly events = new ChannelEvents();
  private readonly outbound: Promise<any>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly connection: any) {
    this.remoteId = connection.remoteId().toString();
    this.outbound = connection.openUni();
    void this.readLoop();
    void connection
      .closed()
      .catch(() => undefined)
      .then(() => this.events.close());
  }

  send(bytes: Uint8Array): void {
    if (this.events.closed) return;
    // writeAll 只收 number[]：第 0 阶段量出来的 19.7 MiB/s 主要慢在这里。
    const chunk = [...bytes];
    this.writes = this.writes
      .then(async () => (await this.outbound).writeAll(chunk))
      .catch(() => undefined);
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.events.onData(handler);
  }

  onClose(handler: () => void): void {
    this.events.onClose(handler);
  }

  close(): void {
    this.events.close();
    this.connection.close(0n, []);
  }

  private async readLoop(): Promise<void> {
    const inbound = await this.connection.acceptUni().catch(() => null);
    if (!inbound) return;
    for (;;) {
      const part: number[] = await inbound.read(READ_CHUNK).catch(() => []);
      if (part.length === 0) return;
      this.events.data(Uint8Array.from(part));
    }
  }
}

export async function createQuicTransport(options: TransportOptions): Promise<Transport> {
  const endpoint = await bindEndpoint();
  void (async () => {
    for (;;) {
      const incoming = await endpoint.acceptNext().catch(() => null);
      if (!incoming) return;
      void (async () => {
        const connection = await (await incoming.accept()).connect();
        if (!options.admit(connection.remoteId().toString())) {
          connection.close(1n, []);
          return;
        }
        options.onIncoming(new QuicChannel(connection));
      })().catch(() => undefined);
    }
  })();
  return {
    id: endpoint.id().toString(),
    dial: endpoint.boundSockets(),
    async connect(entry: RosterEntry): Promise<PeerChannel> {
      const connection = await endpoint.connect(addrOf(entry.id, entry.dial as string[]), ALPN);
      if (!options.admit(connection.remoteId().toString())) {
        connection.close(1n, []);
        throw new Error('peer is not in the roster');
      }
      return new QuicChannel(connection);
    },
    async close() {
      await endpoint.close();
    },
  };
}
