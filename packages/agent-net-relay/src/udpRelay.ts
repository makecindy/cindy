/**
 * 经中继转发的 UDP 数据报（docs/agent-net-session-plan.md 第 8 节，协议记录
 * docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md）。
 *
 * 设备先经 443 WebSocket 认证。只有在加密的（或只在本机的）升级请求里声明 `x-agent-net-udp: 2` 时，中继才在 hello 里给
 * 这条会话一个随机会话号和一把密钥；旧中继、只认第 1 版格式的中继都不给，旧客户端不声明，所以新旧任意组合都照旧走 WebSocket。
 * 之后设备和中继之间的 UDP 包都用这把密钥算 HMAC-SHA256（取前 16 字节）：中继据此认定发送设备，设备据此确认包来自中继。
 * 数据报本身仍是两端传输核心的密文，中继只转发。
 *
 * 中继只往证明过的地址发数据报：登记确认里带一个只有中继算得出的地址凭证（绑定会话号、来源地址与时间段），设备从那个地址
 * 再登记时带回它，地址才算证明过。伪造来源地址的登记拿不到凭证，不能把流量引向别人（2026-11-17 审查：原来一个有效登记就能
 * 把会话的下行改到任意地址）。
 *
 * 和 STUN 共用中继的 UDP 端口，设备那头又和核心共用一个端口，所以类型字节要避开两边：STUN 首字节高两位为 0，
 * 核心的握手首字节是 `100`、数据包是 `101` 开头（0x80–0xBF，见 agent-net-core 的 secure.rs、wire.rs），
 * 这里用 `111` 开头的 0xE1–0xE4。
 * 对端用 8 字节摘要表示（设备号的 SHA-256 前 8 字节）。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const UDP_RELAY_HEADER = 'x-agent-net-udp';
/**
 * 这一版包格式在请求头里的值。2026-11-17 起是 2（登记带地址凭证、上行带计数器）；只认 1 的中继不给凭据，
 * 声明 1 的客户端拿不到凭据，格式不同的两端不会互相登记，都退回 WebSocket。
 */
export const UDP_RELAY_VERSION = '2';
export const UDP_RELAY_FEATURE = 'udp-relay-v2';
export const UDP_RELAY_REGISTER = 0xe1;
export const UDP_RELAY_REGISTER_ACK = 0xe2;
export const UDP_RELAY_UP = 0xe3;
export const UDP_RELAY_DOWN = 0xe4;
export const UDP_RELAY_SESSION_BYTES = 8;
export const UDP_RELAY_KEY_BYTES = 32;
export const UDP_RELAY_COOKIE_BYTES = 16;
const HASH_BYTES = 8;
const MAC_BYTES = 16;
const COUNTER_BYTES = 8;
/** 中转在核心的包外加的字节数：上行 `[类型 1][会话号 8][计数器 8][目的摘要 8][MAC 16]`，下行 `[类型 1][来源摘要 8][MAC 16]`。
 * 设备据此给核心的发包上限留出余量，经中转的 UDP 载荷才不会超过隧道的 MTU（见 agent-net 的 transport.ts）。 */
export const UDP_RELAY_UP_OVERHEAD = 1 + UDP_RELAY_SESSION_BYTES + COUNTER_BYTES + HASH_BYTES + MAC_BYTES;
export const UDP_RELAY_DOWN_OVERHEAD = 1 + HASH_BYTES + MAC_BYTES;
/**
 * 中继经 UDP 下发的数据报长度范围；范围外的照旧走 WebSocket。
 * - 上限：下行包不超过 1350 字节（隧道里不拆片，见 agent-net-send-packet-size.md）。旧版和 Mobile 原生按 1400 字节发，
 *   它们的大包经 WebSocket 送达，不在 UDP 上变成 1425 字节。
 * - 下限：核心最短的包（包头 3 + 连接号 4 + 1 字节帧 + 16 字节标签，见 agent-net-core 的 secure.rs）。更短的不是核心的包，
 *   不值得为它算一次 MAC、发一个 UDP 包：一个 WebSocket 帧里塞满 1 字节数据报，曾能让中继每帧发出两万多个 UDP 包。
 */
export const UDP_RELAY_MAX_FORWARD_BYTES = 1350 - UDP_RELAY_DOWN_OVERHEAD;
export const UDP_RELAY_MIN_FORWARD_BYTES = 24;
const MAX_DATAGRAM_BYTES = 65_000;
/** 上行计数器的接收窗口：比已收到的最大值小这么多以内、没收过的才收。UDP 会乱序，窗口要盖过一阵突发里的乱序深度。 */
export const UDP_RELAY_REPLAY_WINDOW = 1024;

/** 中继在 hello 里给的这条会话的 UDP 凭据。 */
export interface UdpRelayCredentials { session: Uint8Array; key: Uint8Array }

/** 设备号的 8 字节摘要；中继按它查同一网络里的目标会话，设备按它认来源。 */
export function udpRelayPeerHash(deviceId: string): Buffer {
  return createHash('sha256').update('cindy-agent-net/udp-relay/1\0' + deviceId).digest().subarray(0, HASH_BYTES);
}

export function isUdpRelayPacket(packet: Uint8Array): boolean {
  return packet.length > 0 && packet[0] >= UDP_RELAY_REGISTER && packet[0] <= UDP_RELAY_DOWN;
}

function mac(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const hmac = createHmac('sha256', key);
  for (const part of parts) hmac.update(part);
  return hmac.digest().subarray(0, MAC_BYTES);
}

function sameMac(expected: Buffer, actual: Uint8Array): boolean {
  return actual.length === MAC_BYTES && timingSafeEqual(expected, actual);
}

function counterBytes(counter: bigint): Buffer {
  const bytes = Buffer.alloc(COUNTER_BYTES);
  bytes.writeBigUInt64BE(counter);
  return bytes;
}

function readCounter(packet: Uint8Array, at: number): bigint {
  return Buffer.from(packet.buffer, packet.byteOffset + at, COUNTER_BYTES).readBigUInt64BE();
}

const NO_COOKIE = Buffer.alloc(UDP_RELAY_COOKIE_BYTES);

/**
 * 设备 → 中继：登记这条会话当前的 UDP 地址，也是保活。计数器只增，中继不接受旧的登记包。
 * `cookie`：中继最近一次确认里给的地址凭证（还没有就全 0）。中继只在它对得上这个包的来源地址时，才把发给这台设备的数据报
 * 改到这个地址。
 * `receiving`：设备最近收得到中继的确认，即中继经 UDP 发来的包能到。只有它为真，中继才把发给这台设备的数据报
 * 改走 UDP；为假时只确认登记、仍走 WebSocket。上行通、下行不通（NAT 换了端口、回程被挡）时，设备几秒内收不到
 * 确认就清掉它，中继下一次收到登记就退回 WebSocket，不会一直往收不到的地址发。
 */
export function encodeUdpRegister(credentials: UdpRelayCredentials, counter: bigint, receiving: boolean, cookie: Uint8Array | null = null): Buffer {
  const header = Buffer.concat([Buffer.of(UDP_RELAY_REGISTER), credentials.session, counterBytes(counter), Buffer.of(receiving ? 1 : 0),
    cookie && cookie.length === UDP_RELAY_COOKIE_BYTES ? cookie : NO_COOKIE]);
  return Buffer.concat([header, mac(credentials.key, header)]);
}

/** 设备 → 中继：发给 `dstHash` 那台设备的一个数据报。`counter` 每个上行包加一，中继按窗口丢掉重放的包。 */
export function encodeUdpUp(credentials: UdpRelayCredentials, counter: bigint, dstHash: Uint8Array, datagram: Uint8Array): Buffer {
  const header = Buffer.concat([Buffer.of(UDP_RELAY_UP), credentials.session, counterBytes(counter), dstHash]);
  return Buffer.concat([header, mac(credentials.key, header, datagram), datagram]);
}

/** 中继：登记包和上行包都以会话号开头，先用它找会话，再用会话的密钥验证。 */
export function readUdpRelaySession(packet: Uint8Array): Buffer | null {
  if ((packet[0] !== UDP_RELAY_REGISTER && packet[0] !== UDP_RELAY_UP) || packet.length < 1 + UDP_RELAY_SESSION_BYTES + MAC_BYTES) return null;
  return Buffer.from(packet.subarray(1, 1 + UDP_RELAY_SESSION_BYTES));
}

export function verifyUdpRegister(packet: Uint8Array, key: Uint8Array): { counter: bigint; receiving: boolean; cookie: Buffer } | null {
  const counterEnd = 1 + UDP_RELAY_SESSION_BYTES + COUNTER_BYTES, cookieStart = counterEnd + 1, end = cookieStart + UDP_RELAY_COOKIE_BYTES;
  if (packet[0] !== UDP_RELAY_REGISTER || packet.length !== end + MAC_BYTES) return null;
  if (!sameMac(mac(key, packet.subarray(0, end)), packet.subarray(end))) return null;
  return { counter: readCounter(packet, 1 + UDP_RELAY_SESSION_BYTES), receiving: packet[counterEnd] === 1,
    cookie: Buffer.from(packet.subarray(cookieStart, end)) };
}

export function verifyUdpUp(packet: Uint8Array, key: Uint8Array): { counter: bigint; dstHash: Buffer; datagram: Buffer } | null {
  const counterAt = 1 + UDP_RELAY_SESSION_BYTES, headerEnd = counterAt + COUNTER_BYTES + HASH_BYTES, macEnd = headerEnd + MAC_BYTES;
  if (packet[0] !== UDP_RELAY_UP || packet.length <= macEnd || packet.length - macEnd > MAX_DATAGRAM_BYTES) return null;
  const datagram = packet.subarray(macEnd);
  if (!sameMac(mac(key, packet.subarray(0, headerEnd), datagram), packet.subarray(headerEnd, macEnd))) return null;
  return { counter: readCounter(packet, counterAt), dstHash: Buffer.from(packet.subarray(counterAt + COUNTER_BYTES, headerEnd)),
    datagram: Buffer.from(datagram) };
}

/**
 * 中继 → 设备：确认收到第 `counter` 次登记，并给这个来源地址的凭证。`proven`：这次登记带回的凭证对得上来源地址，
 * 中继此后往这个地址发；为假时设备马上带上新凭证再登记一次。会话号参与 MAC，换了会话的旧确认对新会话无效。
 * 确认比登记短，不能被借来放大流量。
 */
export function encodeUdpRegisterAck(credentials: UdpRelayCredentials, counter: bigint, proven: boolean, cookie: Uint8Array): Buffer {
  const header = Buffer.concat([Buffer.of(UDP_RELAY_REGISTER_ACK), counterBytes(counter), Buffer.of(proven ? 1 : 0), cookie]);
  return Buffer.concat([header, mac(credentials.key, header, credentials.session)]);
}

/** 中继 → 设备：`srcHash` 那台设备发来的一个数据报。 */
export function encodeUdpDown(key: Uint8Array, srcHash: Uint8Array, datagram: Uint8Array): Buffer {
  const header = Buffer.concat([Buffer.of(UDP_RELAY_DOWN), srcHash]);
  return Buffer.concat([header, mac(key, header, datagram), datagram]);
}

export function verifyUdpRegisterAck(packet: Uint8Array, credentials: UdpRelayCredentials): { counter: bigint; proven: boolean; cookie: Buffer } | null {
  const counterEnd = 1 + COUNTER_BYTES, end = counterEnd + 1 + UDP_RELAY_COOKIE_BYTES;
  if (packet[0] !== UDP_RELAY_REGISTER_ACK || packet.length !== end + MAC_BYTES) return null;
  if (!sameMac(mac(credentials.key, packet.subarray(0, end), credentials.session), packet.subarray(end))) return null;
  return { counter: readCounter(packet, 1), proven: packet[counterEnd] === 1, cookie: Buffer.from(packet.subarray(counterEnd + 1, end)) };
}

export function verifyUdpDown(packet: Uint8Array, key: Uint8Array): { srcHash: Buffer; datagram: Buffer } | null {
  const headerEnd = 1 + HASH_BYTES, macEnd = headerEnd + MAC_BYTES;
  if (packet[0] !== UDP_RELAY_DOWN || packet.length <= macEnd || packet.length - macEnd > MAX_DATAGRAM_BYTES) return null;
  const datagram = packet.subarray(macEnd);
  if (!sameMac(mac(key, packet.subarray(0, headerEnd), datagram), packet.subarray(headerEnd, macEnd))) return null;
  return { srcHash: Buffer.from(packet.subarray(1, headerEnd)), datagram: Buffer.from(datagram) };
}

/**
 * 中继：地址凭证。用只有中继知道的密钥，绑定会话号、来源地址与端口、时间段；设备拿到它只能从同一个地址带回，
 * 别的地址（包括伪造的来源地址）算不出来。
 */
export function udpRelayAddressCookie(secret: Uint8Array, session: Uint8Array, address: string, port: number, epoch: number): Buffer {
  return createHmac('sha256', secret).update('cindy-agent-net/udp-relay/cookie/2\0').update(session)
    .update(`${epoch}|${address}|${port}`).digest().subarray(0, UDP_RELAY_COOKIE_BYTES);
}

export function sameUdpRelayCookie(expected: Buffer, actual: Uint8Array): boolean {
  return actual.length === UDP_RELAY_COOKIE_BYTES && timingSafeEqual(expected, actual);
}

/**
 * 计数器的接收窗口（中继收上行包用）：每个计数器只收一次，比已收到的最大值小 UDP_RELAY_REPLAY_WINDOW 以上的一律不收。
 * 只在 MAC 验证通过之后调用，伪造的包动不了窗口。
 */
export class UdpReplayWindow {
  private highest = 0n;
  private readonly seen = new Uint32Array(UDP_RELAY_REPLAY_WINDOW / 32);

  accept(counter: bigint): boolean {
    const window = BigInt(UDP_RELAY_REPLAY_WINDOW);
    if (counter === 0n) return false;
    if (counter > this.highest) {
      const ahead = counter - this.highest;
      if (ahead >= window) this.seen.fill(0);
      else {
        const from = Number(this.highest % window);
        for (let step = 1; step < Number(ahead); step++) this.clear((from + step) % UDP_RELAY_REPLAY_WINDOW);
      }
      this.highest = counter;
      this.mark(Number(counter % window));
      return true;
    }
    if (this.highest - counter >= window) return false;
    const index = Number(counter % window);
    if (this.has(index)) return false;
    this.mark(index);
    return true;
  }

  private has(index: number): boolean { return (this.seen[index >>> 5] & (1 << (index & 31))) !== 0; }
  private mark(index: number): void { this.seen[index >>> 5] |= 1 << (index & 31); }
  private clear(index: number): void { this.seen[index >>> 5] &= ~(1 << (index & 31)); }
}
