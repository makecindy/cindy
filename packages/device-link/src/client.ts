import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  SERVER_CAPABILITY_NOTIFY,
  DeviceLinkError,
  type Envelope,
  type HelloPayload,
  type HelloAckPayload,
  type NotifyPayload,
  type PresenceSetPayload,
  type PresenceSnapshot,
  type RelayErrorPayload,
  type LinkOpenPayload,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkCloseReason,
  type LinkClosePayload,
} from './protocol.js';
import {
  DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
  DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
  MAX_TRANSPORT_CHUNK_BYTES,
  MAX_TRANSPORT_PENDING_BYTES,
  MAX_TRANSPORT_PENDING_MESSAGES,
  MAX_TRANSPORT_REASSEMBLIES,
  MAX_TRANSPORT_REASSEMBLY_BYTES,
  MAX_TRANSPORT_SEQUENCE_WINDOW,
  MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES,
  TRANSPORT_MAX_RETRY_ATTEMPTS,
  TRANSPORT_RETRY_INTERVAL_MS,
  decodeTransportJson,
  encodeReliableFrames,
  isTransportSkipPayload,
  makeTransportAck,
  makeTransportSkipPayload,
  parseTransportAck,
  parseTransportPayload,
  byteLength,
} from './transport.js';

const DUPLICATE_CONNECTION_CLOSE_CODE = 4409;
const SLOW_REQUEST_WARN_MS = 1_000;
const MAX_LEGACY_INBOUND_FRAMES = 128;
const MAX_LEGACY_INBOUND_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_INBOUND_LINK_OFFERS = 64;

type DeviceLinkCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
};

function createRequestId(): string {
  const cryptoLike = (globalThis as { crypto?: DeviceLinkCrypto }).crypto;
  if (typeof cryptoLike?.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  if (typeof cryptoLike?.getRandomValues === 'function') {
    const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return uuidFromBytes(bytes);
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 0x3) | 0x8).toString(16);
  });
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * DeviceLinkClient —— 设备端到 relay(apps/server)的 WS 客户端状态机。
 *
 * 职责:
 *  - 连接生命周期:connect → hello 握手 → online;断线指数退避重连(1s → 30s)
 *  - 应用层心跳:online 后每 20s 发 ping;连续 2 个周期无 pong 视为僵死,强制重连
 *  - 请求配对:invoke / link-open 按 id 关联响应,超时 reject(INVOKE_TIMEOUT)
 *  - 入站分发:presence-changed / 隧道帧(invoke / link-open / link-close / push)
 *    通过回调交给 host;响应帧(invoke-result / link-accept / relay-error)优先匹配 pending 请求
 *
 * Electron-agnostic:WebSocket 实现、token、设备信息全部由 host 注入。
 */

// ─── host 注入契约 ────────────────────────────────────────────────────────────

/** ws 库风格的最小 socket 接口(host 注入 ctor;测试注入 fake) */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  /** browser / ws 都提供的发送缓冲字节数；缺省表示 host 无法观测。 */
  readonly bufferedAmount?: number;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number, reason?: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/**
 * 创建一条带鉴权 header 的 ws 连接。允许返回 Promise —— host 建连前可能要先做异步
 * 准备(如 desktop 现取系统代理拿 http agent)。
 */
export type WsFactory = (
  url: string,
  headers: Record<string, string>,
) => WsLike | Promise<WsLike>;

export interface DeviceLinkLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface DeviceLinkClientOptions {
  /** relay 的完整 ws(s) URL,如 wss://host/api/device-link/ws */
  getWsUrl(): string;
  /** 每次(重)连前取新鲜 token;null = 当前无登录态,跳过本轮并按退避重试 */
  getToken(): Promise<string | null>;
  /** 每次(重)连时的 hello payload(host 持有 deviceName / 开关 / busy 的真相) */
  getHello(): HelloPayload;
  createWebSocket: WsFactory;
  logger?: DeviceLinkLogger;
  /** 测试注入:覆盖重连/心跳的时间参数 */
  timing?: Partial<DeviceLinkTiming>;
}

export interface DeviceLinkTiming {
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /**
   * hello-ack 之后必须稳定在线一小段时间才把退避清零。
   * 否则同 deviceId 的重复连接风暴会变成 1s 固定频率重连,持续顶掉彼此。
   */
  reconnectStableResetMs: number;
  pingIntervalMs: number;
  /** 连续无 pong 判定僵死的周期数 */
  pongMissLimit: number;
  /** invoke / link-open 默认等待响应时长 */
  requestTimeoutMs: number;
  /**
   * getToken 的等待上限。token 刷新可能走网络(移动端弱网下可能长时间无响应),
   * 不设上限时 connect 会卡在 connecting 且没有任何重连计时器兜底。
   */
  getTokenTimeoutMs: number;
  /**
   * 从 socket 创建到 hello-ack 的握手上限。弱网下 TCP/TLS 升级可能挂起
   * OS 级时长(几十秒),超限直接判失败走退避重连,而不是无限 connecting。
   */
  handshakeTimeoutMs: number;
  /** 可靠消息未收到累计 ACK 时的重发间隔。 */
  transportRetryIntervalMs: number;
  /** 单个连接世代内的最大发送次数；耗尽后主动重连并在新世代继续。 */
  transportMaxRetryAttempts: number;
  /** presence fire-and-forget 帧命中 WebSocket 背压后的合并重试间隔。 */
  presenceRetryIntervalMs: number;
}

const DEFAULT_TIMING: DeviceLinkTiming = {
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  reconnectStableResetMs: 10_000,
  pingIntervalMs: 20_000,
  pongMissLimit: 2,
  requestTimeoutMs: 30_000,
  getTokenTimeoutMs: 15_000,
  handshakeTimeoutMs: 15_000,
  transportRetryIntervalMs: TRANSPORT_RETRY_INTERVAL_MS,
  transportMaxRetryAttempts: TRANSPORT_MAX_RETRY_ATTEMPTS,
  presenceRetryIntervalMs: 500,
};

export type DeviceLinkStatus = 'stopped' | 'connecting' | 'online';

/**
 * 连接层异常分类 —— 只覆盖「用户可感知、可指导行动」的握手/链路失败。
 * 普通网络断线/抖动不产生 issue(UI 已有 connecting 态兜底),避免 banner 噪音。
 *
 * 背景:DeviceLinkStatus 三态没有 error 态,鉴权失败(401)、被顶号(4409)、
 * 版本不符(4400)等失败在状态机上都表现为无限 connecting,用户看不到真实原因。
 * 这里以 additive 旁路通道暴露分类结果,不改动三态语义(两端既有消费零影响)。
 */
export type DeviceLinkConnectionIssueKind =
  /** WS upgrade 被 401 拒绝:token 失效 / 已在别处登出 */
  | 'auth-failed'
  /** 4409:同 deviceId 的新连接顶掉了本连接 */
  | 'replaced'
  /** 4429:同账号连接数超限 */
  | 'too-many-connections'
  /** 协议版本不一致(server 4400 拒绝 / 客户端 hello-ack 校验) */
  | 'version-mismatch';

export interface DeviceLinkConnectionIssue {
  kind: DeviceLinkConnectionIssueKind;
  /** ws close code(如 4409);非 close 场景(hello-ack 校验)缺省 */
  closeCode?: number;
  /** 原始 reason / socket error message,供日志诊断;不建议直接展示给用户 */
  detail?: string;
  /** unix ms */
  at: number;
}

/**
 * 从断连信息分类连接问题。返回 null = 普通断线(网络抖动 / 服务重启 / 4401 token
 * 轮换),按既有退避重连兜底即可,不打扰用户。
 *
 * 401 场景两端 ws 实现都不给 close code(升级失败统一 1006),只能靠 socket error
 * message 匹配:Node ws 是 "Unexpected server response: 401",RN 是
 * "Expected HTTP 101 response but was '401 Unauthorized'"。
 */
export function classifyConnectionIssue(
  code?: number,
  reason?: string,
  socketErrorMessage?: string | null,
): DeviceLinkConnectionIssueKind | null {
  if (code === 4409) return 'replaced';
  if (code === 4429) return 'too-many-connections';
  if (code === 4400 && /version/i.test(reason ?? '')) return 'version-mismatch';
  const detail = `${reason ?? ''} ${socketErrorMessage ?? ''}`;
  if (/\b401\b|unauthorized/i.test(detail)) return 'auth-failed';
  return null;
}

/** 入站隧道帧(由 host 处理:被控端 dispatch invoke;控制端消费 push 等) */
export type InboundFrameHandler = (env: Envelope) => unknown | Promise<unknown>;

interface PendingRequest {
  resolve(env: Envelope): void;
  reject(err: DeviceLinkError): void;
  timer: ReturnType<typeof setTimeout>;
  /** 期望的响应 kind —— 配对时除 id 外还要 kind 一致,挡 id 撞但 kind 不符的帧。 */
  expectKind: 'invoke-result' | 'link-accept';
  /** link-open 的目标设备；显式关闭时据此取消仍在等待的 accept。 */
  dst?: string;
  /** 可靠 invoke 未 ACK 时可跨 relay 短断线继续等；其它请求立即失败。 */
  reliableDst?: string;
}

interface PendingReliableMessage {
  seq: number;
  /** 保留逻辑信封，重放时按当前最早 pending seq 刷新 wrapper.baseSeq。 */
  envelope: Envelope;
  /** 按 baseSeq=seq 预留的最坏 wire 大小，用于严格限制 pending 内存。 */
  bytes: number;
  attempts: number;
  lastSentAt: number;
  sent: boolean;
}

interface PeerTransportState {
  streamId: string;
  remoteStreamId: string | null;
  remoteBaseSeq: number;
  nextSeq: number;
  reliable: boolean;
  linkReady: boolean;
  explicitlyClosed: boolean;
  pending: Map<number, PendingReliableMessage>;
  pendingBytes: number;
  retryTimer: ReturnType<typeof setInterval> | null;
  receive: Map<string, ReceiveStreamState>;
  highestAckSeq: number;
  lastReplayEpoch: number;
}

interface PendingInboundLinkOffer {
  requestId: string;
  capabilities?: readonly string[];
  transportStreamId?: string;
  transportBaseSeq?: number;
}

interface ReceiveAssembly {
  kind: Envelope['kind'];
  id?: string;
  src?: string;
  dst?: string;
  total: number;
  totalBytes: number;
  chunks: Map<number, string>;
  bytes: number;
}

interface ReceiveStreamState {
  lastDeliveredSeq: number;
  requestedBaseSeq: number;
  deliveringSeq: number | null;
  assemblies: Map<number, ReceiveAssembly>;
  ready: Map<number, { env: Envelope; json: string }>;
  bufferedBytes: number;
  drain: Promise<void> | null;
  /** drain 已在途时又有新帧入队；当前轮结束前必须再检查一次队头。 */
  drainRequested: boolean;
}

// ─── 客户端实现 ───────────────────────────────────────────────────────────────

export class DeviceLinkClient {
  private readonly opts: DeviceLinkClientOptions;
  private readonly timing: DeviceLinkTiming;
  private readonly log: DeviceLinkLogger;

  private ws: WsLike | null = null;
  private status: DeviceLinkStatus = 'stopped';
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStableTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongMisses = 0;
  /** 当前连接的代号,用于丢弃过期 socket 的事件回调 */
  private connEpoch = 0;
  /** 本轮连接的最后一条 socket error message(升级失败 401 只在 error 事件里可见) */
  private lastSocketErrorMessage: string | null = null;
  /** 最近一次分类出的连接问题;online 清除,普通断线保留(重连中 banner 不闪) */
  private connectionIssue: DeviceLinkConnectionIssue | null = null;
  /** 最近一次 hello-ack 声明的 server 能力集(老 server 无该字段 = 空集) */
  private serverCapabilities: readonly string[] = [];
  /** 最近一次 hello-ack 回的本设备 deviceId(深链等场景需要自我标识) */
  private selfDeviceId: string | null = null;

  private readonly pending = new Map<string, PendingRequest>();
  /**
   * 每个控制端/被控端各自维护一个 stream。stream 在 relay 重连时保留，
   * 这样未 ACK 的消息可以在重新 openLink 后继续重发；旧 stream 不会混入
   * 新 peer，因为接收端按 streamId 独立去重。
   */
  private readonly peerTransport = new Map<string, PeerTransportState>();
  /** 入站 link-open 只记录提议；host 真正 sendLinkAccept 后才提交能力/stream 基线。 */
  private readonly pendingInboundLinkOffers = new Map<string, PendingInboundLinkOffer>();
  /** 只串行旧协议业务帧；pong / ACK / 可靠 stream 各自独立，不被慢 handler 堵住。 */
  private legacyInboundChain: Promise<void> | null = null;
  private legacyInboundFrames = 0;
  private legacyInboundBytes = 0;
  /** 断线/stop 后旧 handler 可能永不 settle；新连接必须与其队列 bookkeeping 隔离。 */
  private legacyInboundGeneration = 0;
  /** presence 是覆盖语义；背压时只保留每个字段的最新值，避免异常逃逸或无界排队。 */
  private pendingPresence: PresenceSetPayload | null = null;
  private presenceRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // —— host 订阅 ——
  private statusHandlers = new Set<(s: DeviceLinkStatus) => void>();
  private presenceHandlers = new Set<(snap: PresenceSnapshot) => void>();
  private frameHandlers = new Set<InboundFrameHandler>();
  private issueHandlers = new Set<(issue: DeviceLinkConnectionIssue | null) => void>();

  constructor(opts: DeviceLinkClientOptions) {
    this.opts = opts;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.log = opts.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    void this.connect('start');
  }

  /**
   * 立即重连:清掉挂起的退避计时器并把退避计数归零,马上发起一次连接。
   *
   * 供"用户正在等"的场景(如移动端回到前台)opt-in,绕开指数退避——
   * 不改默认退避曲线(桌面端断线重连仍走 scheduleReconnect 的 1s→30s)。
   * 已 online 时为空操作,不打断健康连接;stopped 时等价于 start()。
   */
  connectNow(reason = 'connect-now'): void {
    if (this.status === 'online') return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.connect(reason);
  }

  /**
   * 有界等待连接就绪。online 立即 resolve;否则订阅状态变化,在 timeoutMs 内
   * 等到 online 就 resolve,超时 / stopped 则 reject(NOT_CONNECTED)。
   *
   * 关键:若当前正 park 在重连退避计时器上,先 connectNow() un-park 立即重连——
   * 让"掉线/重连窗口里发起的请求"主动促成重连并在上线后放行,而不是被退避 gap
   * (最坏 30s)拖成干等十几秒。退避被打断后又会立刻重连成功,所以等待通常 <1s。
   *
   * additive + opt-in:此方法供"用户正在等"的场景(移动端发请求)显式调用;
   * 桌面端不调用它,默认重连/退避曲线完全不变。已 stopped 时不自动拉起连接
   * (start/stop 仍由宿主生命周期掌管),直接快速失败让上层感知。
   */
  waitUntilOnline(timeoutMs?: number): Promise<void> {
    if (this.status === 'online') return Promise.resolve();
    if (this.stopped) {
      return Promise.reject(new DeviceLinkError('NOT_CONNECTED', 'client stopped'));
    }
    // 仅在 park 在退避计时器上时 un-park(connectNow);若已有 connect 在途
    // (reconnectTimer 为 null),不重复打断,避免并发等待者互相 thrash。
    if (this.reconnectTimer) this.connectNow('wait-until-online');

    const timeout = timeoutMs ?? this.timing.requestTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      let off: (() => void) | null = null;
      const settle = (fn: () => void): void => {
        if (off) {
          off();
          off = null;
        }
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new DeviceLinkError('NOT_CONNECTED', `not online within ${timeout}ms`)));
      }, timeout);
      off = this.onStatusChange((s) => {
        if (s === 'online') settle(resolve);
        else if (s === 'stopped') {
          settle(() => reject(new DeviceLinkError('NOT_CONNECTED', 'client stopped')));
        }
      });
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.failAllPending(new DeviceLinkError('NOT_CONNECTED', 'client stopped'));
    this.clearPeerTransport();
    this.pendingInboundLinkOffers.clear();
    this.resetLegacyInboundQueue();
    this.clearPendingPresence();
    const ws = this.ws;
    this.ws = null;
    this.connEpoch++;
    if (ws) {
      try {
        ws.close(1000, 'client stopped');
      } catch {
        ws.terminate?.();
      }
    }
    // 主动停止(登出 / 退后台)清掉遗留 issue,避免下次启动前 UI 挂着过期原因
    this.setConnectionIssue(null);
    this.setStatus('stopped');
  }

  getStatus(): DeviceLinkStatus {
    return this.status;
  }

  onStatusChange(cb: (s: DeviceLinkStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  getConnectionIssue(): DeviceLinkConnectionIssue | null {
    return this.connectionIssue;
  }

  /** 订阅连接问题变化(null = 已恢复/清除)。同类问题重复发生只更新时间戳、不重复通知。 */
  onConnectionIssue(cb: (issue: DeviceLinkConnectionIssue | null) => void): () => void {
    this.issueHandlers.add(cb);
    return () => this.issueHandlers.delete(cb);
  }

  onPresenceChanged(cb: (snap: PresenceSnapshot) => void): () => void {
    this.presenceHandlers.add(cb);
    return () => this.presenceHandlers.delete(cb);
  }

  /** 订阅入站隧道帧(invoke / link-open / link-close / push / 未配对的响应帧) */
  onFrame(cb: InboundFrameHandler): () => void {
    this.frameHandlers.add(cb);
    return () => this.frameHandlers.delete(cb);
  }

  // ─── 出站 API ───────────────────────────────────────────────────────────────

  /** 部分更新本机 presence(开关 / busy);离线时静默忽略(重连时 hello 会带全量) */
  sendPresence(patch: PresenceSetPayload): void {
    if (this.status !== 'online') return;
    this.pendingPresence = { ...this.pendingPresence, ...patch };
    this.flushPendingPresence();
  }

  /** 最近一次 hello-ack 声明的 server 能力(如 SERVER_CAPABILITY_NOTIFY);老 server = 空集。 */
  hasServerCapability(capability: string): boolean {
    return this.serverCapabilities.includes(capability);
  }

  /** 最近一次 hello-ack 回的本设备 deviceId(未上线过为 null)。 */
  getSelfDeviceId(): string | null {
    return this.selfDeviceId;
  }

  /**
   * 请求 server 给本账号已注册推送 token 的移动设备发系统推送(fire-and-forget)。
   * 返回是否真的发出:离线或 server 未声明 notify capability 时静默跳过返回 false
   * (旧 server 对未知 kind 是静默黑洞,capability gate 是协议要求,见协议仓文档)。
   * 失败(RATE_LIMITED / BAD_REQUEST)由 relay-error 帧回报,经 onFrame 交 host 记日志。
   */
  sendNotify(payload: NotifyPayload): boolean {
    if (this.status !== 'online') return false;
    if (!this.serverCapabilities.includes(SERVER_CAPABILITY_NOTIFY)) return false;
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'notify',
      id: createRequestId(),
      payload,
    });
    return true;
  }

  /** 控制端:向目标设备发起 link-open,等待 link-accept */
  async openLink(dst: string, payload: unknown, timeoutMs?: number): Promise<LinkAcceptPayload> {
    const linkPayload = this.addLocalCapabilities(dst, payload);
    const env = await this.request(
      { v: PROTOCOL_VERSION, kind: 'link-open', dst, payload: linkPayload },
      'link-accept',
      timeoutMs,
    );
    // link-accept 在 dispatchEnvelope 中已经原子提交 capability/linkReady 并只重放一次；
    // 这里不要重复 replay，否则每次重开都会立刻把全部 pending 再发第二遍并消耗重试预算。
    return env.payload as LinkAcceptPayload;
  }

  /** 任一端:解除控制链路(fire-and-forget) */
  closeLink(dst: string, reason: LinkCloseReason): void {
    this.pendingInboundLinkOffers.delete(dst);
    this.rejectPendingLinkOpen(
      dst,
      'LINK_NOT_OPEN',
      `control link closed locally (${reason})`,
    );
    const peer = this.peerTransport.get(dst);
    if (peer) {
      peer.linkReady = false;
      peer.explicitlyClosed = true;
      // 显式关闭只撤掉 streaming 可靠层。listing / topic 控制帧仍不依赖
      // link-open，后续应回退到 legacy，而不是被统一挡成 LINK_NOT_OPEN。
      peer.reliable = false;
      peer.remoteStreamId = null;
      peer.remoteBaseSeq = 1;
      peer.receive.clear();
      this.abandonReliablePending(dst, `control link closed locally (${reason})`);
    }
    // 显式关闭的本地语义不能依赖 relay 当前可写；离线时只跳过通知，
    // 已经清掉的可靠 pending 也绝不能在下一次 openLink 后复活。
    if (this.status !== 'online') return;
    try {
      this.sendEnvelope({
        v: PROTOCOL_VERSION,
        kind: 'link-close',
        dst,
        payload: { reason } satisfies LinkClosePayload,
      });
    } catch (err) {
      // fire-and-forget：通知失败只记日志，不能把已经完成的本地断链重新暴露成失败。
      this.log.debug(`link-close notification failed for ${dst.slice(0, 8)}`, err);
    }
  }

  /** 控制端:远程 invoke,等待 invoke-result */
  async invoke(dst: string, payload: InvokePayload, timeoutMs?: number): Promise<InvokeResultPayload> {
    const env = await this.request(
      { v: PROTOCOL_VERSION, kind: 'invoke', dst, payload },
      'invoke-result',
      timeoutMs,
    );
    return env.payload as InvokeResultPayload;
  }

  /** 被控端:回 invoke-result(对应入站 invoke 的 id) */
  sendInvokeResult(dst: string, requestId: string, payload: InvokeResultPayload): void {
    this.sendPeerEnvelope({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: requestId, dst, payload });
  }

  /** 被控端:回 link-accept */
  sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void {
    // 只有控制端在 link-open 明确声明过能力时才回显；否则新被控端若
    // 单方面包 transport，旧控制端会把 wrapper 当成普通 InvokeResult/Push。
    const offer = this.pendingInboundLinkOffers.get(dst);
    const matchingOffer = offer?.requestId === requestId ? offer : undefined;
    const peerSupportsReliable = (
      Array.isArray(matchingOffer?.capabilities)
      && matchingOffer.capabilities.includes(DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT)
    );
    const peer = this.getPeerTransport(dst);
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: requestId,
      dst,
      payload: {
        ...payload,
        ...(peerSupportsReliable
          ? {
              capabilities: this.mergeCapabilities(payload?.capabilities, [
                DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
              ]),
              transportStreamId: peer.streamId,
              transportBaseSeq: this.getTransportBaseSeq(peer),
            }
          : {}),
      },
    });
    if (matchingOffer) {
      this.pendingInboundLinkOffers.delete(dst);
      this.setPeerCapabilities(
        dst,
        matchingOffer.capabilities,
        matchingOffer.transportStreamId,
        matchingOffer.transportBaseSeq,
      );
    }
    if (peerSupportsReliable) {
      const resumedLink = !peer.linkReady;
      peer.linkReady = true;
      this.resumeReceiveStreams(dst, peer);
      this.replayPending(dst, resumedLink);
    }
  }

  /** 被控端:广播转发 push 帧(fire-and-forget;失败由上层缓冲策略兜底) */
  sendPush(dst: string, channel: string, payload: unknown): void {
    if (this.status !== 'online') return;
    if (channel === DEVICE_LINK_TRANSPORT_ACK_CHANNEL) {
      this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'push', dst, payload: { channel, payload } });
      return;
    }
    this.sendPeerEnvelope({ v: PROTOCOL_VERSION, kind: 'push', dst, payload: { channel, payload } });
  }

  // ─── 内部:请求配对 ─────────────────────────────────────────────────────────

  /** 发送请求帧并等待同 id 响应;同 id relay-error 转成 DeviceLinkError reject */
  private request(
    env: Omit<Envelope, 'id'>,
    expectKind: 'invoke-result' | 'link-accept',
    timeoutMs?: number,
  ): Promise<Envelope> {
    if (this.status !== 'online') {
      return Promise.reject(new DeviceLinkError('NOT_CONNECTED', 'not connected to relay'));
    }
    const id = createRequestId();
    const timeout = timeoutMs ?? this.timing.requestTimeoutMs;
    const startedAt = Date.now();
    const requestDescription = this.describeRequest(env, expectKind);

    const logFinished = (outcome: 'ok' | 'timeout' | 'error', err?: DeviceLinkError): void => {
      const elapsedMs = Date.now() - startedAt;
      if (outcome === 'timeout') {
        this.log.warn(`device-link request timeout ${requestDescription} elapsed=${elapsedMs}ms`);
        return;
      }
      if (outcome === 'error') {
        if (err?.code !== 'NOT_CONNECTED' || elapsedMs >= SLOW_REQUEST_WARN_MS) {
          this.log.debug(
            `device-link request failed ${requestDescription} code=${err?.code ?? 'UNKNOWN'} elapsed=${elapsedMs}ms`,
          );
        }
        return;
      }
      if (elapsedMs >= SLOW_REQUEST_WARN_MS) {
        this.log.debug(`device-link request slow ${requestDescription} elapsed=${elapsedMs}ms`);
      }
    };

    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (env.dst && env.kind === 'invoke') this.dropReliablePendingForRequest(env.dst, id);
        logFinished('timeout');
        reject(new DeviceLinkError('INVOKE_TIMEOUT', `no ${expectKind} within ${timeout}ms`));
      }, timeout);

      this.pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          logFinished('ok');
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(timer);
          logFinished('error', err);
          reject(err);
        },
        timer,
        expectKind,
        dst: env.dst,
      });

      try {
        const outbound = { ...env, id };
        if (outbound.kind === 'invoke' && outbound.dst) {
          const reliable = this.sendPeerEnvelope(outbound);
          if (reliable) {
            const pending = this.pending.get(id);
            if (pending) pending.reliableDst = outbound.dst;
          }
        } else {
          this.sendEnvelope(outbound);
        }
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        const deviceLinkErr =
          err instanceof DeviceLinkError
            ? err
            : new DeviceLinkError('INTERNAL', err instanceof Error ? err.message : String(err));
        logFinished('error', deviceLinkErr);
        reject(deviceLinkErr);
      }
    });
  }

  private describeRequest(env: Omit<Envelope, 'id'>, expectKind: 'invoke-result' | 'link-accept'): string {
    const dst = env.dst ? env.dst.slice(0, 8) : 'unknown';
    const channel = env.kind === 'invoke' ? (env.payload as InvokePayload | undefined)?.channel : env.kind;
    return `kind=${env.kind} channel=${channel ?? 'unknown'} dst=${dst} expect=${expectKind}`;
  }

  private failAllPending(err: DeviceLinkError): void {
    // pending 里的请求全部已经 sendEnvelope 成功(in-flight):打上标记,
    // 让控制端的重试逻辑知道「请求可能已送达对端,只是响应丢了」,
    // 与发送前本地拒绝的 NOT_CONNECTED 区分开。
    err.inFlight = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private failNonReliablePending(err: DeviceLinkError): void {
    err.inFlight = true;
    for (const [id, pending] of this.pending) {
      if (pending.reliableDst) continue;
      this.pending.delete(id);
      pending.reject(err);
    }
  }

  private dropReliablePendingForRequest(dst: string, requestId: string): void {
    const peer = this.peerTransport.get(dst);
    if (!peer) return;
    for (const [seq, pending] of peer.pending) {
      if (pending.envelope.id !== requestId) continue;
      const skipEnvelope: Envelope = {
        ...pending.envelope,
        payload: makeTransportSkipPayload(),
      };
      const skipBytes = this.measureReservedReliableBytes(skipEnvelope, peer.streamId, seq);
      peer.pendingBytes += skipBytes - pending.bytes;
      pending.envelope = skipEnvelope;
      pending.bytes = skipBytes;
      pending.attempts = 0;
      pending.lastSentAt = 0;
      pending.sent = false;
      this.retryPending(dst, true);
      return;
    }
  }

  // ─── 内部:连接管理 ─────────────────────────────────────────────────────────

  private async connect(reason: string): Promise<void> {
    if (this.stopped) return;
    this.resetLegacyInboundQueue();
    this.setStatus('connecting');
    const epoch = ++this.connEpoch;
    this.lastSocketErrorMessage = null;
    this.log.debug(`connecting (reason=${reason})`);

    // 关掉可能残留的上一条 socket:getToken await 与 scheduleReconnect 竞态下 this.ws
    // 可能仍持半开旧连接,epoch 守卫只忽略其回调、不回收 socket。这里显式关闭防泄漏。
    const prev = this.ws;
    this.ws = null;
    if (prev) {
      // 客户端主动重建丢弃在用 socket:旧 socket 的 close 事件被 epoch 守卫屏蔽,不经过
      // handleDisconnect——若不在此 fail 掉 in-flight 请求,它们会一直挂到 requestTimeoutMs
      // (默认 30s)才超时,用户侧表现为长时间空白干等。语义对齐心跳判死 / 正常断连:
      // 立刻 fail(带 inFlight 标记),让上层快速重试。这条 INFO 同时是排障锚点:
      // 此路径此前没有任何日志痕迹,连接翻覆时无法与「真实断连重连」区分。
      this.log.info(
        `discarding live socket for reconnect (reason=${reason}, pending=${this.pending.size})`,
      );
      try {
        prev.close(1000, 'reconnecting');
      } catch {
        prev.terminate?.();
      }
      this.failNonReliablePending(
        new DeviceLinkError('NOT_CONNECTED', `connection restarted (${reason})`),
      );
    }

    let token: string | null = null;
    try {
      // token 刷新可能走网络:必须有上限,否则弱网下 connect 卡在 connecting
      // 且没有任何重连计时器兜底(connectNow 也救不回来,因为 reconnectTimer 为 null)。
      token = await withTimeout(
        this.opts.getToken(),
        this.timing.getTokenTimeoutMs,
        'getToken timed out',
      );
    } catch (err) {
      this.log.warn('getToken failed', err);
    }
    if (this.stopped || epoch !== this.connEpoch) return;
    if (!token) {
      // 无登录态:按退避节奏静默重试(登录完成后 host 也可直接 restart)
      this.scheduleReconnect();
      return;
    }

    let ws: WsLike;
    try {
      ws = await this.opts.createWebSocket(this.opts.getWsUrl(), {
        authorization: `Bearer ${token}`,
      });
    } catch (err) {
      // 异步工厂可能在更新的一轮 connect 已经起来之后才 reject —— 那是过期尝试的失败,
      // 不能据此改状态或排重连(scheduleReconnect 的 connect() 会顶掉那条更新的、
      // 可能健康的连接)。与工厂成功分支用同一道 stopped/epoch 闸(review 2026-07-27 P1)。
      if (this.stopped || epoch !== this.connEpoch) {
        this.log.debug?.('stale createWebSocket rejection ignored', err);
        return;
      }
      this.log.warn('createWebSocket failed', err);
      this.scheduleReconnect();
      return;
    }
    // 工厂可能是异步的(host 建连前要准备代理 agent 等):期间可能已 stop 或换了
    // 连接世代 —— 那这条 socket 是孤儿,关掉再退,别挂到 this.ws 上。
    if (this.stopped || epoch !== this.connEpoch) {
      try {
        // 必须先挂 error 监听再 close:孤儿 socket 大概率还在 CONNECTING,close() 会让
        // ws 异步 emit 'error'(如 "WebSocket was closed before the connection was
        // established"),而 EventEmitter 对无监听的 'error' 是直接抛 —— 那会变成主进程
        // 的未捕获异常(review 2026-07-27 P1)。
        ws.on('error', () => {});
        ws.close();
      } catch (err) {
        this.log.debug?.('closing orphan websocket failed', err);
      }
      return;
    }
    this.ws = ws;
    this.armHandshakeTimeout(epoch);

    ws.on('open', () => {
      if (epoch !== this.connEpoch) return;
      // 进站第一帧必须是 hello
      this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'hello', payload: this.opts.getHello() });
    });

    ws.on('message', (data) => {
      if (epoch !== this.connEpoch) return;
      try {
        this.handleMessage(data.toString());
      } catch (err) {
        this.log.error('device-link inbound frame failed', err);
      }
    });

    ws.on('close', (code, reason) => {
      if (epoch !== this.connEpoch) return;
      const reasonText = closeReasonToString(reason);
      this.log.info(`relay connection closed (code=${code}${reasonText ? ` reason=${reasonText}` : ''})`);
      this.handleDisconnect(code, reasonText);
    });

    ws.on('error', (err) => {
      if (epoch !== this.connEpoch) return;
      // 升级失败(如 401)两端 ws 都不给 close code,只有这条 message 可辨因;
      // 记下来供随后 close 事件里的 classifyConnectionIssue 使用。
      this.lastSocketErrorMessage = err.message;
      this.log.warn('relay connection error', err.message);
      // close 事件随后到达,统一在 close 里处理重连
    });
  }

  private handleDisconnect(code?: number, reason?: string): void {
    this.clearTimers();
    this.ws = null;
    // hello 会从 host 读取完整最新状态；旧连接上尚未发出的覆盖型 patch 不跨世代重放。
    this.clearPendingPresence();
    for (const peer of this.peerTransport.values()) {
      peer.linkReady = false;
      if (peer.retryTimer) {
        clearInterval(peer.retryTimer);
        peer.retryTimer = null;
      }
    }
    this.pendingInboundLinkOffers.clear();
    this.resetLegacyInboundQueue();
    this.failNonReliablePending(new DeviceLinkError('NOT_CONNECTED', 'relay connection lost'));
    if (this.stopped) return;
    if (code === DUPLICATE_CONNECTION_CLOSE_CODE) {
      this.log.warn(
        `relay replaced this device connection; keeping reconnect backoff warm${reason ? ` (${reason})` : ''}`,
      );
    }
    // 可分类的失败(鉴权/顶号/超限/版本)记为 issue 供 UI 展示原因;普通断线
    // 不产生也不清除 issue —— 401 重连风暴里穿插的网络失败不该把原因洗掉。
    const kind = classifyConnectionIssue(code, reason, this.lastSocketErrorMessage);
    if (kind) {
      this.setConnectionIssue({
        kind,
        closeCode: code,
        detail: reason || this.lastSocketErrorMessage || undefined,
        at: Date.now(),
      });
    }
    this.scheduleReconnect();
  }

  /**
   * 握手 watchdog:socket 创建后若在 handshakeTimeoutMs 内没等到 hello-ack(online),
   * 强制关掉这条连接走退避重连。覆盖两类弱网挂起:TCP/TLS 升级挂死(open 不来)、
   * upgrade 成功但 hello-ack 丢失。
   */
  private armHandshakeTimeout(epoch: number): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.stopped || epoch !== this.connEpoch || this.status === 'online') return;
      this.log.warn(`handshake not completed within ${this.timing.handshakeTimeoutMs}ms, forcing reconnect`);
      const ws = this.ws;
      this.ws = null;
      this.connEpoch++;
      closeOrTerminate(ws);
      this.handleDisconnect(1006, 'handshake timeout');
    }, this.timing.handshakeTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(
      this.timing.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.timing.reconnectMaxMs,
    );
    // 向下抖动(0.7x–1.0x):打散同 deviceId 双连风暴 / 服务重启后的全端齐步重连,
    // 上界不变,文档承诺的最大退避(reconnectMaxMs)仍然成立。
    const delay = Math.round(base * (0.7 + Math.random() * 0.3));
    this.reconnectAttempt++;
    this.setStatus('connecting');
    this.log.debug(`scheduling device-link reconnect in ${delay}ms (attempt=${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect('backoff-reconnect');
    }, delay);
  }

  private startHeartbeat(): void {
    // 防重复 hello-ack 泄漏旧 interval:重复进入先清掉上一个 ping timer 再重建。
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pongMisses = 0;
    this.pingTimer = setInterval(() => {
      if (this.status !== 'online') return;
      this.pongMisses++;
      if (this.pongMisses > this.timing.pongMissLimit) {
        this.log.warn('heartbeat lost, forcing reconnect');
        const ws = this.ws;
        this.ws = null;
        this.connEpoch++;
        // RN 的 WebSocket 没有 terminate:必须 fallback 到 close(),否则半开死
        // socket 被原样遗留(handleDisconnect 只清 this.ws 引用),弱网反复
        // 断连会累积泄漏 socket 与事件回调。
        closeOrTerminate(ws);
        this.handleDisconnect(1006, 'heartbeat lost');
        return;
      }
      try {
        this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'ping' });
      } catch {
        // 发送失败交给 close 流程
      }
    }, this.timing.pingIntervalMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectStableTimer) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = null;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.presenceRetryTimer) {
      clearTimeout(this.presenceRetryTimer);
      this.presenceRetryTimer = null;
    }
  }

  private flushPendingPresence(): void {
    if (!this.pendingPresence || this.status !== 'online') return;
    const patch = this.pendingPresence;
    try {
      this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'presence-set', payload: patch });
      if (this.pendingPresence === patch) this.pendingPresence = null;
    } catch (err) {
      if (
        err instanceof DeviceLinkError
        && (err.code === 'BACKPRESSURE' || err.code === 'NOT_CONNECTED')
      ) {
        if (err.code === 'BACKPRESSURE') this.schedulePresenceRetry();
        else this.clearPendingPresence();
        return;
      }
      throw err;
    }
  }

  private schedulePresenceRetry(): void {
    if (this.presenceRetryTimer || !this.pendingPresence) return;
    this.presenceRetryTimer = setTimeout(() => {
      this.presenceRetryTimer = null;
      this.flushPendingPresence();
    }, this.timing.presenceRetryIntervalMs);
    (this.presenceRetryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearPendingPresence(): void {
    this.pendingPresence = null;
    if (!this.presenceRetryTimer) return;
    clearTimeout(this.presenceRetryTimer);
    this.presenceRetryTimer = null;
  }

  // ─── 内部:入站分发 ─────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      this.log.warn('dropping unparseable frame');
      return;
    }

    const ack = parseTransportAck(env);
    if (ack) {
      if (env.src) this.handleTransportAck(env.src, ack.streamId, ack.ackSeq);
      return;
    }

    const transport = this.ingestTransportEnvelope(env);
    if (transport.handled) {
      void transport.result?.catch((err) => {
        this.log.error('device-link reliable frame failed', err);
      });
      return;
    }

    if (isLegacyBusinessFrame(env.kind)) {
      this.enqueueLegacyEnvelope(env);
      return;
    }

    const result = this.dispatchEnvelope(env);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch((err) => {
        this.log.error('device-link control frame failed', err);
      });
    }
  }

  private enqueueLegacyEnvelope(env: Envelope): void {
    const frameBytes = byteLength(JSON.stringify(env));
    if (
      this.legacyInboundFrames >= MAX_LEGACY_INBOUND_FRAMES
      || this.legacyInboundBytes + frameBytes > MAX_LEGACY_INBOUND_BYTES
    ) {
      this.log.warn(
        `dropping legacy device-link frame under backpressure kind=${env.kind} queued=${this.legacyInboundFrames}`,
      );
      return;
    }
    const epoch = this.connEpoch;
    const generation = this.legacyInboundGeneration;
    const run = async (): Promise<void> => {
      if (
        this.stopped
        || epoch !== this.connEpoch
        || generation !== this.legacyInboundGeneration
      ) return;
      await this.dispatchEnvelope(env);
    };
    this.legacyInboundFrames++;
    this.legacyInboundBytes += frameBytes;
    if (this.legacyInboundChain) {
      this.trackLegacyInbound(this.legacyInboundChain.then(run, run), frameBytes, generation);
      return;
    }
    try {
      const result = this.dispatchEnvelope(env);
      if (isPromiseLike(result)) {
        this.trackLegacyInbound(
          Promise.resolve(result).then(() => undefined),
          frameBytes,
          generation,
        );
      } else if (generation === this.legacyInboundGeneration) {
        this.legacyInboundFrames--;
        this.legacyInboundBytes -= frameBytes;
      }
    } catch (err) {
      if (generation === this.legacyInboundGeneration) {
        this.legacyInboundFrames--;
        this.legacyInboundBytes -= frameBytes;
      }
      this.log.error('device-link legacy frame failed', err);
    }
  }

  private trackLegacyInbound(
    task: Promise<void>,
    frameBytes: number,
    generation: number,
  ): void {
    const tracked = task
      .catch((err) => {
        this.log.error('device-link legacy frame failed', err);
      })
      .finally(() => {
        if (generation !== this.legacyInboundGeneration) return;
        this.legacyInboundFrames--;
        this.legacyInboundBytes -= frameBytes;
        if (this.legacyInboundChain === tracked) this.legacyInboundChain = null;
      });
    this.legacyInboundChain = tracked;
  }

  private resetLegacyInboundQueue(): void {
    this.legacyInboundGeneration++;
    this.legacyInboundChain = null;
    this.legacyInboundFrames = 0;
    this.legacyInboundBytes = 0;
  }

  private dispatchEnvelope(env: Envelope): boolean | Promise<boolean> {
    switch (env.kind) {
      case 'hello-ack': {
        const ack = env.payload as HelloAckPayload;
        // 协议版本不一致:隧道帧语义可能漂移,不要进 online。关连接,由退避重连兜底
        // (等任一端升级到一致版本)。服务端通常已在 hello 阶段以 VERSION_MISMATCH 拒绝,
        // 此处是 hello-ack 路径的防御性二道闸。
        if (
          typeof ack?.serverProtocolVersion === 'number' &&
          ack.serverProtocolVersion !== PROTOCOL_VERSION
        ) {
          this.log.error(
            `device-link protocol mismatch: server v${ack.serverProtocolVersion}, client v${PROTOCOL_VERSION}; staying offline`,
          );
          // 客户端主动断开时本地 close 事件的 code 未必回传 4400,这里直接记 issue
          this.setConnectionIssue({
            kind: 'version-mismatch',
            detail: `server v${ack.serverProtocolVersion}, client v${PROTOCOL_VERSION}`,
            at: Date.now(),
          });
          this.ws?.close(4400, 'protocol version mismatch');
          return true; // close 事件经 epoch 校验后走 handleDisconnect → 退避重连
        }
        this.setConnectionIssue(null);
        this.serverCapabilities = Array.isArray(ack?.capabilities)
          ? ack.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        if (typeof ack?.deviceId === 'string' && ack.deviceId) {
          this.selfDeviceId = ack.deviceId;
        }
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
        }
        const wasOnline = this.status === 'online';
        this.setStatus('online');
        this.armReconnectStableReset();
        this.startHeartbeat();
        // 重复 hello-ack(已在线还收到 ack)单独判别:这不是新连接,而是 relay 在同一条
        // socket 上重发(relay 侧恢复 / 迁移)。若与真实重连共用同一条 online 日志,
        // 连接翻覆排障时会误判为多次重连(手机端无落盘日志,现场只有这一条线索)。
        if (wasOnline) {
          this.log.info(`duplicate hello-ack while already online (protocol=v${ack.serverProtocolVersion})`);
        } else {
          this.log.info(`device-link online (protocol=v${ack.serverProtocolVersion})`);
        }
        return true;
      }
      case 'pong':
        this.pongMisses = 0;
        return true;
      case 'presence-changed': {
        const snap = env.payload as PresenceSnapshot;
        for (const cb of this.presenceHandlers) {
          try {
            cb(snap);
          } catch (err) {
            this.log.error('presence handler threw', err);
          }
        }
        return true;
      }
      case 'invoke-result':
      case 'link-accept': {
        // 配对要 id + kind 双重命中:仅 id 撞而 kind 不符(如 invoke-result 撞到一个
        // 等 link-accept 的 pending)的帧不得错误 resolve —— 留它超时,本帧当未知帧交 host。
        const p = env.id ? this.pending.get(env.id) : undefined;
        if (p && p.expectKind === env.kind) {
          if (env.kind === 'link-accept' && env.src) {
            const accepted = env.payload as LinkAcceptPayload | undefined;
            this.setPeerCapabilities(
              env.src,
              accepted?.capabilities,
              accepted?.transportStreamId,
              accepted?.transportBaseSeq,
            );
            const peer = this.getPeerTransport(env.src);
            const resumedLink = !peer.linkReady;
            peer.linkReady = true;
            this.resumeReceiveStreams(env.src, peer);
            this.replayPending(env.src, resumedLink);
          }
          this.pending.delete(env.id!);
          p.resolve(env);
          return true;
        }
        return this.emitFrame(env);
      }
      case 'relay-error': {
        const payload = env.payload as RelayErrorPayload;
        const terminalRouteFailure = (
          payload.code === 'DEVICE_OFFLINE'
          || payload.code === 'REMOTE_DISABLED'
        );
        if (env.id && this.pending.has(env.id)) {
          const p = this.pending.get(env.id)!;
          this.pending.delete(env.id);
          // relay-error 代表原 invoke 没有交付到 peer。若它占用了可靠 stream 的 seq，
          // 不能只 reject 上层后把原请求留到重连重放，否则一个已向用户报错的写操作
          // 可能稍后突然执行。永久断链错误丢弃该 peer 全部 pending、靠下次握手 baseSeq
          // 跨过；其它单帧错误改成同 seq skip。
          if (p.reliableDst) {
            if (terminalRouteFailure) {
              this.getPeerTransport(p.reliableDst).linkReady = false;
              this.abandonReliablePending(
                p.reliableDst,
                `relay rejected reliable link (${payload.code})`,
              );
            } else {
              this.dropReliablePendingForRequest(p.reliableDst, env.id);
            }
          }
          p.reject(new DeviceLinkError(payload.code, payload.message));
          return true;
        }
        if (payload.dst && terminalRouteFailure) {
          const peer = this.getPeerTransport(payload.dst);
          peer.linkReady = false;
          if (peer.retryTimer) {
            clearInterval(peer.retryTimer);
            peer.retryTimer = null;
          }
          // 没有本地 PendingRequest 的可靠帧是 invoke-result / push。目标瞬时离线时
          // 必须保留它们，等下一次 link-open 后重放；否则原 invoke 已在请求方向 ACK，
          // 控制端不会再发一次，已完成结果会永久丢失。显式 link-close 仍会清掉 pending。
        } else if (
          env.id
          && payload.dst
          && (payload.code === 'BAD_REQUEST' || payload.code === 'PAYLOAD_TOO_LARGE')
        ) {
          // invoke-result 没有本地 PendingRequest，但仍带原 request id。永久性帧错误
          // 也要把对应 seq 换成 skip，否则它会耗尽重试并拖着整条 relay 反复重连。
          this.dropReliablePendingForRequest(payload.dst, env.id);
        }
        // 连接级(无 pending id)的 VERSION_MISMATCH:server 在 hello 阶段拒绝时先发
        // 这帧再 close(4400)。在这里直接记 issue,分类不依赖 close reason 文本——
        // close code 4400 同时承载 invalid frame / invalid envelope 等语义,reason
        // 又可能被中间层截断,这条帧是版本不符最可靠的信号。
        if (payload.code === 'VERSION_MISMATCH') {
          this.setConnectionIssue({
            kind: 'version-mismatch',
            detail: payload.message,
            at: Date.now(),
          });
        }
        this.log.warn(`relay-error: [${payload.code}] ${payload.message}`);
        return this.emitFrame(env);
      }
      default:
        // 隧道帧(invoke / link-open / link-close / push)交给 host
        if (env.kind === 'link-open' && env.src) {
          const open = env.payload as LinkOpenPayload | undefined;
          if (env.id) {
            this.rememberInboundLinkOffer(env.src, {
              requestId: env.id,
              capabilities: open?.capabilities,
              transportStreamId: open?.transportStreamId,
              transportBaseSeq: open?.transportBaseSeq,
            });
          }
        } else if (env.kind === 'link-close' && env.src) {
          this.pendingInboundLinkOffers.delete(env.src);
          const close = env.payload as LinkClosePayload | undefined;
          this.rejectPendingLinkOpen(
            env.src,
            close?.reason === 'revoked' ? 'ACCESS_REVOKED' : 'LINK_NOT_OPEN',
            close?.reason === 'revoked'
              ? 'access revoked by target device'
              : 'control link closed by peer',
          );
          const peer = this.getPeerTransport(env.src);
          peer.linkReady = false;
          peer.explicitlyClosed = true;
          // 对端关闭与本地 closeLink 语义对称：撤掉 streaming 可靠层，
          // 后续不依赖 link-open 的 listing/control invoke 可回退 legacy。
          peer.reliable = false;
          peer.remoteStreamId = null;
          peer.remoteBaseSeq = 1;
          peer.receive.clear();
          this.abandonReliablePending(env.src, 'control link closed by peer');
        }
        return this.emitFrame(env);
    }
  }

  /**
   * 可靠传输 wrapper 的接收端状态机：
   * - 同一 stream 只按 seq 连续交付；
   * - 缺片、乱序和重复只进入有界缓存，不会直接污染 host；
   * - 只有 host handler 真正成功后才推进累计 ACK；
   * - handler 失败时保留当前消息并停止后续交付，等待有限重发。
   */
  private ingestTransportEnvelope(
    env: Envelope,
  ): { handled: false } | { handled: true; result?: Promise<void> } {
    const parsed = parseTransportPayload(env.payload);
    if (!parsed || !env.src || !isReliableKind(env.kind)) return { handled: false };

    const peer = this.getPeerTransport(env.src);
    if (!peer.reliable || !peer.linkReady) {
      // 可靠业务帧只在双方完成 link-open/link-accept 能力协商后接收。断线后迟到的
      // pub/sub 帧可能被投到同 deviceId 的新进程；提前执行会绕过新基线并重复副作用。
      // 不回 ACK，让仍存活的发送端在链路重新建立后按同 seq 重放。
      this.log.debug(`dropping reliable payload before link is ready from ${env.src.slice(0, 8)}`);
      return { handled: true };
    }
    if (peer.remoteStreamId && peer.remoteStreamId !== parsed.meta.streamId) {
      this.log.debug(
        `dropping stale reliable stream from ${env.src.slice(0, 8)} expected=${peer.remoteStreamId.slice(0, 8)} got=${parsed.meta.streamId.slice(0, 8)}`,
      );
      return { handled: true };
    }
    if (!peer.remoteStreamId) peer.remoteStreamId = parsed.meta.streamId;
    const { meta } = parsed;
    const stream = this.getReceiveStream(
      peer,
      meta.streamId,
      Math.max(peer.remoteBaseSeq, meta.baseSeq ?? 1),
    );
    const isSkip = !meta.segment && (() => {
      try {
        return isTransportSkipPayload(decodeTransportJson(parsed.data));
      } catch {
        return false;
      }
    })();

    if (meta.seq <= stream.lastDeliveredSeq) {
      this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
      return { handled: true };
    }
    if (meta.seq > stream.lastDeliveredSeq + MAX_TRANSPORT_SEQUENCE_WINDOW) {
      this.log.warn(`dropping reliable payload beyond receive window seq=${meta.seq}`);
      this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
      return { handled: true };
    }
    if (stream.ready.has(meta.seq) && !isSkip) {
      this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
      const result = this.drainTransportStream(env.src, meta.streamId, stream);
      return { handled: true, result };
    }

    const segment = meta.segment;
    if (!segment) {
      const bytes = byteLength(parsed.data);
      if (isSkip) {
        this.removeReceiveEntry(stream, meta.seq);
      } else if (stream.assemblies.has(meta.seq)) {
        // 同一 seq 只有 timeout / relay-error 生成的 skip 允许从分片消息改成
        // 单帧。其它 shape 变化保留原重组，避免混入不一致 payload。
        this.log.warn(`dropping reliable payload with changed segment shape seq=${meta.seq}`);
        this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
        return { handled: true };
      }
      if (
        bytes > MAX_TRANSPORT_CHUNK_BYTES
        || !this.ensureReceiveCapacity(stream, meta.seq, bytes)
      ) {
        this.log.warn(`dropping reliable payload because receive buffer is full seq=${meta.seq}`);
        this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
        return { handled: true };
      }
      try {
        decodeTransportJson(parsed.data);
      } catch {
        this.log.warn(`dropping invalid reliable payload seq=${meta.seq}`);
        return { handled: true };
      }
      stream.ready.set(meta.seq, { env, json: parsed.data });
      stream.bufferedBytes += bytes;
    } else {
      if (segment.totalBytes > MAX_TRANSPORT_REASSEMBLY_BYTES) {
        this.log.warn(`dropping oversized reliable reassembly seq=${meta.seq}`);
        return { handled: true };
      }
      const current = stream.assemblies.get(meta.seq);
      const assembly = current ?? {
        kind: env.kind,
        id: env.id,
        src: env.src,
        dst: env.dst,
        total: segment.total,
        totalBytes: segment.totalBytes,
        chunks: new Map<number, string>(),
        bytes: 0,
      };
      if (
        assembly.kind !== env.kind ||
        assembly.id !== env.id ||
        assembly.src !== env.src ||
        assembly.dst !== env.dst ||
        assembly.total !== segment.total ||
        assembly.totalBytes !== segment.totalBytes
      ) {
        stream.bufferedBytes -= assembly.bytes;
        stream.assemblies.delete(meta.seq);
        this.log.warn(`dropping reliable payload with changed segment metadata seq=${meta.seq}`);
        this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
        return { handled: true };
      }
      if (!assembly.chunks.has(segment.index)) {
        const bytes = byteLength(parsed.data);
        if (
          bytes > MAX_TRANSPORT_CHUNK_BYTES ||
          assembly.bytes + bytes > assembly.totalBytes
          || !this.ensureReceiveCapacity(stream, meta.seq, bytes)
        ) {
          this.removeReceiveEntry(stream, meta.seq);
          this.log.warn(`dropping reliable payload beyond declared size seq=${meta.seq}`);
          return { handled: true };
        }
        assembly.chunks.set(segment.index, parsed.data);
        assembly.bytes += bytes;
        stream.bufferedBytes += bytes;
      }
      stream.assemblies.set(meta.seq, assembly);
      if (assembly.chunks.size === assembly.total) {
        const json = Array.from({ length: assembly.total }, (_, index) => assembly.chunks.get(index) ?? '').join('');
        stream.assemblies.delete(meta.seq);
        try {
          decodeTransportJson(json, assembly.totalBytes);
        } catch {
          stream.bufferedBytes -= assembly.bytes;
          this.log.warn(`dropping invalid reliable reassembly seq=${meta.seq}`);
          this.sendTransportAck(env.src, meta.streamId, stream.lastDeliveredSeq);
          return { handled: true };
        }
        stream.ready.set(meta.seq, { env, json });
      }
    }

    const result = this.drainTransportStream(env.src, meta.streamId, stream);
    return { handled: true, result };
  }

  private drainTransportStream(
    src: string,
    streamId: string,
    stream: ReceiveStreamState,
  ): Promise<void> {
    if (stream.drain) {
      stream.drainRequested = true;
      return stream.drain;
    }
    const drain = async (): Promise<void> => {
      do {
        stream.drainRequested = false;
        this.applyReceiveStreamBase(stream);
        while (stream.ready.has(stream.lastDeliveredSeq + 1)) {
          if (!this.isReceiveStreamActive(src, streamId, stream)) break;
          const nextSeq = stream.lastDeliveredSeq + 1;
          const ready = stream.ready.get(nextSeq)!;
          let logical: Envelope;
          try {
            const payload = decodeTransportJson(ready.json);
            logical = { ...ready.env, payload };
          } catch {
            this.log.warn(`dropping reliable payload decode failure seq=${nextSeq}`);
            break;
          }

          stream.deliveringSeq = nextSeq;
          let handled: boolean;
          try {
            handled = isTransportSkipPayload(logical.payload)
              ? true
              : await this.dispatchEnvelope(logical);
          } finally {
            stream.deliveringSeq = null;
          }
          if (!handled) {
            this.applyReceiveStreamBase(stream);
            if (stream.lastDeliveredSeq >= nextSeq) continue;
            this.log.warn(`reliable payload handler failed seq=${nextSeq}; waiting for retry`);
            break;
          }
          stream.ready.delete(nextSeq);
          stream.bufferedBytes -= byteLength(ready.json);
          stream.lastDeliveredSeq = nextSeq;
          this.applyReceiveStreamBase(stream);
        }
      } while (stream.drainRequested);
      if (this.isReceiveStreamActive(src, streamId, stream)) {
        this.sendTransportAck(src, streamId, stream.lastDeliveredSeq);
      }
    };
    // 先把 drain Promise 登记到 stream，再进微任务执行。否则空队列的 drain
    // 会同步跑完、随后才写入一个已 resolved 的 Promise；同一事件循环里紧接着
    // 到达的队头帧只会标记 drainRequested，却没有活着的循环再消费它。
    const task = Promise.resolve().then(drain).finally(() => {
      if (stream.drain === task) stream.drain = null;
    });
    stream.drain = task;
    return task;
  }

  private emitFrame(env: Envelope): boolean | Promise<boolean> {
    let ok = true;
    let chain: Promise<void> | null = null;
    for (const cb of this.frameHandlers) {
      const run = (): void | Promise<void> => {
        try {
          const result = cb(env);
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then(
              () => undefined,
              (err) => {
                this.log.error('frame handler threw', err);
                ok = false;
              },
            );
          }
        } catch (err) {
          this.log.error('frame handler threw', err);
          ok = false;
        }
      };
      if (chain) {
        chain = chain.then(run);
      } else {
        const result = run();
        if (isPromiseLike(result)) chain = result;
      }
    }
    return chain ? chain.then(() => ok) : ok;
  }

  /**
   * 接收缓存满时优先保住当前队头。否则未来 seq 占满 16 个槽位或字节预算后，
   * 用来补缺口的分片/skip 也进不来，累计 ACK 将永久停住。
   */
  private ensureReceiveCapacity(
    stream: ReceiveStreamState,
    seq: number,
    additionalBytes: number,
  ): boolean {
    const fits = (): boolean => {
      const hasSlot = stream.ready.has(seq) || stream.assemblies.has(seq);
      const slots = stream.ready.size + stream.assemblies.size + (hasSlot ? 0 : 1);
      return (
        slots <= MAX_TRANSPORT_REASSEMBLIES
        && stream.bufferedBytes + additionalBytes <= MAX_TRANSPORT_REASSEMBLY_BYTES
      );
    };
    if (fits()) return true;
    if (seq !== stream.lastDeliveredSeq + 1) return false;

    while (!fits()) {
      const futureSeqs = [
        ...stream.ready.keys(),
        ...stream.assemblies.keys(),
      ].filter((bufferedSeq) => bufferedSeq > seq);
      if (futureSeqs.length === 0) return false;
      this.removeReceiveEntry(stream, Math.max(...futureSeqs));
    }
    return true;
  }

  private removeReceiveEntry(stream: ReceiveStreamState, seq: number): void {
    const assembly = stream.assemblies.get(seq);
    if (assembly) {
      stream.assemblies.delete(seq);
      stream.bufferedBytes -= assembly.bytes;
    }
    const ready = stream.ready.get(seq);
    if (ready) {
      stream.ready.delete(seq);
      stream.bufferedBytes -= byteLength(ready.json);
    }
  }

  private isReceiveStreamActive(
    src: string,
    streamId: string,
    stream: ReceiveStreamState,
  ): boolean {
    const peer = this.peerTransport.get(src);
    return (
      !!peer
      && peer.reliable
      && peer.linkReady
      && peer.remoteStreamId === streamId
      && peer.receive.get(streamId) === stream
    );
  }

  private sendPeerEnvelope(env: Envelope): boolean {
    if (!env.dst || !isReliableKind(env.kind)) {
      this.sendEnvelope(env);
      return false;
    }
    const peer = this.getPeerTransport(env.dst);
    if (peer.explicitlyClosed && !peer.linkReady && !isUnlinkedLegacyEnvelope(env)) {
      throw new DeviceLinkError('LINK_NOT_OPEN', 'control link is closed');
    }
    if (!peer.reliable) {
      this.sendEnvelope(env);
      return false;
    }

    const seq = peer.nextSeq;
    let frames: Envelope[];
    let reservedBytes: number;
    try {
      frames = encodeReliableFrames(
        env,
        peer.streamId,
        seq,
        this.getTransportBaseSeq(peer),
      );
      reservedBytes = this.measurePendingReservation(env, peer.streamId, seq);
    } catch (err) {
      throw new DeviceLinkError(
        'PAYLOAD_TOO_LARGE',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (
      peer.pending.size >= MAX_TRANSPORT_PENDING_MESSAGES ||
      peer.pendingBytes + reservedBytes > MAX_TRANSPORT_PENDING_BYTES
    ) {
      throw new DeviceLinkError(
        'BACKPRESSURE',
        `reliable transport buffer is full for peer ${env.dst.slice(0, 8)}`,
      );
    }
    // link 暂未恢复时先进入有界 pending，等 link-open/link-accept 后再发。
    // 已经 ready 的初次发送若 native send buffer 满，则在占用 seq 前拒绝，
    // 避免一个从未发出的 seq 堵住累计 ACK。
    if (peer.linkReady) {
      this.assertWebSocketCapacity(this.measureReliableFrames(frames));
    }
    const pending: PendingReliableMessage = {
      seq,
      envelope: env,
      bytes: reservedBytes,
      attempts: 0,
      lastSentAt: 0,
      sent: false,
    };
    peer.pending.set(seq, pending);
    peer.pendingBytes += reservedBytes;
    peer.nextSeq = seq + 1;
    if (peer.linkReady) {
      try {
        this.sendReliableFrames(peer, pending);
      } catch (err) {
        // 容量预检后的 ws.send 仍可能因 socket 竞态失败。完全未写入时安全回滚；
        // 已部分写入则保留同 seq 等待重放，调用方继续等待，不制造重复请求。
        if (!pending.sent) {
          peer.pending.delete(seq);
          peer.pendingBytes -= reservedBytes;
          if (peer.nextSeq === seq + 1) peer.nextSeq = seq;
          throw err;
        }
        this.log.debug(`reliable transport initial send interrupted for ${env.dst.slice(0, 8)}`, err);
      }
    }
    if (peer.linkReady) this.ensureRetryTimer(env.dst);
    return true;
  }

  private sendReliableFrames(peer: PeerTransportState, pending: PendingReliableMessage): void {
    const frames = encodeReliableFrames(
      pending.envelope,
      peer.streamId,
      pending.seq,
      this.getTransportBaseSeq(peer),
    );
    this.assertWebSocketCapacity(this.measureReliableFrames(frames));
    let sentAny = false;
    try {
      for (const frame of frames) {
        this.sendEnvelope(frame);
        pending.sent = true;
        sentAny = true;
      }
    } finally {
      if (sentAny) {
        pending.sent = true;
        pending.attempts++;
        pending.lastSentAt = Date.now();
      }
    }
  }

  private measureReliableFrames(frames: readonly Envelope[]): number {
    return frames.reduce((sum, frame) => sum + byteLength(JSON.stringify(frame)), 0);
  }

  /**
   * baseSeq 永远不大于当前 seq，因此按 baseSeq=seq 编码就是该 pending
   * 可能占用的最大 wrapper 大小。这样 ACK 推进基线后动态重编码也不会突破
   * 已批准的 pendingBytes 上限。
   */
  private measureReservedReliableBytes(env: Envelope, streamId: string, seq: number): number {
    return this.measureReliableFrames(encodeReliableFrames(env, streamId, seq, seq));
  }

  private measurePendingReservation(env: Envelope, streamId: string, seq: number): number {
    const originalBytes = this.measureReservedReliableBytes(env, streamId, seq);
    if (env.kind !== 'invoke' || !env.id || !env.dst) return originalBytes;
    const skipBytes = this.measureReservedReliableBytes({
      v: PROTOCOL_VERSION,
      kind: 'invoke',
      id: env.id,
      dst: env.dst,
      payload: makeTransportSkipPayload(),
    }, streamId, seq);
    return Math.max(originalBytes, skipBytes);
  }

  private sendEnvelope(env: Envelope): void {
    const ws = this.ws;
    if (!ws) throw new DeviceLinkError('NOT_CONNECTED', 'no active connection');
    const text = JSON.stringify(env);
    // 按 UTF-8 字节数判定,与服务端 MAX_FRAME_BYTES(Buffer.byteLength)一致。
    // 用 text.length(UTF-16 码元)会与服务端不符:CJK 等多字节内容客户端自检通过、
    // 服务端却 PAYLOAD_TOO_LARGE 丢帧,invoke 只能等 30s 超时而非快速失败。
    const frameBytes = byteLength(text);
    if (frameBytes > MAX_FRAME_BYTES) {
      throw new DeviceLinkError('PAYLOAD_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    // ws / browser WebSocket 都会在 send() 后把数据放入内部缓冲。没有这个
    // 观察点的 RN 实现仍由可靠消息的有界 pending buffer 兜底；有这个观察点
    // 时提前拒绝，避免弱网下 native socket 持续吃内存。
    this.assertWebSocketCapacity(frameBytes);
    ws.send(text);
  }

  private assertWebSocketCapacity(additionalBytes: number): void {
    const ws = this.ws;
    if (!ws) throw new DeviceLinkError('NOT_CONNECTED', 'no active connection');
    if (
      typeof ws.bufferedAmount === 'number'
      && ws.bufferedAmount + additionalBytes > MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES
    ) {
      throw new DeviceLinkError('BACKPRESSURE', 'websocket send buffer is full');
    }
  }

  private getPeerTransport(dst: string): PeerTransportState {
    let peer = this.peerTransport.get(dst);
    if (!peer) {
      peer = {
        streamId: createRequestId(),
        remoteStreamId: null,
        remoteBaseSeq: 1,
        nextSeq: 1,
        reliable: false,
        linkReady: false,
        explicitlyClosed: false,
        pending: new Map(),
        pendingBytes: 0,
        retryTimer: null,
        receive: new Map(),
        highestAckSeq: 0,
        lastReplayEpoch: this.connEpoch,
      };
      this.peerTransport.set(dst, peer);
    }
    return peer;
  }

  private getReceiveStream(
    peer: PeerTransportState,
    streamId: string,
    baseSeq = 1,
  ): ReceiveStreamState {
    let stream = peer.receive.get(streamId);
    if (!stream) {
      if (peer.receive.size >= MAX_TRANSPORT_REASSEMBLIES) {
        const oldest = peer.receive.keys().next().value as string | undefined;
        if (oldest) peer.receive.delete(oldest);
      }
      stream = {
        lastDeliveredSeq: Math.max(0, baseSeq - 1),
        requestedBaseSeq: baseSeq,
        deliveringSeq: null,
        assemblies: new Map(),
        ready: new Map(),
        bufferedBytes: 0,
        drain: null,
        drainRequested: false,
      };
      peer.receive.set(streamId, stream);
    } else {
      this.advanceReceiveStreamBase(stream, baseSeq);
    }
    return stream;
  }

  private advanceReceiveStreamBase(stream: ReceiveStreamState, baseSeq: number): void {
    stream.requestedBaseSeq = Math.max(stream.requestedBaseSeq, baseSeq);
    this.applyReceiveStreamBase(stream);
  }

  private applyReceiveStreamBase(stream: ReceiveStreamState): void {
    const baseSeq = stream.requestedBaseSeq;
    const target = Math.max(0, baseSeq - 1);
    if (target <= stream.lastDeliveredSeq) return;
    // 已进入 host 的副作用无法取消；等本轮 settle 后再跨过。尚未开始或曾失败
    // 留在 ready 队头的消息可以安全按发送端新基线丢弃。
    if (stream.deliveringSeq !== null && stream.deliveringSeq < baseSeq) return;
    for (const [seq, assembly] of stream.assemblies) {
      if (seq >= baseSeq) continue;
      stream.assemblies.delete(seq);
      stream.bufferedBytes -= assembly.bytes;
    }
    for (const [seq, ready] of stream.ready) {
      if (seq >= baseSeq) continue;
      stream.ready.delete(seq);
      stream.bufferedBytes -= byteLength(ready.json);
    }
    stream.lastDeliveredSeq = target;
  }

  private resumeReceiveStreams(src: string, peer: PeerTransportState): void {
    for (const [streamId, stream] of peer.receive) {
      this.applyReceiveStreamBase(stream);
      if (!stream.ready.has(stream.lastDeliveredSeq + 1)) continue;
      void this.drainTransportStream(src, streamId, stream).catch((err) => {
        this.log.error('device-link reliable stream resume failed', err);
      });
    }
  }

  private setPeerCapabilities(
    dst: string,
    capabilities?: readonly string[],
    remoteStreamId?: string,
    remoteBaseSeq?: number,
  ): void {
    const peer = this.getPeerTransport(dst);
    const reliable = (
      Array.isArray(capabilities)
      && capabilities.includes(DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT)
    );
    const nextRemoteStreamId = reliable && typeof remoteStreamId === 'string' && remoteStreamId
      ? remoteStreamId
      : null;
    const nextRemoteBaseSeq = reliable && Number.isSafeInteger(remoteBaseSeq) && remoteBaseSeq! > 0
      ? remoteBaseSeq!
      : 1;
    if (peer.remoteStreamId !== nextRemoteStreamId) {
      peer.receive.clear();
    }
    if (peer.reliable && !reliable) {
      this.abandonReliablePending(dst, 'peer no longer supports reliable transport');
    }
    peer.reliable = reliable;
    peer.explicitlyClosed = false;
    peer.remoteStreamId = nextRemoteStreamId;
    peer.remoteBaseSeq = nextRemoteBaseSeq;
    if (nextRemoteStreamId) {
      this.getReceiveStream(peer, nextRemoteStreamId, nextRemoteBaseSeq);
    }
  }

  private addLocalCapabilities(dst: string, payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    // link-open 的 payload 是端到端对象；对未知旧 shape 不强行包一层，
    // 但已有 capabilities 时保留其它能力并去重。
    if (!('controllerName' in payload) && !('protocolVersion' in payload)) return payload;
    return {
      ...payload,
      capabilities: this.mergeCapabilities(payload.capabilities, [
        DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT,
      ]),
      transportStreamId: typeof payload.transportStreamId === 'string'
        ? payload.transportStreamId
        : this.getPeerTransport(dst).streamId,
      transportBaseSeq: this.getTransportBaseSeq(this.getPeerTransport(dst)),
    };
  }

  private getTransportBaseSeq(peer: PeerTransportState): number {
    return peer.pending.keys().next().value as number | undefined
      ?? peer.nextSeq;
  }

  private mergeCapabilities(
    current: unknown,
    additions: readonly string[],
  ): string[] {
    const result = Array.isArray(current)
      ? current.filter((value): value is string => typeof value === 'string')
      : [];
    for (const addition of additions) {
      if (!result.includes(addition)) result.push(addition);
    }
    return result;
  }

  private sendTransportAck(dst: string, streamId: string, ackSeq: number): void {
    try {
      this.sendEnvelope(makeTransportAck(dst, streamId, ackSeq));
    } catch (err) {
      this.log.debug('reliable transport ACK send failed', err);
    }
  }

  private handleTransportAck(src: string, streamId: string, ackSeq: number): void {
    const peer = this.peerTransport.get(src);
    if (!peer || !peer.reliable || !peer.linkReady || peer.streamId !== streamId) return;
    if (ackSeq > peer.nextSeq - 1 || ackSeq <= peer.highestAckSeq) return;
    peer.highestAckSeq = ackSeq;
    for (const [seq, pending] of peer.pending) {
      if (seq > ackSeq) break;
      peer.pending.delete(seq);
      peer.pendingBytes -= pending.bytes;
    }
    if (peer.pending.size === 0 && peer.retryTimer) {
      clearInterval(peer.retryTimer);
      peer.retryTimer = null;
    }
  }

  private ensureRetryTimer(dst: string): void {
    const peer = this.getPeerTransport(dst);
    if (peer.retryTimer) return;
    peer.retryTimer = setInterval(
      () => this.retryPending(dst, false),
      this.timing.transportRetryIntervalMs,
    );
  }

  private retryPending(dst: string, force: boolean): void {
    const peer = this.peerTransport.get(dst);
    if (
      !peer
      || !peer.reliable
      || !peer.linkReady
      || this.stopped
      || this.status !== 'online'
    ) return;
    const now = Date.now();
    for (const pending of peer.pending.values()) {
      if (!force && now - pending.lastSentAt < this.timing.transportRetryIntervalMs) continue;
      if (pending.attempts >= this.timing.transportMaxRetryAttempts) {
        this.forceReconnectForReliableTimeout(dst, pending.seq);
        return;
      }
      try {
        this.sendReliableFrames(peer, pending);
      } catch (err) {
        this.log.debug(`reliable transport retry failed for ${dst.slice(0, 8)}`, err);
        break;
      }
    }
  }

  private replayPending(dst: string, resumedLink = false): void {
    const peer = this.peerTransport.get(dst);
    if (!peer || !peer.reliable || !peer.linkReady || peer.pending.size === 0) return;
    if (resumedLink || peer.lastReplayEpoch !== this.connEpoch) {
      peer.lastReplayEpoch = this.connEpoch;
      for (const pending of peer.pending.values()) {
        pending.attempts = 0;
        pending.lastSentAt = 0;
      }
    }
    this.retryPending(dst, true);
    this.ensureRetryTimer(dst);
  }

  private forceReconnectForReliableTimeout(dst: string, seq: number): void {
    if (this.stopped || this.status !== 'online') return;
    this.log.warn(
      `reliable transport ACK timeout for ${dst.slice(0, 8)} seq=${seq}; forcing reconnect`,
    );
    const ws = this.ws;
    this.ws = null;
    this.connEpoch++;
    closeOrTerminate(ws);
    this.handleDisconnect(1006, 'reliable transport retry exhausted');
  }

  private abandonReliablePending(dst: string, message: string): void {
    const peer = this.peerTransport.get(dst);
    if (peer) {
      if (peer.retryTimer) {
        clearInterval(peer.retryTimer);
        peer.retryTimer = null;
      }
      peer.pending.clear();
      peer.pendingBytes = 0;
    }
    const err = new DeviceLinkError('NOT_CONNECTED', message);
    err.inFlight = true;
    for (const [id, pending] of this.pending) {
      if (pending.reliableDst !== dst) continue;
      this.pending.delete(id);
      pending.reject(err);
    }
  }

  private rejectPendingLinkOpen(
    dst: string,
    code: 'LINK_NOT_OPEN' | 'ACCESS_REVOKED',
    message: string,
  ): void {
    for (const [id, pending] of this.pending) {
      if (pending.expectKind !== 'link-accept' || pending.dst !== dst) continue;
      this.pending.delete(id);
      pending.reject(new DeviceLinkError(code, message));
    }
  }

  private clearPeerTransport(): void {
    for (const peer of this.peerTransport.values()) {
      if (peer.retryTimer) clearInterval(peer.retryTimer);
    }
    this.peerTransport.clear();
  }

  private rememberInboundLinkOffer(src: string, offer: PendingInboundLinkOffer): void {
    this.pendingInboundLinkOffers.delete(src);
    this.pendingInboundLinkOffers.set(src, offer);
    while (this.pendingInboundLinkOffers.size > MAX_PENDING_INBOUND_LINK_OFFERS) {
      const oldest = this.pendingInboundLinkOffers.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingInboundLinkOffers.delete(oldest);
    }
  }

  private setConnectionIssue(issue: DeviceLinkConnectionIssue | null): void {
    const prev = this.connectionIssue;
    if (prev === issue) return;
    if (prev && issue && prev.kind === issue.kind) {
      // 同类问题重复发生(401 每轮重连都触发):静默更新详情,不重复打扰订阅者
      this.connectionIssue = issue;
      return;
    }
    this.connectionIssue = issue;
    for (const cb of this.issueHandlers) {
      try {
        cb(issue);
      } catch (err) {
        this.log.error('connection issue handler threw', err);
      }
    }
  }

  private setStatus(s: DeviceLinkStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusHandlers) {
      try {
        cb(s);
      } catch (err) {
        this.log.error('status handler threw', err);
      }
    }
  }

  private armReconnectStableReset(): void {
    if (this.reconnectStableTimer) clearTimeout(this.reconnectStableTimer);
    this.reconnectStableTimer = setTimeout(() => {
      this.reconnectStableTimer = null;
      if (!this.stopped && this.status === 'online') this.reconnectAttempt = 0;
    }, this.timing.reconnectStableResetMs);
  }
}

function closeReasonToString(reason: unknown): string {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  const text = String(reason);
  return text === '[object Object]' ? '' : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReliableKind(kind: Envelope['kind']): kind is 'invoke' | 'invoke-result' | 'push' {
  return kind === 'invoke' || kind === 'invoke-result' || kind === 'push';
}

/**
 * 这些调用属于 listing/control tier，不需要 streaming link-open。
 * 显式 closeLink() 只应撤掉可靠 streaming 层；列表刷新、能力探针、词典
 * 快照和 topic 订阅仍要沿用旧 envelope 路径，兼容 link-open 之前的既有语义。
 */
const UNLINKED_LEGACY_INVOKE_CHANNELS = new Set([
  'device-link:subscribe',
  'device-link:unsubscribe',
  'device-link:voice:dictionary:get',
  'maker:provider:list',
  'maker:get-capabilities',
  'maker:get-new-maker-defaults',
  'maker:list-active',
  'maker:list-available-agents',
  'maker:list-agent-commands',
  'maker:list-agent-skills',
  'local-db:sessions:list',
  'local-db:sessions:get',
  'local-db:history:messages',
  'local-db:messages:list',
  'local-db:messages:around',
  'local-db:messages:around-client-id',
  'local-db:messages:estimatedSessionValue',
  'local-db:recent-workdirs:list',
  'local-db:sessions:interrupted-pending',
  'maker:git-safety:get',
]);

function isUnlinkedLegacyEnvelope(env: Envelope): boolean {
  if (env.kind !== 'invoke') return false;
  const payload = env.payload as Partial<InvokePayload> | undefined;
  return typeof payload?.channel === 'string'
    && UNLINKED_LEGACY_INVOKE_CHANNELS.has(payload.channel);
}

function isLegacyBusinessFrame(kind: Envelope['kind']): boolean {
  return (
    kind === 'invoke'
    || kind === 'push'
    || kind === 'link-open'
    || kind === 'link-close'
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 立即回收 socket:优先 terminate(硬断);无 terminate 实现(RN WebSocket)时退回 close。 */
function closeOrTerminate(ws: WsLike | null): void {
  if (!ws) return;
  try {
    if (ws.terminate) ws.terminate();
    else ws.close();
  } catch {
    // 已断开的 socket 上 close/terminate 可能抛,忽略
  }
}

/** 给 promise 加超时上限;超时后 reject,原 promise 的最终结果被忽略。 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
