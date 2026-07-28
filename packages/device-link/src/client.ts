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
  type InvokePayload,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkCloseReason,
  type LinkClosePayload,
} from './protocol.js';

/** 出站帧字节数测量复用一个 encoder(encode 无状态);避免每帧 new 一个。 */
const FRAME_ENCODER = new TextEncoder();
const DUPLICATE_CONNECTION_CLOSE_CODE = 4409;
const SLOW_REQUEST_WARN_MS = 1_000;

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
export type InboundFrameHandler = (env: Envelope) => void;

interface PendingRequest {
  resolve(env: Envelope): void;
  reject(err: DeviceLinkError): void;
  timer: ReturnType<typeof setTimeout>;
  /** 期望的响应 kind —— 配对时除 id 外还要 kind 一致,挡 id 撞但 kind 不符的帧。 */
  expectKind: 'invoke-result' | 'link-accept';
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
    this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'presence-set', payload: patch });
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
    const env = await this.request(
      { v: PROTOCOL_VERSION, kind: 'link-open', dst, payload },
      'link-accept',
      timeoutMs,
    );
    return env.payload as LinkAcceptPayload;
  }

  /** 任一端:解除控制链路(fire-and-forget) */
  closeLink(dst: string, reason: LinkCloseReason): void {
    if (this.status !== 'online') return;
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
      kind: 'link-close',
      dst,
      payload: { reason } satisfies LinkClosePayload,
    });
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
    this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'invoke-result', id: requestId, dst, payload });
  }

  /** 被控端:回 link-accept */
  sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void {
    this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'link-accept', id: requestId, dst, payload });
  }

  /** 被控端:广播转发 push 帧(fire-and-forget;失败由上层缓冲策略兜底) */
  sendPush(dst: string, channel: string, payload: unknown): void {
    if (this.status !== 'online') return;
    this.sendEnvelope({ v: PROTOCOL_VERSION, kind: 'push', dst, payload: { channel, payload } });
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
      });

      try {
        this.sendEnvelope({ ...env, id });
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

  // ─── 内部:连接管理 ─────────────────────────────────────────────────────────

  private async connect(reason: string): Promise<void> {
    if (this.stopped) return;
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
      this.failAllPending(new DeviceLinkError('NOT_CONNECTED', `connection restarted (${reason})`));
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
      this.handleMessage(data.toString());
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
    this.failAllPending(new DeviceLinkError('NOT_CONNECTED', 'relay connection lost'));
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
          return; // close 事件经 epoch 校验后走 handleDisconnect → 退避重连
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
        return;
      }
      case 'pong':
        this.pongMisses = 0;
        return;
      case 'presence-changed': {
        const snap = env.payload as PresenceSnapshot;
        for (const cb of this.presenceHandlers) {
          try {
            cb(snap);
          } catch (err) {
            this.log.error('presence handler threw', err);
          }
        }
        return;
      }
      case 'invoke-result':
      case 'link-accept': {
        // 配对要 id + kind 双重命中:仅 id 撞而 kind 不符(如 invoke-result 撞到一个
        // 等 link-accept 的 pending)的帧不得错误 resolve —— 留它超时,本帧当未知帧交 host。
        const p = env.id ? this.pending.get(env.id) : undefined;
        if (p && p.expectKind === env.kind) {
          this.pending.delete(env.id!);
          p.resolve(env);
          return;
        }
        this.emitFrame(env);
        return;
      }
      case 'relay-error': {
        const payload = env.payload as RelayErrorPayload;
        if (env.id && this.pending.has(env.id)) {
          const p = this.pending.get(env.id)!;
          this.pending.delete(env.id);
          p.reject(new DeviceLinkError(payload.code, payload.message));
          return;
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
        this.emitFrame(env);
        return;
      }
      default:
        // 隧道帧(invoke / link-open / link-close / push)交给 host
        this.emitFrame(env);
    }
  }

  private emitFrame(env: Envelope): void {
    for (const cb of this.frameHandlers) {
      try {
        cb(env);
      } catch (err) {
        this.log.error('frame handler threw', err);
      }
    }
  }

  private sendEnvelope(env: Envelope): void {
    const ws = this.ws;
    if (!ws) throw new DeviceLinkError('NOT_CONNECTED', 'no active connection');
    const text = JSON.stringify(env);
    // 按 UTF-8 字节数判定,与服务端 MAX_FRAME_BYTES(Buffer.byteLength)一致。
    // 用 text.length(UTF-16 码元)会与服务端不符:CJK 等多字节内容客户端自检通过、
    // 服务端却 PAYLOAD_TOO_LARGE 丢帧,invoke 只能等 30s 超时而非快速失败。
    const byteLength = FRAME_ENCODER.encode(text).length;
    if (byteLength > MAX_FRAME_BYTES) {
      throw new DeviceLinkError('PAYLOAD_TOO_LARGE', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    ws.send(text);
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
