/**
 * 压测的「网络」：每台设备到中转的限速线路（TCP 与 UDP 共用一条），供 harness.ts 在本进程里用，
 * 也供 network-process.ts 在单独的进程里用（默认）。单独的进程里，线路与中转的计时不受两台设备主线程上
 * Device Link 处理大消息时的卡顿影响，更接近真实部署（中转在服务器上）。
 */
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';

export interface LinkProfile {
  name: string;
  /** 每个方向的速率，字节每秒。 */
  rateBytesPerSec: number;
  /** 设备到中转的单程延迟；经中转的往返约为它的 4 倍。 */
  oneWayDelayMs: number;
  /** 线路上最多排这么多字节，超过就暂停读取，让发送方堵住。 */
  queueLimitBytes: number;
  /** 每块数据额外随机多等 0 到这么多毫秒（保持先后顺序，和 TCP 一样不乱序），模拟 Wi-Fi、跨境线路的抖动。 */
  jitterMs?: number;
}

/**
 * Windows 上 Node 的计时器按 15.6 毫秒的系统节拍走：每块数据各用一个 `setTimeout` 的话，零散的包每经过一跳
 * 会多等 0–15 毫秒，连续的流却不会。这会让零散消息的往返比连续流高出几十毫秒，被拥塞控制误当成排队。
 * 所以和核心的 Node 驱动一样：长于一个节拍的等待用计时器并提前一个节拍醒来，剩下的每轮事件循环看一次时间。
 */
const TIMER_GRANULARITY_MS = process.platform === 'win32' ? 16 : 1;

/** 一个方向的接入线路。同一台设备的所有连接共用它，和真实线路一样互相挤。 */
export class LinkDirection {
  bytes = 0;
  private nextFree = 0;
  private queued = 0;
  private readonly paused = new Set<net.Socket>();
  /** 发出时刻单调不减，按到达顺序排着，交付顺序不会乱。 */
  private readonly due: Array<{ at: number; chunk: Buffer; deliver: () => void }> = [];
  private wake: NodeJS.Timeout | NodeJS.Immediate | null = null;
  constructor(private readonly profile: LinkProfile) {}

  /** TCP：排队超过上限就暂停读取，让发送方的 socket 堵住。 */
  pipe(source: net.Socket, target: net.Socket): void {
    source.on('data', (chunk: Buffer) => {
      this.enqueue(chunk, () => { if (!target.destroyed) target.write(chunk); });
      if (this.queued > this.profile.queueLimitBytes) { source.pause(); this.paused.add(source); }
    });
  }

  /** UDP：和 TCP 共用同一条线路；排不下就丢（路由器的尾部丢弃），不会让发送方堵住。 */
  datagram(packet: Buffer, deliver: () => void): void {
    this.udpBytes += packet.length;
    if (this.queued + packet.length > this.profile.queueLimitBytes) { this.bytes += packet.length; this.dropped++; return; }
    this.enqueue(packet, deliver);
  }

  /** 其中走 UDP 的字节数与尾部丢弃的包数，用来确认数据确实没走 443 WebSocket。 */
  udpBytes = 0;
  dropped = 0;

  private enqueue(chunk: Buffer, deliver: () => void): void {
    this.bytes += chunk.length;
    const now = performance.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + (chunk.length / this.profile.rateBytesPerSec) * 1000;
    this.queued += chunk.length;
    const jitter = this.profile.jitterMs ? Math.random() * this.profile.jitterMs : 0;
    const last = this.due[this.due.length - 1]?.at ?? 0;
    this.due.push({ at: Math.max(last, this.nextFree + this.profile.oneWayDelayMs + jitter), chunk, deliver });
    if (!this.wake) this.schedule();
  }

  private schedule(): void {
    const head = this.due[0];
    if (!head) { this.wake = null; return; }
    const wait = head.at - performance.now();
    this.wake = wait > TIMER_GRANULARITY_MS
      ? setTimeout(() => this.pump(), wait - TIMER_GRANULARITY_MS)
      : setImmediate(() => this.pump());
  }

  private pump(): void {
    const now = performance.now();
    while (this.due.length && this.due[0].at <= now) {
      const { chunk, deliver } = this.due.shift()!;
      this.queued -= chunk.length;
      deliver();
    }
    if (this.queued <= this.profile.queueLimitBytes / 2) {
      for (const socket of this.paused) if (!socket.destroyed) socket.resume();
      this.paused.clear();
    }
    this.schedule();
  }
}

/** `listenHost`：设备从哪里连这个代理。默认本机回环；中转放在另一台电脑上时（--remote-network）听所有地址。 */
/** `secure`：代理自己终止 TLS（设备连 https/wss）。客户端只在加密连接上要中转的 UDP 凭据，公网实测要走 UDP 就得加密。 */
export async function startShapedProxy(targetPort: number, up: LinkDirection, down: LinkDirection, listenHost = '127.0.0.1',
  secure?: { cert: string; key: string }) {
  const sockets = new Set<net.Socket>();
  const accept = (device: net.Socket) => {
    const relay = net.connect(targetPort, '127.0.0.1');
    for (const socket of [device, relay]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.on('error', () => undefined);
      socket.on('close', () => { sockets.delete(socket); device.destroy(); relay.destroy(); });
    }
    up.pipe(device, relay);
    down.pipe(relay, device);
  };
  const server = secure ? tls.createServer({ cert: secure.cert, key: secure.key }, accept) : net.createServer(accept);
  await new Promise<void>((resolve) => server.listen(0, listenHost, resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

/**
 * 一台设备到中转 UDP 端口的线路：设备发到这个代理，代理用自己的一个端口转给中转，中转回到那个端口再转回设备。
 * 和这台设备的 TCP 线路共用 `up`/`down`，所以 UDP 与 443 WebSocket 一起挤同一条线。
 */
export async function startUdpProxy(relayUdpPort: number, up: LinkDirection, down: LinkDirection, listenHost = '127.0.0.1') {
  const front = dgram.createSocket('udp4'), back = dgram.createSocket('udp4');
  let device: { address: string; port: number } | null = null;
  // 关掉以后线路上还在排队的包到点了也不再发（发往已关闭的套接字会抛错）。
  let closed = false;
  front.on('message', (packet, from) => {
    device = { address: from.address, port: from.port };
    up.datagram(packet, () => { if (!closed) back.send(packet, relayUdpPort, '127.0.0.1'); });
  });
  back.on('message', (packet) => {
    const target = device;
    if (target) down.datagram(packet, () => { if (!closed) front.send(packet, target.port, target.address); });
  });
  for (const socket of [front, back]) socket.on('error', () => undefined);
  await Promise.all([new Promise<void>((resolve) => front.bind(0, listenHost, resolve)), new Promise<void>((resolve) => back.bind(0, '127.0.0.1', resolve))]);
  return {
    port: front.address().port,
    close: () => { closed = true; return Promise.all([front, back].map((socket) => new Promise<void>((resolve) => socket.close(() => resolve())))); },
  };
}
