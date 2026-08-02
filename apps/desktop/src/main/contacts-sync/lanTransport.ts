/**
 * 同一局域网内的通讯录密文直连。
 *
 * relay presence 仍负责证明“这是同账号且在线的桌面设备”；本模块只在局域网用
 * UDP multicast 公布临时 TCP 端口。multicast 信标仅用于发现候选端点；每次发送
 * 仍须由 relay pin 的设备密钥完成 request / ACK 双向认证。实际 TCP 内容仍是
 * wire.ts 的 AES-GCM 密文，局域网监听者看不到通讯录。
 *
 * multicast / TCP 任一失败都只会让 send() 返回 false，调用方自动退回 relay。
 */

import dgram, { type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import net, { type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

import { isContactsSyncWireFrame, type ContactsSyncCipherChunkFrame } from './wire.js';
import {
  createContactsSyncLanProof,
  isValidContactsSyncPublicKey,
  verifyContactsSyncLanProof,
  type ContactsSyncLanAuthContext,
} from './crypto.js';

const MULTICAST_GROUP = '239.255.67.67';
const MULTICAST_PORT = 53546;
const BEACON_INTERVAL_MS = 5_000;
const ENDPOINT_TTL_MS = 15_000;
const CONNECT_TIMEOUT_MS = 1_500;
const DIRECT_RETRY_COOLDOWN_MS = 60_000;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_CONCURRENT_CONNECTIONS = 32;
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
  dstDeviceId: string;
  challenge: string;
  proof: string;
  frame: ContactsSyncCipherChunkFrame;
}

interface LanAck {
  version: 1;
  srcDeviceId: string;
  dstDeviceId: string;
  challenge: string;
  transferId: string;
  index: number;
  proof: string;
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
  getSelf(): { deviceId: string; publicKey: string; privateKey: string } | null;
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
  /** 未认证候选端点失败后按设备退避，避免伪信标让每个分片都付一次 TCP 超时。 */
  private readonly directRetryAfter = new Map<string, number>();
  private readonly activeSockets = new Set<Socket>();
  private generation = 0;

  constructor(private readonly options: LanContactsSyncTransportOptions) {}

  start(): void {
    if (this.tcpServer) return;
    const generation = ++this.generation;
    const server = net.createServer((socket) => {
      if (this.activeSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.activeSockets.add(socket);
      socket.once('close', () => this.activeSockets.delete(socket));
      this.handleConnection(socket);
    });
    server.maxConnections = MAX_CONCURRENT_CONNECTIONS;
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
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    this.tcpPort = null;
    this.endpoints.clear();
    this.directRetryAfter.clear();
  }

  /**
   * 找到近期同网段端点时尝试直发；只有收到认证 ACK 才算成功，否则返回 false，
   * 由调用方走 relay。
   */
  async send(deviceId: string, frame: ContactsSyncCipherChunkFrame): Promise<boolean> {
    const self = this.options.getSelf();
    const now = Date.now();
    const retryAfter = this.directRetryAfter.get(deviceId);
    if (retryAfter !== undefined) {
      if (retryAfter > now) return false;
      this.directRetryAfter.delete(deviceId);
    }
    const endpoint = this.endpoints.get(deviceId);
    if (
      !self ||
      !endpoint ||
      now - endpoint.seenAt > ENDPOINT_TTL_MS ||
      !this.options.isPeerAllowed(deviceId, endpoint.publicKey)
    ) {
      if (endpoint) this.endpoints.delete(deviceId);
      return false;
    }
    const challenge = randomBytes(24).toString('base64');
    const authContext = buildLanAuthContext('request', self.deviceId, deviceId, challenge, frame);
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        srcDeviceId: self.deviceId,
        dstDeviceId: deviceId,
        challenge,
        proof: createContactsSyncLanProof(self.privateKey, endpoint.publicKey, authContext),
        frame,
      } satisfies LanPacket),
      'utf8',
    );
    if (body.length > MAX_PACKET_BYTES) return false;
    const packet = encodePacket(body);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let response = Buffer.alloc(0);
      let expectedResponseBytes: number | null = null;
      const finish = (sent: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (!sent) {
          this.endpoints.delete(deviceId);
          this.directRetryAfter.set(deviceId, Date.now() + DIRECT_RETRY_COOLDOWN_MS);
        } else {
          this.directRetryAfter.delete(deviceId);
        }
        resolve(sent);
      };
      const socket = net.createConnection({ host: endpoint.address, port: endpoint.port });
      const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      timer.unref?.();
      socket.once('error', () => finish(false));
      socket.once('end', () => finish(false));
      socket.on('data', (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (expectedResponseBytes === null && response.length >= 4) {
          expectedResponseBytes = response.readUInt32BE(0);
          response = response.subarray(4);
          if (expectedResponseBytes <= 0 || expectedResponseBytes > 4_096) {
            finish(false);
            return;
          }
        }
        if (expectedResponseBytes === null || response.length < expectedResponseBytes) return;
        let ack: unknown;
        try {
          ack = JSON.parse(response.subarray(0, expectedResponseBytes).toString('utf8'));
        } catch {
          finish(false);
          return;
        }
        if (
          !isLanAck(ack) ||
          ack.srcDeviceId !== deviceId ||
          ack.dstDeviceId !== self.deviceId ||
          ack.challenge !== challenge ||
          ack.transferId !== frame.transferId ||
          ack.index !== frame.index
        ) {
          finish(false);
          return;
        }
        finish(
          verifyContactsSyncLanProof(ack.proof, self.privateKey, endpoint.publicKey, {
            ...authContext,
            kind: 'ack',
          }),
        );
      });
      socket.once('connect', () => {
        socket.write(packet);
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
    const retryAfter = this.directRetryAfter.get(parsed.deviceId);
    if (retryAfter !== undefined) {
      if (retryAfter > Date.now()) return;
      this.directRetryAfter.delete(parsed.deviceId);
    }
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
    let handled = false;
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled || buffer.length + chunk.length > MAX_PACKET_BYTES + 4) {
        socket.destroy();
        return;
      }
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
      handled = true;
      const body = buffer.subarray(0, expected);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        socket.destroy();
        return;
      }
      const self = this.options.getSelf();
      if (
        !self ||
        !isLanPacket(parsed) ||
        parsed.dstDeviceId !== self.deviceId ||
        !this.options.isPeerAllowed(parsed.srcDeviceId, parsed.frame.senderPublicKey)
      ) {
        socket.destroy();
        return;
      }
      const authContext = buildLanAuthContext(
        'request',
        parsed.srcDeviceId,
        parsed.dstDeviceId,
        parsed.challenge,
        parsed.frame,
      );
      if (
        !verifyContactsSyncLanProof(
          parsed.proof,
          self.privateKey,
          parsed.frame.senderPublicKey,
          authContext,
        )
      ) {
        socket.destroy();
        return;
      }
      try {
        this.options.onFrame(parsed.srcDeviceId, parsed.frame);
        const ack: LanAck = {
          version: 1,
          srcDeviceId: self.deviceId,
          dstDeviceId: parsed.srcDeviceId,
          challenge: parsed.challenge,
          transferId: parsed.frame.transferId,
          index: parsed.frame.index,
          proof: createContactsSyncLanProof(self.privateKey, parsed.frame.senderPublicKey, {
            ...authContext,
            kind: 'ack',
          }),
        };
        socket.end(encodePacket(Buffer.from(JSON.stringify(ack), 'utf8')));
      } catch {
        socket.destroy();
      }
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
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isDeviceId(value.srcDeviceId) ||
    !isDeviceId(value.dstDeviceId) ||
    !isExactBase64(value.challenge, 24) ||
    !isExactBase64(value.proof, 32)
  ) {
    return false;
  }
  return isContactsSyncWireFrame(value.frame) && value.frame.type === 'cipher-chunk';
}

function isLanAck(value: unknown): value is LanAck {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isDeviceId(value.srcDeviceId) &&
    isDeviceId(value.dstDeviceId) &&
    isExactBase64(value.challenge, 24) &&
    typeof value.transferId === 'string' &&
    value.transferId.length > 0 &&
    value.transferId.length <= 128 &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0 &&
    isExactBase64(value.proof, 32)
  );
}

function buildLanAuthContext(
  kind: ContactsSyncLanAuthContext['kind'],
  srcDeviceId: string,
  dstDeviceId: string,
  challenge: string,
  frame: ContactsSyncCipherChunkFrame,
): ContactsSyncLanAuthContext {
  return {
    kind,
    srcDeviceId,
    dstDeviceId,
    challenge,
    senderPublicKey: frame.senderPublicKey,
    transferId: frame.transferId,
    index: frame.index,
    total: frame.total,
    iv: frame.iv,
    tag: frame.tag,
    data: frame.data,
  };
}

function encodePacket(body: Buffer): Buffer {
  const packet = Buffer.allocUnsafe(body.length + 4);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

function isExactBase64(value: unknown, bytes: number): value is string {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
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
