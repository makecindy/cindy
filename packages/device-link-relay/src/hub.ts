/**
 * WebSocket 中转:与官方 relay 相同的线协议(`@cindy/device-link-protocol` v1)。
 *
 * 只理解连接层帧与路由头;隧道层 payload(invoke 的 channel/args、push 内容)原样转发,不解析。
 * 与官方行为对齐的要点:
 * - `hello` 必须是第一帧;回 `hello-ack`,deviceId 来自凭证绑定的设备,不信任客户端自报。
 * - 转发时覆写 `src`;目标不在线回 `DEVICE_OFFLINE`,发起控制但目标关闭了「允许被控」回 `REMOTE_DISABLED`。
 * - 单帧超过 2 MiB 回 `PAYLOAD_TOO_LARGE`,不断开;协议版本不符用 4400 关闭(reason 含 version)。
 * - 同一设备新连接顶替旧连接(4409);设备被移除用 4410(客户端停止重连);接收方积压过多用 1013。
 * - hello-ack 不声明任何能力:不收 notify,不转发跨账号(sharedTask / providerShare)帧。
 * - 设备签名 `auth` 原样转发;中转无法伪造它(收件设备用主人签发的证书核对)。
 */
import {
  CONTROL_KINDS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ROUTED_KINDS,
  type DeviceInfo,
  type Envelope,
  type HelloAckPayload,
  type PresenceSnapshot,
  type RelayErrorCode,
} from '@cindy/device-link-protocol';
import WebSocket from 'ws';
import type { RelayLogger } from './logger';
import type { RelayStore, StoredDevice } from './store';

export const CLOSE_VERSION_MISMATCH = 4400;
export const CLOSE_HELLO_REQUIRED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_DEVICE_REMOVED = 4410;
export const CLOSE_TOO_MANY_CONNECTIONS = 4429;
export const CLOSE_CONGESTED = 1013;
/** 设备签名字段的长度上限(正常约 160 字符)。 */
const MAX_AUTH_CHARS = 512;

export interface HubLimits {
  helloTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
  maxConnectionsPerDevice: number;
  maxBufferedBytes: number;
}

export const DEFAULT_HUB_LIMITS: HubLimits = {
  helloTimeoutMs: 15_000,
  idleTimeoutMs: 90_000,
  maxConnections: 256,
  maxConnectionsPerDevice: 4,
  maxBufferedBytes: 16 * 1024 * 1024,
};

interface Connection {
  ws: WebSocket;
  deviceId: string;
  ready: boolean;
  remoteControlEnabled: boolean;
  busy: boolean;
  lastInboundAt: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

function displayName(device: StoredDevice): string {
  return device.customName ?? device.reportedName;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function sanitizeDeviceInfo(value: unknown): DeviceInfo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const info: DeviceInfo = {};
  const cpuLabel = boundedString(raw.cpuLabel, 128);
  const osVersion = boundedString(raw.osVersion, 128);
  const modelLabel = boundedString(raw.modelLabel, 128);
  if (cpuLabel) info.cpuLabel = cpuLabel;
  if (osVersion) info.osVersion = osVersion;
  if (modelLabel) info.modelLabel = modelLabel;
  if (typeof raw.memoryGb === 'number' && Number.isFinite(raw.memoryGb) && raw.memoryGb >= 0) {
    info.memoryGb = raw.memoryGb;
  }
  return Object.keys(info).length > 0 ? info : null;
}

export class Hub {
  private readonly active = new Map<string, Connection>();
  private readonly connections = new Set<Connection>();
  private readonly idleTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: RelayStore,
    private readonly ownerUserId: string,
    private readonly now: () => number,
    private readonly logger: RelayLogger,
    private readonly limits: HubLimits = DEFAULT_HUB_LIMITS,
  ) {
    this.idleTimer = setInterval(() => this.closeIdle(), Math.min(30_000, limits.idleTimeoutMs));
    this.idleTimer.unref?.();
  }

  get onlineCount(): number {
    return this.active.size;
  }

  isOnline(deviceId: string): boolean {
    return this.active.has(deviceId);
  }

  connectionCountFor(deviceId: string): number {
    let count = 0;
    for (const conn of this.connections) if (conn.deviceId === deviceId) count++;
    return count;
  }

  /** 接管一条已通过凭证认证的 WebSocket。 */
  attach(ws: WebSocket, device: StoredDevice): void {
    if (
      this.connections.size >= this.limits.maxConnections ||
      this.connectionCountFor(device.deviceId) >= this.limits.maxConnectionsPerDevice
    ) {
      ws.close(CLOSE_TOO_MANY_CONNECTIONS, 'too many connections');
      return;
    }
    const conn: Connection = {
      ws,
      deviceId: device.deviceId,
      ready: false,
      remoteControlEnabled: false,
      busy: false,
      lastInboundAt: this.now(),
      helloTimer: null,
    };
    conn.helloTimer = setTimeout(() => {
      if (!conn.ready) ws.close(CLOSE_HELLO_REQUIRED, 'hello required');
    }, this.limits.helloTimeoutMs);
    conn.helloTimer.unref?.();
    this.connections.add(conn);
    ws.on('error', () => undefined);
    ws.on('message', (data, isBinary) => {
      conn.lastInboundAt = this.now();
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (isBinary) {
        this.sendError(conn, undefined, 'BAD_REQUEST', 'binary frames are not supported');
        return;
      }
      this.handleFrame(conn, buffer);
    });
    ws.on('close', () => this.detach(conn));
  }

  private detach(conn: Connection): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    this.connections.delete(conn);
    if (this.active.get(conn.deviceId) !== conn) return;
    this.active.delete(conn.deviceId);
    const device = this.store.update(conn.deviceId, { lastSeenAt: this.now() });
    if (device) this.broadcast(this.presenceOf(device));
  }

  private handleFrame(conn: Connection, buffer: Buffer): void {
    let env: Envelope;
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      env = parsed as Envelope;
    } catch {
      this.sendError(conn, undefined, 'BAD_REQUEST', 'frame is not a JSON object');
      return;
    }
    const id = typeof env.id === 'string' ? env.id : undefined;
    if (buffer.byteLength > MAX_FRAME_BYTES) {
      this.sendError(conn, id, 'PAYLOAD_TOO_LARGE', 'frame exceeds the size limit', env.dst);
      return;
    }
    if (env.v !== PROTOCOL_VERSION) {
      conn.ws.close(CLOSE_VERSION_MISMATCH, 'protocol version mismatch');
      return;
    }
    if (!conn.ready) {
      if (env.kind === 'hello') this.handleHello(conn, env.payload);
      else conn.ws.close(CLOSE_HELLO_REQUIRED, 'hello required');
      return;
    }
    switch (env.kind) {
      case 'ping':
        this.send(conn, { v: PROTOCOL_VERSION, kind: 'pong' });
        return;
      case 'presence-set':
        this.handlePresenceSet(conn, env.payload);
        return;
      case 'notify':
        // 未声明 notify 能力:与旧版官方 relay 一致,静默丢弃。
        return;
      default:
        if (ROUTED_KINDS.has(env.kind)) this.route(conn, env, id);
        else this.sendError(conn, id, 'BAD_REQUEST', 'unexpected frame kind');
    }
  }

  private handleHello(conn: Connection, payload: unknown): void {
    const device = this.store.get(conn.deviceId);
    const hello = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const deviceName = boundedString(hello?.deviceName, 256);
    const platform = boundedString(hello?.platform, 32);
    const appVersion = boundedString(hello?.appVersion, 64);
    if (!device || !hello || !deviceName || !platform || !appVersion ||
      typeof hello.remoteControlEnabled !== 'boolean' || typeof hello.busy !== 'boolean') {
      conn.ws.close(CLOSE_VERSION_MISMATCH, 'invalid hello');
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    const previous = this.active.get(conn.deviceId);
    if (previous && previous !== conn) {
      // 先摘掉旧连接,它的 close 回调不能把新连接的在线状态改成离线。
      this.active.delete(conn.deviceId);
      previous.ws.close(CLOSE_REPLACED, 'replaced by a newer connection');
    }
    conn.ready = true;
    conn.remoteControlEnabled = hello.remoteControlEnabled;
    conn.busy = hello.busy;
    this.active.set(conn.deviceId, conn);
    const updated = this.store.update(conn.deviceId, {
      reportedName: deviceName,
      platform,
      appVersion,
      deviceInfo: sanitizeDeviceInfo(hello.deviceInfo),
      lastSeenAt: this.now(),
    })!;
    const ack: HelloAckPayload = {
      serverProtocolVersion: PROTOCOL_VERSION,
      deviceId: conn.deviceId,
      userId: this.ownerUserId,
      capabilities: [],
    };
    this.send(conn, { v: PROTOCOL_VERSION, kind: 'hello-ack', payload: ack });
    for (const [deviceId] of this.active) {
      if (deviceId === conn.deviceId) continue;
      const other = this.store.get(deviceId);
      if (other) this.send(conn, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: this.presenceOf(other) });
    }
    this.broadcast(this.presenceOf(updated));
  }

  private handlePresenceSet(conn: Connection, payload: unknown): void {
    const patch = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (typeof patch.remoteControlEnabled === 'boolean') conn.remoteControlEnabled = patch.remoteControlEnabled;
    if (typeof patch.busy === 'boolean') conn.busy = patch.busy;
    const device = this.store.get(conn.deviceId);
    if (device) this.broadcast(this.presenceOf(device));
  }

  private route(conn: Connection, env: Envelope, id: string | undefined): void {
    if (env.sharedTask !== undefined || env.providerShare !== undefined) {
      this.sendError(conn, id, 'BAD_REQUEST', 'cross-account frames are not available on a self-hosted relay', env.dst);
      return;
    }
    const dst = typeof env.dst === 'string' ? env.dst : undefined;
    const target = dst ? this.active.get(dst) : undefined;
    if (!target) {
      this.sendError(conn, id, 'DEVICE_OFFLINE', 'target device is offline', dst);
      return;
    }
    if (CONTROL_KINDS.has(env.kind) && !target.remoteControlEnabled) {
      this.sendError(conn, id, 'REMOTE_DISABLED', 'target device does not allow remote control', dst);
      return;
    }
    const forwarded: Envelope & { auth?: unknown } = { v: PROTOCOL_VERSION, kind: env.kind, src: conn.deviceId, dst };
    if (id !== undefined) forwarded.id = id;
    if (env.payload !== undefined) forwarded.payload = env.payload;
    // 设备签名(docs/self-hosted-relay-plan.md §16)原样转给收件设备,由它核对;中转不解析。
    const auth = (env as Envelope & { auth?: unknown }).auth;
    if (auth !== undefined) {
      if (!auth || typeof auth !== 'object' || Array.isArray(auth) || JSON.stringify(auth).length > MAX_AUTH_CHARS) {
        this.sendError(conn, id, 'BAD_REQUEST', 'invalid frame signature field', dst);
        return;
      }
      forwarded.auth = auth;
    }
    if (!this.send(target, forwarded)) {
      this.sendError(conn, id, 'DEVICE_OFFLINE', 'target device is not accepting frames', dst);
    }
  }

  presenceOf(device: StoredDevice): PresenceSnapshot {
    const conn = this.active.get(device.deviceId);
    return {
      deviceId: device.deviceId,
      online: Boolean(conn),
      deviceName: displayName(device),
      selfName: device.reportedName,
      deviceInfo: device.deviceInfo,
      platform: device.platform ?? '',
      appVersion: device.appVersion ?? '',
      lastSeenAt: conn ? this.now() : device.lastSeenAt ?? 0,
      remoteControlEnabled: conn?.remoteControlEnabled ?? false,
      busy: conn?.busy ?? false,
    };
  }

  /** REST `/devices` 的设备视图(与官方 `DeviceView` 同形)。 */
  deviceView(device: StoredDevice, selfId: string) {
    const conn = this.active.get(device.deviceId);
    const lastSeenAt = conn ? this.now() : device.lastSeenAt;
    return {
      deviceId: device.deviceId,
      name: displayName(device),
      selfName: device.reportedName,
      deviceInfo: device.deviceInfo,
      platform: device.platform,
      appVersion: device.appVersion,
      lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
      online: Boolean(conn),
      busy: conn?.busy ?? false,
      remoteControlEnabled: conn?.remoteControlEnabled ?? false,
      isSelf: device.deviceId === selfId,
    };
  }

  /** 设备档案变化(改名)后通知所有在线设备。 */
  announce(device: StoredDevice): void {
    this.broadcast(this.presenceOf(device));
  }

  /** 移除设备:断开它的所有连接,并广播离线。 */
  disconnectDevice(device: StoredDevice, code: number, reason: string): void {
    for (const conn of [...this.connections]) {
      if (conn.deviceId !== device.deviceId) continue;
      if (this.active.get(conn.deviceId) === conn) this.active.delete(conn.deviceId);
      conn.ws.close(code, reason);
    }
    this.broadcast({ ...this.presenceOf(device), online: false, remoteControlEnabled: false, busy: false });
  }

  closeAll(code: number, reason: string): void {
    clearInterval(this.idleTimer);
    for (const conn of [...this.connections]) conn.ws.close(code, reason);
  }

  private closeIdle(): void {
    const now = this.now();
    for (const conn of this.connections) {
      if (now - conn.lastInboundAt > this.limits.idleTimeoutMs) conn.ws.terminate();
    }
  }

  private broadcast(snapshot: PresenceSnapshot): void {
    for (const conn of this.active.values()) {
      this.send(conn, { v: PROTOCOL_VERSION, kind: 'presence-changed', payload: snapshot });
    }
  }

  private sendError(conn: Connection, id: string | undefined, code: RelayErrorCode, message: string, dst?: string): void {
    const frame: Envelope = { v: PROTOCOL_VERSION, kind: 'relay-error', payload: { code, message, ...(dst ? { dst } : {}) } };
    if (id !== undefined) frame.id = id;
    this.send(conn, frame);
  }

  /** 发送失败或接收方积压过多时返回 false;积压的连接用 1013 关闭,由客户端退避重连。 */
  private send(conn: Connection, frame: Envelope): boolean {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    if (conn.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      this.logger.warn('closing congested connection');
      conn.ws.close(CLOSE_CONGESTED, 'relay congested');
      return false;
    }
    conn.ws.send(JSON.stringify(frame));
    return true;
  }
}
