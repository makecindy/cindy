/**
 * 同一局域网内的通讯录密文直连。
 *
 * relay presence 仍负责证明“这是同账号且在线的桌面设备”；本模块只在局域网用
 * UDP multicast 公布临时 TCP 端口。只有 deviceId 已在线且公钥已由 relay pin 的
 * 对端才会进入直连表。实际 TCP 内容仍是 wire.ts 的 AES-GCM 密文，局域网监听者
 * 看不到通讯录。
 *
 * multicast / TCP 任一失败都只会让 send() 返回 false，调用方自动退回 relay。
 */

import dgram, { type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import net, { type Server, type Socket } from 'node:net';

import { isContactsSyncWireFrame, type ContactsSyncCipherChunkFrame } from './wire.js';
import { isValidContactsSyncPublicKey } from './crypto.js';

const MULTICAST_GROUP = '239.255.67.67';
const MULTICAST_PORT = 53546;
const BEACON_INTERVAL_MS = 5_000;
const ENDPOINT_TTL_MS = 15_000;
const CONNECT_TIMEOUT_MS = 1_500;
const MAX_PACKET_BYTES = 512 * 1024;
const MAGIC = 'cindy-contacts-sync';

interface LanBeacon {
  magic: typeof MAGIC;
  version: 1;
  deviceId: string;
  publicKey: string;
  port: number;
}

interface LanPacket {
  version: 1;
  srcDeviceId: string;
  frame: ContactsSyncCipherChunkFrame;
}

interface PeerEndpoint {
  address: string;
  port: number;
  publicKey: string;
  seenAt: number;
}

export interface LanContactsSyncLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface LanContactsSyncTransportOptions {
  getSelf(): { deviceId: string; publicKey: string } | null;
  isPeerAllowed(deviceId: string, publicKey: string): boolean;
  onFrame(srcDeviceId: string, frame: ContactsSyncCipherChunkFrame): void;
  logger: LanContactsSyncLogger;
}

export class LanContactsSyncTransport {
  private tcpServer: Server | null = null;
  private udpSocket: DgramSocket | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private tcpPort: number | null = null;
  private readonly endpoints = new Map<string, PeerEndpoint>();
  private generation = 0;

  constructor(private readonly options: LanContactsSyncTransportOptions) {}

  start(): void {
    if (this.tcpServer) return;
    const generation = ++this.generation;
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.tcpServer = server;
    server.on('error', (error) => {
      this.options.logger.warn('contacts sync LAN TCP server failed', {
        error: error.message,
      });
      if (this.tcpServer === server) this.stop();
    });
    server.listen({ host: '0.0.0.0', port: 0, exclusive: false }, () => {
      if (generation !== this.generation || this.tcpServer !== server) return;
      const address = server.address();
      if (!address || typeof address === 'string') {
        this.stop();
        return;
      }
      this.tcpPort = address.port;
      this.startDiscovery(generation);
    });
    server.unref();
  }

  stop(): void {
    this.generation += 1;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    this.udpSocket?.close();
    this.udpSocket = null;
    this.tcpServer?.close();
    this.tcpServer = null;
    this.tcpPort = null;
    this.endpoints.clear();
  }

  /**
   * 找到近期同网段端点时直发；没有或连接失败返回 false，由调用方走 relay。
   */
  async send(deviceId: string, frame: ContactsSyncCipherChunkFrame): Promise<boolean> {
    const self = this.options.getSelf();
    const endpoint = this.endpoints.get(deviceId);
    if (
      !self ||
      !endpoint ||
      Date.now() - endpoint.seenAt > ENDPOINT_TTL_MS ||
      !this.options.isPeerAllowed(deviceId, endpoint.publicKey)
    ) {
      if (endpoint) this.endpoints.delete(deviceId);
      return false;
    }
    const body = Buffer.from(
      JSON.stringify({ version: 1, srcDeviceId: self.deviceId, frame } satisfies LanPacket),
      'utf8',
    );
    if (body.length > MAX_PACKET_BYTES) return false;
    const packet = Buffer.allocUnsafe(body.length + 4);
    packet.writeUInt32BE(body.length, 0);
    body.copy(packet, 4);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (sent: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (!sent) this.endpoints.delete(deviceId);
        resolve(sent);
      };
      const socket = net.createConnection({ host: endpoint.address, port: endpoint.port });
      const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      timer.unref?.();
      socket.once('error', () => finish(false));
      socket.once('connect', () => {
        socket.end(packet, () => finish(true));
      });
    });
  }

  private startDiscovery(generation: number): void {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udpSocket = udp;
    udp.on('error', (error) => {
      this.options.logger.debug('contacts sync LAN discovery unavailable; relay remains active', {
        error: error.message,
      });
      if (this.udpSocket === udp) {
        udp.close();
        this.udpSocket = null;
      }
    });
    udp.on('message', (message, remote) => this.handleBeacon(message, remote));
    udp.bind(MULTICAST_PORT, '0.0.0.0', () => {
      if (generation !== this.generation || this.udpSocket !== udp) return;
      try {
        udp.addMembership(MULTICAST_GROUP);
        udp.setMulticastTTL(1);
        udp.setMulticastLoopback(false);
      } catch (error) {
        this.options.logger.debug(
          'contacts sync LAN multicast setup failed; relay remains active',
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        udp.close();
        this.udpSocket = null;
        return;
      }
      this.sendBeacon();
      this.beaconTimer = setInterval(() => this.sendBeacon(), BEACON_INTERVAL_MS);
      this.beaconTimer.unref?.();
    });
    udp.unref();
  }

  private sendBeacon(): void {
    const self = this.options.getSelf();
    if (!self || !this.udpSocket || !this.tcpPort) return;
    const beacon: LanBeacon = {
      magic: MAGIC,
      version: 1,
      deviceId: self.deviceId,
      publicKey: self.publicKey,
      port: this.tcpPort,
    };
    const bytes = Buffer.from(JSON.stringify(beacon), 'utf8');
    this.udpSocket.send(bytes, MULTICAST_PORT, MULTICAST_GROUP, (error) => {
      if (error) {
        this.options.logger.debug('contacts sync LAN beacon failed; relay remains active', {
          error: error.message,
        });
      }
    });
  }

  private handleBeacon(message: Buffer, remote: RemoteInfo): void {
    if (message.length > 2_048) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    if (!isLanBeacon(parsed)) return;
    const self = this.options.getSelf();
    if (!self || parsed.deviceId === self.deviceId) return;
    if (!this.options.isPeerAllowed(parsed.deviceId, parsed.publicKey)) return;
    this.endpoints.set(parsed.deviceId, {
      address: normalizeRemoteAddress(remote.address),
      port: parsed.port,
      publicKey: parsed.publicKey,
      seenAt: Date.now(),
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === null && buffer.length >= 4) {
        expected = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (expected <= 0 || expected > MAX_PACKET_BYTES) {
          socket.destroy();
          return;
        }
      }
      if (expected === null || buffer.length < expected) return;
      const body = buffer.subarray(0, expected);
      socket.destroy();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return;
      }
      if (!isLanPacket(parsed)) return;
      if (!this.options.isPeerAllowed(parsed.srcDeviceId, parsed.frame.senderPublicKey)) return;
      this.options.onFrame(parsed.srcDeviceId, parsed.frame);
    });
    socket.on('error', () => {
      // 单次直连失败由发送方回退 relay；接收侧无需制造用户可见噪音。
    });
  }
}

function isLanBeacon(value: unknown): value is LanBeacon {
  if (!isRecord(value)) return false;
  return (
    value.magic === MAGIC &&
    value.version === 1 &&
    isDeviceId(value.deviceId) &&
    isValidContactsSyncPublicKey(value.publicKey) &&
    Number.isInteger(value.port) &&
    (value.port as number) > 0 &&
    (value.port as number) <= 65_535
  );
}

function isLanPacket(value: unknown): value is LanPacket {
  if (!isRecord(value) || value.version !== 1 || !isDeviceId(value.srcDeviceId)) return false;
  return isContactsSyncWireFrame(value.frame) && value.frame.type === 'cipher-chunk';
}

function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRemoteAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}
