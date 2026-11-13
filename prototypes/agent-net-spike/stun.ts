/**
 * 查自己的公网地址：最小的 STUN Binding 请求（RFC 5389），从 agent-net 用的同一个 UDP 端口发出，
 * 这样拿到的就是 NAT 给这个端口的外部地址，打洞时告诉对端。回复用驱动的 `intercept` 截下，不交给核心。
 * 只认 XOR-MAPPED-ADDRESS（还有老服务器的 MAPPED-ADDRESS），不做认证、不重传以外的任何事。
 */
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import type { Address } from '../../packages/agent-net-core/wasm/node.mts';

const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAGIC_COOKIE = 0x2112a442;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;

interface Pending {
  resolve: (address: Address | null) => void;
  timer: NodeJS.Timeout;
}

export class StunClient {
  private readonly pending = new Map<string, Pending>();

  /** `send` 从 agent-net 的 UDP 端口发一个数据报（驱动的 `sendUdp`）。 */
  constructor(private readonly send: (to: Address, datagram: Uint8Array) => void) {}

  /** 交给驱动的 `intercept`：是这里发出的请求的回复就收下并返回 `true`。 */
  readonly intercept = (datagram: Uint8Array): boolean => {
    const bytes = Buffer.from(datagram.buffer, datagram.byteOffset, datagram.byteLength);
    if (bytes.length < 20 || bytes.readUInt32BE(4) !== MAGIC_COOKIE) return false;
    const id = bytes.subarray(8, 20).toString('hex');
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(bytes.readUInt16BE(0) === BINDING_SUCCESS ? parseMapped(bytes) : null);
    return true;
  };

  /** 向 `server`（`主机:端口`）查这个端口的外部地址，最多重发两次，查不到返回 `null`。 */
  async query(server: string, timeoutMs = 1_500): Promise<Address | null> {
    const [host, port] = splitHostPort(server);
    const { address } = await lookup(host, { family: 4 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomBytes(12);
      const request = Buffer.alloc(20);
      request.writeUInt16BE(BINDING_REQUEST, 0);
      request.writeUInt32BE(MAGIC_COOKIE, 4);
      id.copy(request, 8);
      const reply = new Promise<Address | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id.toString('hex'));
          resolve(null);
        }, timeoutMs / 3);
        this.pending.set(id.toString('hex'), { resolve, timer });
      });
      this.send({ address, port }, request);
      const mapped = await reply;
      if (mapped) return mapped;
    }
    return null;
  }
}

function splitHostPort(server: string): [string, number] {
  const index = server.lastIndexOf(':');
  return [server.slice(0, index), Number(server.slice(index + 1))];
}

function parseMapped(message: Buffer): Address | null {
  let offset = 20;
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  let plain: Address | null = null;
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const value = message.subarray(offset + 4, offset + 4 + length);
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && value.length >= 8 && value[1] === 0x01) {
      const xor = type === XOR_MAPPED_ADDRESS;
      const port = value.readUInt16BE(2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
      const ip = value.readUInt32BE(4) ^ (xor ? MAGIC_COOKIE : 0);
      const address = { address: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
      if (xor) return address;
      plain = address;
    }
    // 属性按 4 字节对齐。
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return plain;
}
