/**
 * agent-net 中继(`agent-net-relay-v1`,实验,默认关闭):在已加入的设备之间转发 agent-net 数据报。
 * 数据报由两端的 agent-net 核心加密和认证,中继只看路由头,不解析内容。方案见 docs/agent-net-plan.md 第 7 步。
 *
 * - 入口 `/api/device-link/agent-net`,WebSocket 升级时校验 `CindyRelay` 凭证,和设备连接共用端口、证书与 Nginx(公网是 443)。
 * - 只收发二进制帧:`[类型 1][设备号长度 1][设备号 UTF-8][数据报…]`,数据报是 `[长度 2,大端][内容]` 首尾相接,一帧可带多个。
 *   类型 1 是数据报。设备发出时设备号是收件设备;中继转发时换成发件设备,取自凭证,不信任帧内字段。
 * - 和 UDP 一样不保证送到:收件设备不在线、积压太多、帧不合格时直接丢掉,不回错误。重传和加密都在两端。
 * - 每台设备只保留最新的一条,新的顶掉旧的(4409)。设备被移除时立即断开(4410)。
 * - 不交换在线状态、不经过 `hello`:谁在线由设备连接(`/api/device-link/ws`)负责,这里只转发。
 */
import WebSocket from 'ws';
import { CLOSE_DEVICE_REMOVED, CLOSE_REPLACED } from './hub';
import type { RelayLogger } from './logger';
import type { StoredDevice } from './store';

export const AGENT_NET_RELAY_FEATURE = 'agent-net-relay-v1';
const FRAME_DATAGRAMS = 1;
/** 一帧的上限:一批数据报,远大于一个 UDP 包。 */
export const AGENT_NET_MAX_FRAME_BYTES = 64 * 1024;
const MAX_DEVICE_ID_BYTES = 255;

export interface AgentNetLimits {
  /** 收件连接积压超过这么多字节时,新到的帧直接丢掉:中继不能替一个慢设备无限缓存。 */
  maxBufferedBytes: number;
  /** 这么久收不到 pong 就断开。 */
  idleTimeoutMs: number;
}

export const DEFAULT_AGENT_NET_LIMITS: AgentNetLimits = {
  maxBufferedBytes: 1024 * 1024,
  idleTimeoutMs: 90_000,
};

interface Session {
  ws: WebSocket;
  deviceId: string;
  alive: boolean;
}

export interface AgentNetStats {
  framesForwarded: number;
  bytesForwarded: number;
  /** 收件设备不在线、积压太多或帧不合格而丢掉的帧。 */
  framesDropped: number;
}

/** 解出帧头:类型和设备号,以及数据报部分的起点。格式不对时返回 `null`。 */
export function parseAgentNetFrame(frame: Buffer): { deviceId: string; body: number } | null {
  if (frame.length < 2 || frame[0] !== FRAME_DATAGRAMS) return null;
  const length = frame[1];
  const body = 2 + length;
  if (length === 0 || frame.length <= body + 2) return null;
  return { deviceId: frame.subarray(2, body).toString('utf8'), body };
}

/** 拼一帧:`deviceId` 后面接已经编好的数据报部分。 */
export function encodeAgentNetFrame(deviceId: string, datagrams: Buffer): Buffer {
  const id = Buffer.from(deviceId, 'utf8');
  if (id.length === 0 || id.length > MAX_DEVICE_ID_BYTES) throw new Error('invalid device id');
  return Buffer.concat([Buffer.from([FRAME_DATAGRAMS, id.length]), id, datagrams]);
}

export class AgentNetHub {
  private readonly sessions = new Map<string, Session>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  readonly stats: AgentNetStats = { framesForwarded: 0, bytesForwarded: 0, framesDropped: 0 };

  constructor(
    private readonly logger: RelayLogger,
    private readonly limits: AgentNetLimits = DEFAULT_AGENT_NET_LIMITS,
  ) {
    // 两次心跳之间没有回 pong 的连接断开;转发本身不刷新心跳,只靠 pong。
    this.heartbeat = setInterval(() => this.checkAlive(), Math.max(1_000, Math.floor(limits.idleTimeoutMs / 2)));
    this.heartbeat.unref?.();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 接管一条已通过凭证认证的 WebSocket。 */
  attach(ws: WebSocket, device: StoredDevice): void {
    const previous = this.sessions.get(device.deviceId);
    const session: Session = { ws, deviceId: device.deviceId, alive: true };
    this.sessions.set(device.deviceId, session);
    if (previous) previous.ws.close(CLOSE_REPLACED, 'replaced by a newer connection');
    ws.on('error', () => undefined);
    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary || frame.length > AGENT_NET_MAX_FRAME_BYTES) {
        this.stats.framesDropped += 1;
        return;
      }
      this.forward(session, frame);
    });
    ws.on('close', () => {
      if (this.sessions.get(device.deviceId) === session) this.sessions.delete(device.deviceId);
    });
  }

  private forward(from: Session, frame: Buffer): void {
    const parsed = parseAgentNetFrame(frame);
    const target = parsed && parsed.deviceId !== from.deviceId ? this.sessions.get(parsed.deviceId) : undefined;
    if (!parsed || !target || target.ws.readyState !== WebSocket.OPEN || target.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      this.stats.framesDropped += 1;
      return;
    }
    const out = encodeAgentNetFrame(from.deviceId, frame.subarray(parsed.body));
    target.ws.send(out, { binary: true });
    this.stats.framesForwarded += 1;
    this.stats.bytesForwarded += out.length;
  }

  /** 设备被移除:立即断开它的转发连接。 */
  disconnectDevice(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    this.sessions.delete(deviceId);
    session.ws.close(CLOSE_DEVICE_REMOVED, 'device removed');
  }

  closeAll(code: number, reason: string): void {
    clearInterval(this.heartbeat);
    for (const session of [...this.sessions.values()]) session.ws.close(code, reason);
    this.sessions.clear();
  }

  private checkAlive(): void {
    for (const session of this.sessions.values()) {
      if (!session.alive) {
        this.logger.info('agent-net relay session timed out');
        session.ws.terminate();
        continue;
      }
      session.alive = false;
      session.ws.ping();
    }
  }
}
