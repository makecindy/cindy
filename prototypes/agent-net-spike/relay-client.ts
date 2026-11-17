/**
 * 经中转转发 agent-net 数据报的两种方式，接口相同，传的都是两端核心加密过的数据报：
 *
 * - `agent-net`：自建中转的专用通道（`/api/device-link/agent-net`，`agent-net-relay-v1`），二进制帧，开销小。
 * - `push`：夹带在现有中转的 `push` 消息里（channel `agent-net:datagrams`，内容 base64）。不用改服务端，
 *   官方中转和已部署的自建中转都能用；代价是每个包多约三分之一的字节，中转还要解析 JSON。
 *
 * 两种都把同一轮事件循环里发往同一台设备的数据报攒成一帧：`[长度 2，大端][数据报]` 首尾相接。
 * 和 UDP 一样不保证送到，中转积压时丢掉也没关系，可靠层会重传。
 */
import WebSocket from 'ws';

export type UplinkKind = 'agent-net' | 'push';

/** 连远端中转时的 TLS：`servername` 同时用作 SNI 和 Host（前置 Nginx 按它分到测试中转），`ca` 是要信任的证书（自签的测试证书）。 */
export interface RelayTls {
  servername?: string;
  ca?: string;
}

export interface RelayUplink {
  readonly kind: UplinkKind;
  /** 发往对端设备（中转上的设备号）。 */
  send(deviceId: string, datagram: Uint8Array): void;
  onDatagram(handler: (deviceId: string, datagram: Uint8Array) => void): void;
  /** 经中转发出的数据报个数，测试用。 */
  readonly sent: number;
  close(): void;
}

const PUSH_CHANNEL = 'agent-net:datagrams';
const PING_INTERVAL_MS = 30_000;

function packBatch(datagrams: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  for (const datagram of datagrams) parts.push(Buffer.from([datagram.length >> 8, datagram.length & 0xff]), Buffer.from(datagram));
  return Buffer.concat(parts);
}

function unpackBatch(bytes: Buffer, emit: (datagram: Uint8Array) => void): void {
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes.readUInt16BE(offset);
    offset += 2;
    if (offset + length > bytes.length) return;
    emit(new Uint8Array(bytes.subarray(offset, offset + length)));
    offset += length;
  }
}

/** 每台目的设备一个队列，这一轮事件循环末尾一起发。 */
class Batcher {
  private readonly queues = new Map<string, Uint8Array[]>();
  private scheduled = false;

  constructor(private readonly flush: (deviceId: string, datagrams: Uint8Array[]) => void) {}

  add(deviceId: string, datagram: Uint8Array): void {
    const queue = this.queues.get(deviceId);
    if (queue) queue.push(datagram);
    else this.queues.set(deviceId, [datagram]);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      for (const [target, datagrams] of this.queues) this.flush(target, datagrams);
      this.queues.clear();
    });
  }
}

function open(url: string, credential: string, tls: RelayTls = {}): Promise<WebSocket> {
  const ws = new WebSocket(url, {
    headers: { authorization: `CindyRelay ${credential}`, ...(tls.servername ? { host: tls.servername } : {}) },
    ...(tls.servername ? { servername: tls.servername } : {}),
    ...(tls.ca ? { ca: tls.ca } : {}),
  });
  ws.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`relay refused the upgrade: ${res.statusCode}`)));
  });
}

const wsUrl = (base: string, pathname: string) => `${base.replace(/^http/, 'ws')}${pathname}`;

export async function connectAgentNetRelay(base: string, credential: string, tls?: RelayTls): Promise<RelayUplink> {
  const ws = await open(wsUrl(base, '/api/device-link/agent-net'), credential, tls);
  let handler: (deviceId: string, datagram: Uint8Array) => void = () => undefined;
  let sent = 0;
  const batcher = new Batcher((deviceId, datagrams) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const id = Buffer.from(deviceId, 'utf8');
    // 一帧不超过中转的 64 KiB 上限：满了就另起一帧。
    let batch: Uint8Array[] = [];
    let size = 2 + id.length;
    const emit = () => {
      if (batch.length) ws.send(Buffer.concat([Buffer.from([1, id.length]), id, packBatch(batch)]), { binary: true });
      batch = [];
      size = 2 + id.length;
    };
    for (const datagram of datagrams) {
      if (size + 2 + datagram.length > 64 * 1024) emit();
      batch.push(datagram);
      size += 2 + datagram.length;
    }
    emit();
    sent += datagrams.length;
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (frame.length < 2 || frame[0] !== 1) return;
    const source = frame.subarray(2, 2 + frame[1]).toString('utf8');
    unpackBatch(frame.subarray(2 + frame[1]), (datagram) => handler(source, datagram));
  });
  return {
    kind: 'agent-net',
    send: (deviceId, datagram) => batcher.add(deviceId, datagram),
    onDatagram: (next) => {
      handler = next;
    },
    get sent() {
      return sent;
    },
    close: () => ws.close(),
  };
}

export async function connectPushTunnel(base: string, credential: string, deviceName: string, tls?: RelayTls): Promise<RelayUplink> {
  const ws = await open(wsUrl(base, '/api/device-link/ws'), credential, tls);
  ws.send(JSON.stringify({ v: 1, kind: 'hello', payload: { deviceName, platform: 'darwin', appVersion: 'spike', remoteControlEnabled: false, busy: false } }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello-ack from the relay')), 5_000);
    const onMessage = (data: WebSocket.RawData) => {
      if ((JSON.parse(String(data)) as { kind?: string }).kind !== 'hello-ack') return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve();
    };
    ws.on('message', onMessage);
  });
  // 中转 90 秒收不到任何帧就断开连接。
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, kind: 'ping' })), PING_INTERVAL_MS);
  ping.unref();
  let handler: (deviceId: string, datagram: Uint8Array) => void = () => undefined;
  let sent = 0;
  const batcher = new Batcher((deviceId, datagrams) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // 中转一帧最多 2 MiB，base64 以后还要大三分之一：每帧最多带 256 KiB 的数据报。
    for (let start = 0; start < datagrams.length; ) {
      let end = start;
      let size = 0;
      while (end < datagrams.length && (end === start || size + datagrams[end].length < 256 * 1024)) size += 2 + datagrams[end++].length;
      const payload = packBatch(datagrams.slice(start, end)).toString('base64');
      ws.send(JSON.stringify({ v: 1, kind: 'push', dst: deviceId, payload: { channel: PUSH_CHANNEL, payload } }));
      start = end;
    }
    sent += datagrams.length;
  });
  ws.on('message', (data) => {
    let env: { kind?: string; src?: string; payload?: { channel?: string; payload?: unknown } };
    try {
      env = JSON.parse(String(data));
    } catch {
      return;
    }
    // 只认这个通道：在线状态、中转报错（对端不在线时的 DEVICE_OFFLINE）都和数据报无关，丢掉。
    if (env.kind !== 'push' || env.payload?.channel !== PUSH_CHANNEL || typeof env.src !== 'string' || typeof env.payload.payload !== 'string') return;
    const source = env.src;
    unpackBatch(Buffer.from(env.payload.payload, 'base64'), (datagram) => handler(source, datagram));
  });
  ws.on('close', () => clearInterval(ping));
  return {
    kind: 'push',
    send: (deviceId, datagram) => batcher.add(deviceId, datagram),
    onDatagram: (next) => {
      handler = next;
    },
    get sent() {
      return sent;
    },
    close: () => ws.close(),
  };
}
