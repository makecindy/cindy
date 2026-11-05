/**
 * agent-net 核心的 Node 驱动：UDP 套接字、单调时钟和加密算法由 Node 自带模块提供，
 * 连接逻辑在编译成 WebAssembly 的核心里（`wasm/src/lib.rs`，接口约定见那里的模块说明）。
 *
 * 不带任何产品专属的东西：身份、接受规则、传什么都由调用方决定。
 *
 * - 一个 {@link Endpoint} 是一个本地 UDP 端口，上面跑多条加密连接。套件固定为 X25519、AES-256-GCM 和 SHA-256。
 * - 长期私钥是调用方给的 `KeyObject`，只在这里做 X25519，不进 WebAssembly。
 * - 对称密钥导入成 `KeyObject`：Node 每次加密都用原始字节作密钥的话，一个包要 20 微秒，`KeyObject` 只要 4 微秒
 *   （2026-11-05，Windows）。代价是密钥字节在 Node 那边要等垃圾回收才释放，不能在丢弃时立即清零。
 * - 收到的数据报立刻交给核心；读数据、发确认、发数据攒到同一轮事件循环末尾一起做（`setImmediate`），
 *   计时器按核心给的下一次唤醒时间设。Windows 上 Node 的计时器按系统时钟节拍走，`setTimeout(1)` 实际要等约 15 毫秒，
 *   发送节奏、延迟确认和重传都会被拖慢；所以短于一个节拍的等待改成每轮事件循环看一次时间，长的等待提前一个节拍醒来。
 * - 流和核心一样是单向的：{@link Connection.openStream} 开一条发往对端的流，对端开的流从 `stream` 事件拿到。
 *   连接还带一条不用开的默认流（{@link Connection.write} 和 `data` 事件），它不能结束。
 */
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  createSecretKey,
  diffieHellman,
  generateKeyPairSync,
  randomFillSync,
  type KeyObject,
} from 'node:crypto';

/** X25519 公钥的 SPKI DER 前缀，后面接 32 字节公钥。 */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PUBLIC_KEY_LEN = 32;
const IO_LEN = 65_536;
const ADDR_LEN = 24;
const FINISHED_FLAG = 4_294_967_296;
const STATE_EXISTS = 1;
const STATE_ESTABLISHED = 2;
const STATE_DEAD = 4;
const STATE_UNACKED = 8;
/** 计时器的实际精度（微秒）：短于它的等待不交给 `setTimeout`。Windows 的系统时钟节拍是 15.6 毫秒。 */
const TIMER_GRANULARITY_US = process.platform === 'win32' ? 16_000 : 1_000;

export interface Address {
  address: string;
  port: number;
}

export type Priority = 'interactive' | 'normal' | 'background';
const PRIORITY_CODE: Record<Priority, number> = { interactive: 0, normal: 1, background: 2 };

export interface EndpointOptions {
  /** 本机长期身份，X25519 私钥。 */
  identity: KeyObject;
  /** 两端必须完全一致，可以放协议名和版本。 */
  prologue: Uint8Array | string;
  /** 默认 `0.0.0.0:0`。地址含冒号时开 IPv6 套接字。 */
  bind?: Partial<Address>;
  /** 单个 UDP 载荷的上限，默认 1400。 */
  maxPacketSize?: number;
  recovery?: 'auto' | 'lean' | 'fast';
  bandwidthShare?: 'full' | 'fair';
  /** 不给就不接受别人发起的连接。 */
  accept?: {
    /** 回复里附带的数据。 */
    payload?: Uint8Array;
    /** 看过对方的长期公钥、附带数据和来源地址后决定接不接受。只能做判断，不能调用这个端点。 */
    admit: (peer: { publicKey: Uint8Array; payload: Uint8Array; from: Address }) => boolean;
  };
  /** 线上每个数据报都会经过这里，测试用来检查有没有明文。 */
  tap?: (direction: 'in' | 'out', datagram: Uint8Array, address: Address) => void;
  /** 已编译的核心；不给就读本仓库 `target` 下的 release 产物。 */
  module?: WebAssembly.Module;
}

export interface ConnectionStats {
  srttUs: number;
  minRttUs: number;
  bandwidth: number;
  packetsSent: number;
  packetsReceived: number;
  wireBytesSent: number;
  wireBytesReceived: number;
  retransmittedSegments: number;
  handshakeRttUs: number;
  unauthenticatedPackets: number;
  replayedPackets: number;
  pathChallenges: number;
  migrations: number;
}

export interface EndpointStats {
  datagramsReceived: number;
  bytesReceived: number;
  datagramsSent: number;
  bytesSent: number;
  unknownDestination: number;
  rejectedInitiations: number;
  sendErrors: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  io_ptr(): number;
  addr_ptr(): number;
  init(maxPacketSize: number, recovery: number, share: number): number;
  listen(prologueLen: number, payloadLen: number): number;
  connect(now: number, prologueLen: number, payloadLen: number): number;
  datagram(now: number, len: number): void;
  transmit(now: number): number;
  tick(now: number): void;
  next_wake(): number;
  accept(): number;
  close(id: number): number;
  local_address_change(now: number): void;
  conn_state(id: number): number;
  conn_remote_static(id: number): number;
  conn_remote_payload(id: number): number;
  conn_peer(id: number): number;
  conn_open_stream(id: number, priority: number): number;
  conn_send(id: number, now: number, stream: number, len: number): number;
  conn_finish(id: number, stream: number): number;
  conn_recv(id: number, now: number, stream: number): number;
  conn_poll_event(id: number): number;
  conn_stats(id: number): number;
  stats(): number;
}

const DEFAULT_MODULE_URL = new URL('../target/wasm32-unknown-unknown/release/agent_net_wasm.wasm', import.meta.url);
let defaultModule: WebAssembly.Module | null = null;

/** 读本仓库里编好的核心：`cargo build --release -p agent-net-wasm --target wasm32-unknown-unknown`。 */
export function loadModule(): WebAssembly.Module {
  defaultModule ??= new WebAssembly.Module(readFileSync(DEFAULT_MODULE_URL));
  return defaultModule;
}

export function generateIdentity(): KeyObject {
  return generateKeyPairSync('x25519').privateKey;
}

export function publicKeyOf(identity: KeyObject): Uint8Array {
  const der = createPublicKey(identity).export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(der.length - PUBLIC_KEY_LEN));
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// ---- 地址：和核心约定的 24 字节编码 ----

/** 命名的 IPv6 作用域（`fe80::1%en0`）编成 2^31 以上的号；Windows 给的是数字，原样用。 */
const scopeNames: string[] = [];

function scopeOf(name: string): number {
  if (/^\d+$/.test(name)) return Number(name) >>> 0;
  let index = scopeNames.indexOf(name);
  if (index < 0) index = scopeNames.push(name) - 1;
  return (0x8000_0000 + index) >>> 0;
}

function scopeName(id: number): string {
  return id >= 0x8000_0000 ? (scopeNames[id - 0x8000_0000] ?? '') : String(id);
}

function parseIPv6(text: string, out: Uint8Array): void {
  let head = text;
  let tail: number[] | null = null;
  const last = text.slice(text.lastIndexOf(':') + 1);
  if (last.includes('.')) {
    tail = last.split('.').map(Number);
    head = `${text.slice(0, text.lastIndexOf(':') + 1)}0:0`;
  }
  const split = head.split('::');
  const left = split[0] ? split[0].split(':') : [];
  const right = split.length > 1 && split[1] ? split[1].split(':') : [];
  const groups = split.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) throw new Error(`invalid IPv6 address: ${text}`);
  groups.forEach((group, index) => {
    const value = parseInt(group, 16);
    out[index * 2] = value >> 8;
    out[index * 2 + 1] = value & 0xff;
  });
  if (tail) out.set(tail, 12);
}

function encodeAddress(view: Uint8Array, { address, port }: Address): void {
  view.fill(0);
  view[2] = port & 0xff;
  view[3] = port >> 8;
  if (isIPv4(address)) {
    view[0] = 4;
    view.set(address.split('.').map(Number), 8);
    return;
  }
  const percent = address.indexOf('%');
  const scope = percent >= 0 ? scopeOf(address.slice(percent + 1)) : 0;
  view[0] = 6;
  new DataView(view.buffer, view.byteOffset).setUint32(4, scope, true);
  parseIPv6(percent >= 0 ? address.slice(0, percent) : address, view.subarray(8, 24));
}

function decodeAddress(view: Uint8Array): Address {
  const port = view[2] | (view[3] << 8);
  if (view[0] === 4) return { address: `${view[8]}.${view[9]}.${view[10]}.${view[11]}`, port };
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(((view[8 + i * 2] << 8) | view[9 + i * 2]).toString(16));
  const scope = new DataView(view.buffer, view.byteOffset).getUint32(4, true);
  return { address: groups.join(':') + (scope ? `%${scopeName(scope)}` : ''), port };
}

// ---- 连接和流 ----

/** 发往对端的一条流。写入的数据先排队，核心的发送缓冲有空位时再交进去。 */
export class SendStream {
  private readonly queue: Uint8Array[] = [];
  private queued = 0;
  private finishing = false;
  private finished = false;

  constructor(
    private readonly connection: Connection,
    readonly id: number,
  ) {}

  /** 还没交给核心的字节数。 */
  get pendingBytes(): number {
    return this.queued;
  }

  /** 写入的数据和结束标记都已交给核心。 */
  get handedOver(): boolean {
    return this.queued === 0 && (!this.finishing || this.finished);
  }

  write(data: Uint8Array): void {
    if (this.finishing) throw new Error('stream finished');
    if (data.length === 0) return;
    this.queue.push(data);
    this.queued += data.length;
    this.connection.endpoint.schedule();
  }

  /** 不再写了。之前写入的数据发完后，对端会收到 `end`。默认流不能结束。 */
  finish(): void {
    this.finishing = true;
    this.connection.endpoint.schedule();
  }

  /** @internal 尽量把排队的数据交给核心，返回是否交出了数据。 */
  drain(core: Exports, io: () => Uint8Array, now: number): boolean {
    let moved = false;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const chunk = head.subarray(0, Math.min(head.length, IO_LEN));
      io().set(chunk);
      const accepted = core.conn_send(this.connection.id, now, this.id, chunk.length);
      if (accepted <= 0) break;
      moved = true;
      this.queued -= accepted;
      if (accepted < head.length) this.queue[0] = head.subarray(accepted);
      else this.queue.shift();
      if (accepted < chunk.length) break;
    }
    if (this.queue.length === 0 && this.finishing && !this.finished) {
      this.finished = core.conn_finish(this.connection.id, this.id) === 1;
    }
    return moved;
  }
}

/** 对端开的一条流：`data` 按序给出到达的数据，`end` 表示对端写完了、数据也全读走了。 */
export class RecvStream extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

export type CloseReason = 'local' | 'dead' | 'endpoint';

/**
 * 一条加密连接。事件：`established`（握手完成）、`stream`（对端开了流，给出 {@link RecvStream}）、
 * `data`（默认流的数据）、`close`（{@link CloseReason}）。协议里没有关闭通知：要让对端知道，先结束流再关。
 */
export class Connection extends EventEmitter {
  established = false;
  closed = false;
  /** @internal */
  readonly sendStreams = new Map<number, SendStream>();
  /** @internal */
  readonly recvStreams = new Map<number, RecvStream>();
  private defaultStream: SendStream | null = null;

  constructor(
    /** @internal */
    readonly endpoint: Endpoint,
    readonly id: number,
    readonly initiator: boolean,
    readonly remotePublicKey: Uint8Array,
  ) {
    super();
  }

  /** 开一条发往对端的流。流数到了上限时抛错。 */
  openStream(priority: Priority = 'normal'): SendStream {
    const id = this.endpoint.call((core) => core.conn_open_stream(this.id, PRIORITY_CODE[priority])) >>> 0;
    if (id === 0) throw new Error('cannot open stream');
    const stream = new SendStream(this, id);
    this.sendStreams.set(id, stream);
    return stream;
  }

  /** 写入默认流。 */
  write(data: Uint8Array): void {
    if (!this.defaultStream) {
      this.defaultStream = new SendStream(this, 0);
      this.sendStreams.set(0, this.defaultStream);
    }
    this.defaultStream.write(data);
  }

  /** 这一端写入的数据和结束标记是否都已交给核心并被对端确认。 */
  get drained(): boolean {
    if (this.closed) return true;
    if ([...this.sendStreams.values()].some((stream) => !stream.handedOver)) return false;
    return (this.endpoint.call((core) => core.conn_state(this.id)) & STATE_UNACKED) === 0;
  }

  /** 立即关掉，不再收发。 */
  close(): void {
    this.endpoint.closeConnection(this, 'local');
  }

  /** 等写入的数据都被对端确认再关，最多等 `timeoutMs`。 */
  async closeWhenDrained(timeoutMs = 2_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!this.closed && !this.drained && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.close();
  }

  /** 对端握手时附带的数据，握手完成前没有。 */
  remotePayload(): Uint8Array | null {
    return this.endpoint.call((core, io) => {
      const len = core.conn_remote_payload(this.id);
      return len < 0 ? null : io().slice(0, len);
    });
  }

  /** 数据现在发往的地址。 */
  peerAddress(): Address | null {
    return this.endpoint.call((core, _io, addr) => (core.conn_peer(this.id) === 1 ? decodeAddress(addr()) : null));
  }

  stats(): ConnectionStats | null {
    return this.endpoint.call((core, io) => {
      const count = core.conn_stats(this.id);
      if (count < 0) return null;
      const view = io();
      const v = new Float64Array(view.buffer.slice(view.byteOffset, view.byteOffset + count * 8));
      return {
        srttUs: v[0],
        minRttUs: v[1],
        bandwidth: v[2],
        packetsSent: v[3],
        packetsReceived: v[4],
        wireBytesSent: v[5],
        wireBytesReceived: v[6],
        retransmittedSegments: v[7],
        handshakeRttUs: v[8],
        unauthenticatedPackets: v[9],
        replayedPackets: v[10],
        pathChallenges: v[11],
        migrations: v[12],
      };
    });
  }
}

/**
 * 一个本地 UDP 端口和上面的所有连接。事件：`connection`（接受了别人发起的连接）、
 * `error`（核心出错，端点已经关掉）。
 */
export class Endpoint extends EventEmitter {
  private readonly core: Exports;
  private readonly connections = new Map<number, Connection>();
  private readonly epoch = performance.now();
  private readonly ephemerals = new Map<number, KeyObject>();
  private readonly keys = new Map<number, KeyObject>();
  private nextHandle = 1;
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private busy = false;
  private broken: Error | null = null;
  private panicMessage = '';
  private sendErrors = 0;
  private readonly ioOffset: number;
  private readonly addrOffset: number;
  readonly publicKey: Uint8Array;

  private constructor(private readonly options: EndpointOptions) {
    super();
    this.publicKey = publicKeyOf(options.identity);
    const instance = new WebAssembly.Instance(options.module ?? loadModule(), { host: this.hostImports() });
    this.core = instance.exports as unknown as Exports;
    this.ioOffset = this.core.io_ptr();
    this.addrOffset = this.core.addr_ptr();
  }

  static async create(options: EndpointOptions): Promise<Endpoint> {
    const endpoint = new Endpoint(options);
    endpoint.start();
    await endpoint.bindSocket(options.bind?.address ?? '0.0.0.0', options.bind?.port ?? 0);
    return endpoint;
  }

  /** 当前时间：从建这个端点起的微秒数，单调递增。 */
  now(): number {
    return Math.floor((performance.now() - this.epoch) * 1000);
  }

  address(): Address {
    const { address, port } = this.socket!.address();
    return { address, port };
  }

  /** 向 `peer` 发起加密连接。握手在后台进行，完成时连接发出 `established`。 */
  connect(remotePublicKey: Uint8Array, peer: Address, payload: Uint8Array = new Uint8Array()): Connection {
    const prologue = this.prologueBytes();
    const id =
      this.call((core, io, addr) => {
        const view = io();
        view.set(remotePublicKey.subarray(0, PUBLIC_KEY_LEN));
        view.set(prologue, PUBLIC_KEY_LEN);
        view.set(payload, PUBLIC_KEY_LEN + prologue.length);
        encodeAddress(addr(), peer);
        return core.connect(this.now(), prologue.length, payload.length);
      }) >>> 0;
    if (id === 0) throw new Error('handshake could not start (payload too large?)');
    const connection = new Connection(this, id, true, new Uint8Array(remotePublicKey));
    this.connections.set(id, connection);
    this.schedule();
    return connection;
  }

  /** 这一端换了网络（换了网卡或重新绑定了端口）：让每条连接马上发包，对端跟过来。 */
  localAddressChanged(): void {
    this.call((core) => core.local_address_change(this.now()));
    this.schedule();
  }

  /** 换一个本地地址重新绑定。`notify` 见 {@link localAddressChanged}。 */
  async rebind(bind: Partial<Address> = {}, notify = true): Promise<void> {
    const old = this.socket;
    await this.bindSocket(bind.address ?? old?.address().address ?? '0.0.0.0', bind.port ?? 0);
    old?.close();
    if (notify) this.localAddressChanged();
  }

  stats(): EndpointStats {
    return this.call((core, io) => {
      const count = core.stats();
      const view = io();
      const v = new Float64Array(view.buffer.slice(view.byteOffset, view.byteOffset + count * 8));
      return {
        datagramsReceived: v[0],
        bytesReceived: v[1],
        datagramsSent: v[2],
        bytesSent: v[3],
        unknownDestination: v[4],
        rejectedInitiations: v[5],
        sendErrors: this.sendErrors,
      };
    });
  }

  close(): void {
    if (!this.socket && this.broken) return;
    this.stop(null);
  }

  // ---- 内部 ----

  private prologueBytes(): Uint8Array {
    const { prologue } = this.options;
    return typeof prologue === 'string' ? Buffer.from(prologue) : prologue;
  }

  private start(): void {
    const { maxPacketSize = 1400, recovery = 'auto', bandwidthShare = 'full', accept } = this.options;
    const recoveryCode = { auto: 0, lean: 1, fast: 2 }[recovery];
    const shareCode = { full: 0, fair: 1 }[bandwidthShare];
    this.call((core, io) => {
      io().set(this.publicKey);
      if (core.init(maxPacketSize, recoveryCode, shareCode) !== 0) throw new Error('invalid endpoint options');
      if (!accept) return;
      const prologue = this.prologueBytes();
      const payload = accept.payload ?? new Uint8Array();
      io().set(prologue);
      io().set(payload, prologue.length);
      core.listen(prologue.length, payload.length);
    });
  }

  private bindSocket(address: string, port: number): Promise<void> {
    const socket = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
    socket.on('message', (message, remote) => this.onMessage(socket, message, remote));
    // 发往已关闭端口的包换回的 ICMP、网络不可达都不是致命错误，可靠层会重传。
    socket.on('error', () => undefined);
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, address, () => {
        socket.off('error', reject);
        this.socket = socket;
        resolve();
      });
    });
  }

  private onMessage(socket: dgram.Socket, message: Buffer, remote: dgram.RemoteInfo): void {
    if (socket !== this.socket || this.broken || message.length > IO_LEN) return;
    const from = { address: remote.address, port: remote.port };
    this.options.tap?.('in', message, from);
    try {
      this.call((core, io, addr) => {
        io().set(message);
        encodeAddress(addr(), from);
        core.datagram(this.now(), message.length);
      });
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }

  /** @internal 在这一轮事件循环末尾处理一次。 */
  schedule(): void {
    if (this.immediate || this.broken || !this.socket) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      this.pump();
    });
  }

  private pump(): void {
    if (this.broken || !this.socket) return;
    try {
      const now = this.now();
      this.call((core) => core.tick(now));
      for (;;) {
        const id = this.call((core) => core.accept()) >>> 0;
        if (id === 0) break;
        const key = this.call((core, io) => (core.conn_remote_static(id) === PUBLIC_KEY_LEN ? io().slice(0, PUBLIC_KEY_LEN) : null));
        if (!key) continue;
        const connection = new Connection(this, id, false, key);
        this.connections.set(id, connection);
        this.emit('connection', connection);
      }
      for (const connection of [...this.connections.values()]) this.service(connection, now);
      this.flush(now);
      this.armTimer();
    } catch (error) {
      this.fail(error);
    }
  }

  private service(connection: Connection, now: number): void {
    for (let rounds = 0; !connection.closed; rounds++) {
      const state = this.call((core) => core.conn_state(connection.id));
      if ((state & STATE_EXISTS) === 0 || (state & STATE_DEAD) !== 0) {
        this.closeConnection(connection, 'dead');
        return;
      }
      if (!connection.established && (state & STATE_ESTABLISHED) !== 0) {
        connection.established = true;
        connection.emit('established');
        continue;
      }
      let progressed = false;
      for (;;) {
        const event = this.call((core) => core.conn_poll_event(connection.id));
        if (event < 0) break;
        progressed = true;
        if (event >= FINISHED_FLAG) {
          const id = event - FINISHED_FLAG;
          const stream = connection.recvStreams.get(id);
          connection.recvStreams.delete(id);
          stream?.emit('end');
        } else if (!connection.recvStreams.has(event)) {
          const stream = new RecvStream(event);
          connection.recvStreams.set(event, stream);
          connection.emit('stream', stream);
        }
      }
      for (const id of [0, ...connection.recvStreams.keys()]) {
        for (;;) {
          if (connection.closed) return;
          const data = this.call((core, io) => {
            const len = core.conn_recv(connection.id, now, id);
            return len > 0 ? io().slice(0, len) : null;
          });
          if (!data) break;
          progressed = true;
          if (id === 0) connection.emit('data', data);
          else connection.recvStreams.get(id)?.emit('data', data);
        }
      }
      for (const stream of connection.sendStreams.values()) {
        if (connection.closed) return;
        if (this.call((core, io) => stream.drain(core, io, now))) progressed = true;
      }
      // 应用在回调里写了数据、读完了一条流，都可能带出新的事件或数据；没有进展就停。
      if (!progressed || rounds > 64) return;
    }
  }

  private flush(now: number): void {
    const socket = this.socket!;
    for (;;) {
      const packet = this.call((core, io, addr) => {
        const len = core.transmit(now);
        return len < 0 ? null : { data: io().slice(0, len), to: decodeAddress(addr()) };
      });
      if (!packet) return;
      this.options.tap?.('out', packet.data, packet.to);
      socket.send(packet.data, packet.to.port, packet.to.address, (error) => {
        if (error) this.sendErrors += 1;
      });
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const at = this.call((core) => core.next_wake());
    if (at < 0) return;
    const delayUs = at - this.now();
    // 短于计时器精度的等待放到下一轮事件循环再看；长的提前一个精度醒来，剩下的同样一轮一轮看。
    if (delayUs < TIMER_GRANULARITY_US) this.schedule();
    else this.timer = setTimeout(() => this.pump(), Math.floor((delayUs - TIMER_GRANULARITY_US) / 1000) + 1);
  }

  /** @internal */
  closeConnection(connection: Connection, reason: CloseReason): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection.id);
    if (!this.broken) this.call((core) => core.close(connection.id));
    connection.emit('close', reason);
  }

  /** @internal 调核心。核心出错（WebAssembly 陷阱）后实例的状态不可信，整个端点关掉。 */
  call<T>(run: (core: Exports, io: () => Uint8Array, addr: () => Uint8Array) => T): T {
    if (this.broken) throw this.broken;
    if (this.busy) throw new Error('agent-net endpoint re-entered from a callback');
    this.busy = true;
    try {
      return run(this.core, this.io, this.addr);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        const wrapped = new Error(`agent-net core trapped: ${this.panicMessage || error.message}`);
        this.busy = false;
        this.fail(wrapped);
        throw wrapped;
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private readonly io = () => new Uint8Array(this.core.memory.buffer, this.ioOffset, IO_LEN);
  private readonly addr = () => new Uint8Array(this.core.memory.buffer, this.addrOffset, ADDR_LEN);

  private fail(error: unknown): void {
    if (this.broken) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.stop(failure);
    if (this.listenerCount('error') > 0) this.emit('error', failure);
  }

  private stop(failure: Error | null): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
    for (const connection of [...this.connections.values()]) {
      if (failure) this.broken ??= failure;
      this.closeConnection(connection, 'endpoint');
    }
    this.broken ??= failure ?? new Error('endpoint closed');
    this.socket?.close();
    this.socket = null;
    this.keys.clear();
    this.ephemerals.clear();
  }

  private hostImports(): Record<string, (...args: number[]) => number | void> {
    const memory = () => new Uint8Array(this.core.memory.buffer);
    const bytes = (ptr: number, len: number) => new Uint8Array(this.core.memory.buffer, ptr, len);
    const nonceOf = (high: number, low: number) => {
      // AESGCM：4 个零字节加 8 字节大端计数。
      const nonce = Buffer.alloc(12);
      nonce.writeUInt32BE(high >>> 0, 4);
      nonce.writeUInt32BE(low >>> 0, 8);
      return nonce;
    };
    const handle = () => this.nextHandle++;
    const keyOf = (id: number) => {
      const key = this.keys.get(id);
      if (!key) throw new Error(`unknown key ${id}`);
      return key;
    };
    return {
      random: (ptr, len) => {
        randomFillSync(bytes(ptr, len));
      },
      panic: (ptr, len) => {
        this.panicMessage = Buffer.from(bytes(ptr, len)).toString('utf8');
      },
      ephemeral_new: (publicOut) => {
        const { privateKey, publicKey } = generateKeyPairSync('x25519');
        const der = publicKey.export({ format: 'der', type: 'spki' });
        memory().set(der.subarray(der.length - PUBLIC_KEY_LEN), publicOut);
        const id = handle();
        this.ephemerals.set(id, privateKey);
        return id;
      },
      ephemeral_drop: (id) => {
        this.ephemerals.delete(id);
      },
      dh_static: (peer, out) => this.x25519(this.options.identity, bytes(peer, PUBLIC_KEY_LEN), out),
      dh_ephemeral: (id, peer, out) => {
        const secret = this.ephemerals.get(id);
        return secret ? this.x25519(secret, bytes(peer, PUBLIC_KEY_LEN), out) : 0;
      },
      sha256: (ptr, len, out) => {
        memory().set(createHash('sha256').update(bytes(ptr, len)).digest(), out);
      },
      hmac_sha256: (key, ptr, len, out) => {
        memory().set(createHmac('sha256', bytes(key, 32)).update(bytes(ptr, len)).digest(), out);
      },
      key_new: (ptr) => {
        const id = handle();
        const raw = Buffer.from(bytes(ptr, 32));
        this.keys.set(id, createSecretKey(raw));
        raw.fill(0);
        return id;
      },
      key_drop: (id) => {
        this.keys.delete(id);
      },
      seal: (id, high, low, ad, adLen, buffer, len, tagOut) => {
        const cipher = createCipheriv('aes-256-gcm', keyOf(id), nonceOf(high, low), { authTagLength: 16 });
        cipher.setAAD(bytes(ad, adLen));
        const sealed = cipher.update(bytes(buffer, len));
        cipher.final();
        memory().set(sealed, buffer);
        memory().set(cipher.getAuthTag(), tagOut);
      },
      open: (id, high, low, ad, adLen, buffer, len, tag) => {
        const decipher = createDecipheriv('aes-256-gcm', keyOf(id), nonceOf(high, low), { authTagLength: 16 });
        decipher.setAAD(bytes(ad, adLen));
        decipher.setAuthTag(bytes(tag, 16));
        const opened = decipher.update(bytes(buffer, len));
        try {
          decipher.final();
        } catch {
          return 0;
        }
        memory().set(opened, buffer);
        return 1;
      },
      admit: (remote, payload, payloadLen, address) => {
        const admit = this.options.accept?.admit;
        if (!admit) return 0;
        try {
          const peer = {
            publicKey: bytes(remote, PUBLIC_KEY_LEN).slice(),
            payload: bytes(payload, payloadLen).slice(),
            from: decodeAddress(bytes(address, ADDR_LEN).slice()),
          };
          return admit(peer) ? 1 : 0;
        } catch {
          return 0;
        }
      },
    };
  }

  private x25519(privateKey: KeyObject, peer: Uint8Array, out: number): number {
    try {
      const shared = diffieHellman({ privateKey, publicKey: publicKeyObject(peer) });
      new Uint8Array(this.core.memory.buffer).set(shared, out);
      return 1;
    } catch {
      return 0;
    }
  }
}
