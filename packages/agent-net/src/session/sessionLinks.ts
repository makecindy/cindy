/**
 * Agent-Net 会话层上的控制链路（docs/agent-net-session-plan.md 第 10.1 节）。两台都启用了会话层的电脑之间（同账号，
 * 以及跨账号分享的受邀者与分享资源的电脑），建链、调用、回结果和推送不再经过 Device Link，而走 Agent-Net 自己的会话
 * （packages/agent-net/src/session/）。跨账号对端的键就是 Device Link 分享帧解出来的逻辑对端，编码和 Device Link 给跨账号的一样。
 * 这里把会话翻译成 Device Link 客户端交给业务的接口和帧形状，业务代码（dispatch.ts、index.ts）不变：
 * - 控制端：openLink / invoke / closeLink 走会话。结果缓存与压缩、列表增量、正文复用、历史页增量、标签目录、模型速度
 *   的编解码用和 Device Link 客户端同一批模块、同一套请求字段，调用排队用同一个 InvokeScheduler。
 * - 被控端：会话来的 link-open / invoke / push / link-close 原样交给 onFrame 的处理者（dispatch），回复走请求来的那条会话；
 *   结果按控制端在这次请求上的声明编码，推送按它建链时声明的字典压缩。
 * 送达只靠会话层（核心负责重传与拥塞控制），这里不确认、不重发、不因慢重置。哪个对端走这里由 sessionRouting.ts 决定。
 */
import {
  DEVICE_LINK_CAPABILITY_GITHUB_READ_V1, DeviceLinkError, HistoryViewDeltaCache, InboundInvokeTransferOptions, InvokeDeltaBases,
  InvokeResultCache, InvokeScheduler, PROTOCOL_VERSION, SessionMessageReuse, acceptedPushDeflateDictionaries,
  bypassInvokeScheduling, decodeModelSpeedPayload, decodePushTransfer, decodeSessionTagCatalog, encodeInvokeResultTransfer,
  encodeModelSpeedPayload, encodePushTransfer, isEncodedPushPayload, isHistoryViewDeltaMiss, pushDeflateCapabilities,
  isFilePeerStreamRead, isFilePeerStreamTransfer, isPeerResetRetryableInvoke, isRemoteAgentUploadChunk, isScopedPeer, isUnlinkedPushChannel, REMOTE_DESKTOP_CHANNEL, requestSessionTagCatalog, resolveInvokePriority,
  type DeviceLinkErrorCode, type DeviceLinkPeerLinkSnapshot, type DeviceLinkPeerRouteStateChanged, type DeviceLinkTransferCodec,
  type Envelope, type InvokePayload, type InvokeResultPayload, type LinkAcceptPayload, type LinkCloseReason, type PresenceSnapshot,
  type PushPayload, diagnosticChannel, invokeIntendedHoldMs, shortDeviceRef,
} from '@cindy/device-link';
import { SessionError, newSessionRequestId, type SessionHandle, type SessionHandlers, type SessionRequest, type SessionResult } from './peer.js';
import type { SessionLane } from './lanes.js';
import { SESSION_INVOKE_REPLAY, type PeerInvokePayload, type PeerLinkMergedMethod, type PeerLinkRoutedMethod, type PeerLinks } from './peerLinks.js';

type PushOwnerStamp = NonNullable<PushPayload['ownerStamp']>;

/** 会话的通道：和 Device Link 的调用优先级同一套划分（交互 → 控制与交互，后台 → 后台，其余 → 普通）。 */
export function agentNetSessionLane(channel: string, background?: boolean): SessionLane {
  const priority = resolveInvokePriority(channel, background);
  return priority === 'interactive' ? 'control' : priority === 'background' ? 'background' : 'normal';
}
/**
 * 按单条请求改通道（不改的返回 undefined，按通道走 agentNetSessionLane）。远程桌面的续租心跳、键鼠输入（WebRTC 输入通道不通时的兜底）
 * 和停止很小、等不起：走控制通道，不排在任务列表、历史页后面（会话方案第 3 节：续租 P0、输入 P1）。同一通道的截图、SDP 照旧走普通通道。
 */
export function agentNetRequestLane(channel: string, args: unknown[] | undefined): SessionLane | undefined {
  const op = (args?.[0] as { op?: unknown } | undefined)?.op;
  return (channel === REMOTE_DESKTOP_CHANNEL && (op === 'heartbeat' || op === 'input' || op === 'stop'))
    || resolveInvokePriority(channel, undefined, args) === 'interactive' ? 'control' : undefined;
}
type FrameHandler = (env: Envelope) => unknown | Promise<unknown>;

/**
 * 会话层的发送积压按 32 KiB 折算成 Device Link 的「待确认消息数」。Device Link 的可靠窗口是 16 条；dispatch 的活动镜像最多占半窗
 * （SESSION_ACTIVITY_WINDOW_SOFT_CAP = 8 条），在会话上约等于 256 KiB 排队时停止灌入。
 */
const QUEUE_DEPTH_UNIT_BYTES = 32 * 1024;
/** 发送积压超过它时推送与结果报 BACKPRESSURE，业务按 Device Link 的约定排队重试或合并。 */
const SEND_BACKLOG_LIMIT_BYTES = 32 * 1024 * 1024;
/** 单条消息的上限（会话层 16 MiB）留出外层余量；超过时同步报 PAYLOAD_TOO_LARGE，dispatch 照旧压缩或换成错误。 */
const MAX_MESSAGE_BYTES = 15 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * 对端连接刚建好（或换了一条）时，双方的会话宣告还要一来一回才到。这段时间里要建链或调用，先等会话：
 * 往返时间知道时等 SESSION_GRACE_MIN_MS + 4 个往返，不知道或更长时最多 SESSION_GRACE_MAX_MS，从连接建好算起。
 * 没启用会话的旧对端只在连上后的这一小段里多等一次，之后照常走 Device Link。
 */
const SESSION_GRACE_MIN_MS = 250;
const SESSION_GRACE_MAX_MS = 1500;
/** 被控端记着的「经会话来、还没回结果」的请求 id 上限；超过时丢掉最早的（它的结果改走 Device Link，对端按 id 配不上而丢弃）。 */
const MAX_TRACKED_REQUESTS = 4096;
/** 和 Device Link 一样（client.ts SLOW_REQUEST_WARN_MS）：请求超过这么久（加上通道本来就要挂起的时长）记一条慢请求。 */
const SLOW_REQUEST_LOG_MS = 1_000;
/**
 * 会话上另外不需要链路的推送：自己电脑之间的词典同步（voice-input/dictionarySyncDriver.ts 的 DL_VOICE_DICTIONARY_SYNC_CHANNEL；那个模块
 * 带着存储，这里只用通道名）。Device Link 上它走不需要链路的旧帧；会话上原来没有它的位置，两台新电脑之间它就成了连接上的 Device Link
 * 帧（2026-11-17 审查）。不改 Device Link 自己的名单（isUnlinkedPushChannel）。收到以后照旧由业务按设备平台、撤销状态把关。
 */
const SESSION_UNLINKED_PUSH_CHANNELS = new Set(['device-link:voice:dictionary:sync-state']);
/** 会话上不需要控制链路的推送：Device Link 的名单加上 SESSION_UNLINKED_PUSH_CHANNELS。 */
export function isSessionUnlinkedPushChannel(channel: string): boolean {
  return isUnlinkedPushChannel(channel) || SESSION_UNLINKED_PUSH_CHANNELS.has(channel);
}
/**
 * 还没连着对方电脑时，第一次建链最多等这么久连上它（中转上打洞、握手）。对方开着 Agent-Net 时 Device Link 的帧也经这条连接，
 * 同样要等这次拨号，所以不比原来慢。
 */
const CONNECT_WAIT_MS = 8000;
/**
 * 对方刚签名说自己开着 Agent-Net（Device Link 在中转上探测到）时，最多等这么久它的会话：它正在上 Agent-Net（真机 0.7 秒；Desktop 启动时
 * 取证书、起 worker、连中继要 1～2 秒）。主连接上的重开同样要等这次连接，等不到才按原来的路走。
 */
const ATTESTED_SESSION_WAIT_MS = 3000;

export interface AgentNetSessionLinksOptions {
  /** 和这个对端的会话（同账号在主连接上，跨账号在它登记的连接上）；连接换了、对端没启用会话时为 null。 */
  session(deviceId: string): SessionHandle | null;
  /** 承载这个对端的那条连接的代次（业务拿离线事件和它比）。 */
  connectionEpoch(deviceId: string): number;
  /**
   * 还没连上对方电脑时先连：跨账号是受邀者第一次用，同账号是对方此刻在 Agent-Net 上在线、连接还没建（刚启动、连接刚断）。
   * 连上为 true；不提供、对方不在线或连不上时为 false，不等会话。
   */
  connect?(deviceId: string): Promise<boolean>;
  /**
   * 这个对端在本机 Agent-Net 上的状态，同步判断。同账号：'online' 此刻在 Agent-Net 上在线（连着，或目录里在线），可以先拨它；
   * 'offline' 是本账号的 Agent-Net 设备但此刻不在线；null 本机关着 Agent-Net，或它不是 Agent-Net 设备。
   * 跨账号：有能开它会话的分享连接时为 'online'，否则 null（只看有没有那条连接，连没连上由 connect 去连）。
   */
  agentNetPeer?(deviceId: string): 'online' | 'offline' | null;
  selfDeviceId(): string | null;
  transferCodec?: DeviceLinkTransferCodec;
  requestTimeoutMs?: number;
  path?(deviceId: string): 'direct' | 'relay' | null;
  rttMs?(deviceId: string): number | null;
  /** Agent-Net 主连接上和这个对端的这条连接是什么时候建好（或换上）的，`performance.now()` 时刻；没连着时为 null。 */
  connectedAt?(deviceId: string): number | null;
  /** 和这个对端的会话没了（不论有没有链路）：搭在这条会话上的别的东西（文件直传的连接）跟着收掉。 */
  onSessionClosed?(deviceId: string): void;
  /**
   * 和这个对端的会话又有了，而本机对它的控制链路是在上一条会话上断的：请业务按原来的重开流程把链路重开（Desktop 的
   * transportTimeoutReopen：只对本机还在控制、有订阅或在途请求的对端，每次尝试前复查授权）。和 Device Link 断线重连后自动
   * 重建链路一样；在途的请求等链路重开后用原请求号再发一次（request）。
   */
  reopenLink?(deviceId: string): void;
  /**
   * 本机作为被控端：这台对这个控制端的请求去重记忆是哪一份（Desktop dispatch.remoteInvokeEpoch）。链路回复带上它
   * （`agentNetInvokeEpoch`）；控制端断线后只在重开的链路上它没变时才用原请求号再发。不提供时对方不再发。
   */
  invokeEpoch?(deviceId: string): string | null;
  /** 只写缩短的设备号与状态码，不写载荷。 */
  log: { debug(message: string, ...rest: unknown[]): void; info(message: string, ...rest: unknown[]): void; warn(message: string, ...rest: unknown[]): void;
    error(message: string, ...rest: unknown[]): void };
}

interface PeerState {
  /** 这个对端上次建链、接受时的代次，同一连接内每次建链递增（dispatch 用它丢弃过期的离线事件）。 */
  generation: number;
  outbound: 'idle' | 'opening' | 'open';
  /** 出站链路开过、后来断了（不是本机显式关闭），业务应重开。 */
  outboundLost: boolean;
  outboundClosed: boolean;
  inbound: boolean;
  /** 对端控制本机时最近一次 link-open 的 id 与它声明的能力。 */
  offer: { id: string; capabilities: string[]; resumeOnly: boolean } | null;
  pushDictionary: number | undefined;
  githubRead: boolean;
  pendingInvokes: number;
  /** 经会话来的入站请求 id：回结果走会话。 */
  requests: Set<string>;
  sentAt: number | null;
  receivedAt: number | null;
  /** 和这个对端最近一次建好的链路在会话上（之后没在 Device Link 上建过）：链路代次以这里为准，断开后的离线事件也是。 */
  linkOnSession: boolean;
  /** 对方最近一次链路回复里它的请求去重记忆是哪一份（agentNetInvokeEpoch）；没带为 null。 */
  hostInvokeEpoch: string | null;
  /** 本机正在会话上建的控制链路：对端关链（拒绝、撤权）时用它马上结束，不等超时。 */
  refuseOpen: ((error: DeviceLinkError) => void) | null;
}

const transportFailure: Record<string, DeviceLinkErrorCode> = {
  NOT_SENT: 'LINK_NOT_OPEN', INVOKE_TIMEOUT: 'INVOKE_TIMEOUT', LINK_TIMEOUT: 'INVOKE_TIMEOUT', DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE', UNAUTHORIZED: 'ACCESS_REVOKED',
};

function toDeviceLinkError(code: string, message: string): DeviceLinkError {
  return new DeviceLinkError(transportFailure[code] ?? (code as DeviceLinkErrorCode), message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeCapabilities(current: unknown, additions: readonly string[]): string[] {
  const result = Array.isArray(current) ? current.filter((value): value is string => typeof value === 'string') : [];
  for (const addition of additions) if (!result.includes(addition)) result.push(addition);
  return result;
}

/** 不在 Main 上序列化就估出大约多少字节：字符串按长度，其余有界地遍历。只用于同步的大小与背压判断。 */
function roughBytes(value: unknown, budget = { nodes: 20_000 }): number {
  if (typeof value === 'string') return value.length + 2;
  if (value === null || typeof value !== 'object') return 8;
  if (--budget.nodes < 0) return 0;
  let total = 2;
  if (Array.isArray(value)) { for (const item of value) total += roughBytes(item, budget) + 1; return total; }
  for (const key in value as Record<string, unknown>) total += key.length + 3 + roughBytes((value as Record<string, unknown>)[key], budget);
  return total;
}

type Attempt = { result: InvokeResultPayload; retry?: 'remaining-budget' } | { retry: 'full-timeout'; error: unknown };

export class AgentNetSessionLinks implements Pick<PeerLinks, PeerLinkRoutedMethod | PeerLinkMergedMethod> {
  private readonly peers = new Map<string, PeerState>();
  private readonly frameHandlers = new Set<FrameHandler>();
  private readonly routeHandlers = new Set<(change: DeviceLinkPeerRouteStateChanged) => void>();
  private readonly acceptedHandlers = new Set<(peer: string, streamId: string) => void>();
  private readonly releasedHandlers = new Set<(peer: string) => void>();
  private readonly remoteControlDisabled = new Set<string>();
  private readonly pushDeflateRejected = new Set<string>();
  private readonly scheduler: InvokeScheduler;
  private readonly invokeResultCache: InvokeResultCache;
  private readonly inboundTransfer = new InboundInvokeTransferOptions();
  private readonly deltaBases = new InvokeDeltaBases();
  private readonly messageReuse = new SessionMessageReuse();
  private readonly historyViewDelta = new HistoryViewDeltaCache();
  /** 正等着会话就绪的对端：同一个对端的等待共用一个，按到达顺序放行。 */
  private readonly sessionWaits = new Map<string, { promise: Promise<void>; release(): void; until(ms: number): void }>();
  /** 在途请求在等这个对端的控制链路在新会话上重开（awaitReopened）；链路状态一变就各自复查。 */
  private readonly reopenWaiters = new Map<string, Set<() => void>>();
  private readonly streamIds = new WeakMap<SessionHandle, string>();
  private streamCounter = 0;
  private stopped = false;

  constructor(private readonly options: AgentNetSessionLinksOptions) {
    this.scheduler = new InvokeScheduler((peer) => (this.live(peer)?.bufferedAmount ?? 0) > SEND_BACKLOG_LIMIT_BYTES / 4);
    this.invokeResultCache = new InvokeResultCache(options.transferCodec);
  }

  // ─── 选路查询（sessionRouting.ts） ───────────────────────────────

  /** 这个对端现在能走会话（双方都启用了，连接在）。 */
  available(deviceId: string): boolean { return !this.stopped && !!this.live(deviceId); }
  /** 本机对这个对端的控制链路正走会话（建链中或已建好）。 */
  ownsOutbound(deviceId: string): boolean { return this.peers.get(deviceId)?.outbound !== undefined && this.peers.get(deviceId)!.outbound !== 'idle'; }
  /** 对端对本机的控制链路走会话（已接受，或 link-open 正等本机回答）。 */
  ownsInbound(deviceId: string): boolean { const peer = this.peers.get(deviceId); return !!peer && (peer.inbound || peer.offer !== null); }
  ownsLinkOpen(deviceId: string, requestId: string): boolean { return this.peers.get(deviceId)?.offer?.id === requestId; }
  ownsRequest(deviceId: string, requestId: string): boolean { return this.peers.get(deviceId)?.requests.has(requestId) === true; }
  /** 这个对端最近用过会话（链路状态以这里为准）。 */
  knows(deviceId: string): boolean { return this.ownsOutbound(deviceId) || this.ownsInbound(deviceId) || this.peers.get(deviceId)?.outboundLost === true; }
  /** 这个对端和 Agent-Net 有关：用过会话，或本机的节点认识它。Agent-Net 关着时都不是（选路日志只记这些）。 */
  involves(deviceId: string): boolean { return this.knows(deviceId) || this.options.agentNetPeer?.(deviceId) != null; }
  /**
   * 本机对这个对端的控制方向以这里为准：会话上开着或正在开，或者会话上的那条断了待恢复、被本机关过（之后没在 Device Link 上建过）。
   * 只看出站：对端经会话控制本机、本机经 Device Link 控制对端时，Device Link 上的恢复与关链状态照旧由它自己报（2026-11-17 review）。
   */
  knowsOutbound(deviceId: string): boolean {
    const peer = this.peers.get(deviceId);
    return this.ownsOutbound(deviceId) || peer?.outboundLost === true || peer?.outboundClosed === true;
  }
  /**
   * 这个对端的链路代次以这里为准：链路正在会话上，或最近一次建好的链路在会话上（会话断开时先清链路状态、再发离线事件，
   * 业务比代次时还要拿到会话的代次；按 Device Link 的比，它之前在 Device Link 上建过更多次链路时离线事件会被当成过期丢掉）。
   */
  ownsGeneration(deviceId: string): boolean {
    return this.ownsOutbound(deviceId) || this.ownsInbound(deviceId) || this.peers.get(deviceId)?.linkOnSession === true;
  }
  /**
   * 这个对端改在 Device Link 上建链（outbound）或接受链路（inbound）了：之后链路代次看 Device Link 的。本机建链时，会话上那条
   * 「断了待恢复」「被本机关过」也作废，控制方向的状态改由 Device Link 报。不清的话（2026-11-17 review）会话断后重开落到 Device Link
   * 时，这个对端一直「待恢复」：每次调用和订阅都先再建一次链，接受后的补订阅又触发重建，循环不止；断开也发不到 Device Link 那条链路上。
   */
  noteDeviceLinkLink(deviceId: string, direction: 'outbound' | 'inbound'): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.linkOnSession = false;
    if (direction === 'outbound') { peer.outboundLost = false; peer.outboundClosed = false; this.notifyReopen(deviceId); }
  }

  /** 和这个对端的连接刚建好、会话还没到：还值得等多少毫秒（0 = 不等）。 */
  sessionPendingMs(deviceId: string): number {
    if (this.stopped || this.available(deviceId)) return 0;
    const connectedAt = this.options.connectedAt?.(deviceId);
    if (connectedAt == null) return 0;
    const rtt = this.options.rttMs?.(deviceId);
    const grace = rtt == null ? SESSION_GRACE_MAX_MS : Math.min(SESSION_GRACE_MAX_MS, SESSION_GRACE_MIN_MS + 4 * rtt);
    return Math.max(0, grace - (performance.now() - connectedAt));
  }

  /**
   * 选路前要等什么（null = 不用等，马上选）。跨账号：每次都先确认连上对方电脑（prepareSession）。同账号还没有会话时，不等的话第一条
   * 消息会在会话出现之前作为 Device Link 的帧发出去，这条链路之后一直不换路（2026-11-17 真机：本机刚启动 22 毫秒就向 Host 建链，
   * 连接 0.3 秒后才好；Host 重启时它先连上 Device Link 中转，0.7 秒后才上 Agent-Net，这段时间里重开的链路也成了 Device Link 的帧）：
   * - 连接刚建好、会话还在路上：等一小段（sessionPendingMs）。
   * - 还没有连接、对方此刻在 Agent-Net 上在线：先拨它，等会话（connectFirst）。
   * - 对方还不在 Agent-Net 上在线（例如正在重启、先连上了 Device Link 中转）：照旧交给 Device Link；它在中转上回答自己开着 Agent-Net、
   *   Device Link 改到主连接上重开时，由 openAttested 接到会话上。
   * 连着但过了宽限期仍没有会话的是旧版对端，本机关着 Agent-Net、对方不是 Agent-Net 设备的，都不等，和原来一样同步选路。
   */
  sessionWait(deviceId: string): Promise<void> | null {
    if (this.stopped || this.available(deviceId)) return null;
    // 跨账号：这个资源有能开会话的连接时才去连；Agent-Net 关着、没有那条连接时和原来一样同步选路。
    if (isScopedPeer(deviceId)) return this.options.agentNetPeer?.(deviceId) ? this.prepareSession(deviceId) : null;
    const pendingMs = this.sessionPendingMs(deviceId);
    if (pendingMs > 0) return this.awaitSession(deviceId, pendingMs);
    if (this.options.connectedAt?.(deviceId) != null) return null;
    return this.options.agentNetPeer?.(deviceId) === 'online' && this.options.connect ? this.connectFirst(deviceId) : null;
  }

  /**
   * Device Link 在中转上探测这个对端，对方签名回答自己开着 Agent-Net，于是要改到主连接上重开（RoutedDeviceLinkClient 的 openOnPrimary）：
   * 它正在上 Agent-Net，上了两端自己会连上。等它的会话最多 ATTESTED_SESSION_WAIT_MS，到了就在会话上开；没到再按原来在主连接上开（primary）。
   * 不接这一步时，重开的 link-open 在会话出现之前作为 Device Link 的帧排进连接，这条链路之后一直不换路（2026-11-17 真机：Host 重启时
   * 先连上中转，0.7 秒后才上 Agent-Net，控制端恰好在这段时间里重试建链）。关了 Agent-Net 的对端回答「没开」，不会走到这里。
   */
  async openAttested(dst: string, payload: unknown, timeoutMs: number | undefined,
    primary: () => Promise<LinkAcceptPayload>): Promise<LinkAcceptPayload> {
    if (this.stopped || isScopedPeer(dst)) return primary();
    const deadline = performance.now() + ATTESTED_SESSION_WAIT_MS;
    while (!this.stopped && !this.available(dst) && performance.now() < deadline) {
      // 连上了、过了宽限期仍没有会话：是没有会话层的 Agent-Net 旧版，不再等。
      if (this.options.connectedAt?.(dst) != null && this.sessionPendingMs(dst) === 0) break;
      await this.awaitSession(dst, Math.min(100, deadline - performance.now()));
    }
    if (!this.available(dst)) return primary();
    this.options.log.debug(`agent-net session took the attested re-open peer=${shortDeviceRef(dst)}`);
    return this.openLink(dst, payload, timeoutMs);
  }

  /**
   * 同账号、对方在线、还没连着：拨它但不等拨号结束，会话一到就放行，最多等 SESSION_GRACE_MAX_MS。到时拨号还没好，调用方走 Device Link，
   * 它的帧搭的是同一次拨号（同一对端的拨号只有一个），所以连不上的对端不比原来晚失败（2026-11-17 真机：先等拨号失败 3 秒再走 Device Link
   * 又拨 3 秒，共 6 秒）。拨不了（对方刚下线）立即放行；连上了却没有会话的旧版对端，只等连接后的那段宽限期。
   */
  private connectFirst(deviceId: string): Promise<void> {
    const wait = this.awaitSession(deviceId, SESSION_GRACE_MAX_MS);
    const release = () => this.sessionWaits.get(deviceId)?.release();
    void this.options.connect!(deviceId).then((connected) => {
      const pending = connected ? this.sessionPendingMs(deviceId) : 0;
      if (pending > 0) this.sessionWaits.get(deviceId)?.until(pending); else release();
    }, release);
    return wait;
  }

  /**
   * 还没连着对方电脑时：先连上（受邀者按需拨号，同账号对方此刻在线才拨），连上后会话还没到就再等一小段（sessionPendingMs）。
   * 连不上、对方不在线、对方是旧版（连上了但不宣告会话）都按时放行，由调用方照旧走 Device Link；拨号本来也是 Device Link 那条路要等的。
   */
  async prepareSession(deviceId: string): Promise<void> {
    if (this.stopped || this.available(deviceId) || !this.options.connect) return;
    let connected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      connected = await Promise.race([this.options.connect(deviceId),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CONNECT_WAIT_MS); timer.unref?.(); })]);
    } catch { return; } finally { clearTimeout(timer); }
    if (!connected || this.stopped || this.available(deviceId)) return;
    const wait = this.sessionPendingMs(deviceId);
    if (wait > 0) await this.awaitSession(deviceId, wait);
  }

  /** 等这个对端的会话就绪，最多 timeoutMs；不论等到没有都按时放行，由调用方再选路。 */
  awaitSession(deviceId: string, timeoutMs: number): Promise<void> {
    const existing = this.sessionWaits.get(deviceId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((done) => { resolve = done; });
    const wait = {
      promise,
      release: () => { clearTimeout(timer); if (this.sessionWaits.get(deviceId) === wait) this.sessionWaits.delete(deviceId); resolve(); },
      /** Round up so the timer cannot release just before the grace period ends. */
      until: (ms: number) => { clearTimeout(timer); timer = setTimeout(wait.release, Math.ceil(Math.max(0, ms))); },
    };
    wait.until(timeoutMs);
    this.sessionWaits.set(deviceId, wait);
    return promise;
  }

  /** 交给 socket.useSessions 的每个对端的处理者。 */
  handlers(deviceId: string): SessionHandlers {
    this.options.log.info(`agent-net session ready peer=${shortDeviceRef(deviceId)}`);
    // 处理者在会话登记到连接上之前取走；等登记完（这一轮同步代码之后）再放行等着的建链与调用。
    const waiting = this.sessionWaits.get(deviceId);
    if (waiting) queueMicrotask(waiting.release);
    // 控制链路断在上一条会话上：会话登记好以后请业务重开（reopenLink），不等下一次调用或在线状态变化。
    const lost = this.peers.get(deviceId);
    if (lost?.outboundLost && lost.outbound === 'idle' && this.options.reopenLink) {
      queueMicrotask(() => {
        const peer = this.peers.get(deviceId);
        if (this.stopped || !peer?.outboundLost || peer.outbound !== 'idle' || !this.live(deviceId)) return;
        try { this.options.reopenLink?.(deviceId); } catch (error) { this.options.log.error('session link reopen threw', error); }
      });
    }
    return {
      onOpen: (id, payload) => this.receiveOpen(deviceId, id, payload),
      onRequest: (request) => this.receiveRequest(deviceId, request),
      onPush: (channel, payload) => this.receivePush(deviceId, channel, payload),
      onClose: (reason) => this.receiveClose(deviceId, reason),
      onBroken: (code) => this.broken(deviceId, code),
    };
  }

  // ─── 控制端 ────────────────────────────────────────────────────────────────

  async openLink(dst: string, payload: unknown, timeoutMs?: number): Promise<LinkAcceptPayload> {
    // 和 Device Link 一样：对方的 presence 说关了远程控制，马上报 REMOTE_DISABLED，不发出去等超时（2026-11-17 审查）。
    if (this.remoteControlDisabled.has(dst)) throw new DeviceLinkError('REMOTE_DISABLED', 'remote control is disabled by the target');
    const session = this.requireSession(dst);
    const peer = this.peer(dst);
    peer.outboundClosed = false;
    peer.outbound = 'opening';
    const openStartedAt = performance.now();
    let refuse: (error: DeviceLinkError) => void = () => undefined;
    const refused = new Promise<never>((_resolve, reject) => { refuse = reject; });
    peer.refuseOpen = refuse;
    try {
      const accepted = await Promise.race([session.open(this.withLocalCapabilities(dst, payload), timeoutMs ?? this.requestTimeout()), refused]);
      if (this.live(dst) !== session || peer.outbound !== 'opening') {
        throw new DeviceLinkError('LINK_NOT_OPEN', 'session closed while opening the control link');
      }
      const accept = (isRecord(accepted) ? accepted : {}) as unknown as LinkAcceptPayload;
      peer.outbound = 'open';
      peer.outboundLost = false;
      peer.generation += 1;
      peer.linkOnSession = true;
      peer.githubRead = Array.isArray(accept.capabilities) && accept.capabilities.includes(DEVICE_LINK_CAPABILITY_GITHUB_READ_V1);
      const resume = accepted as { agentNetInvokeEpoch?: unknown; agentNetResumeOnly?: unknown } | null;
      const epoch = resume?.agentNetInvokeEpoch;
      peer.hostInvokeEpoch = resume?.agentNetResumeOnly === true && typeof epoch === 'string' && epoch.length <= 128 ? epoch : null;
      this.options.log.info(`agent-net session control link open peer=${shortDeviceRef(dst)} generation=${peer.generation}`);
      this.notifyReopen(dst);
      peer.receivedAt = performance.now();
      const streamId = this.streamIdFor(session);
      for (const cb of this.acceptedHandlers) {
        try { cb(dst, streamId); } catch (error) { this.options.log.error('peer stream accepted handler threw', error); }
      }
      return accept;
    } catch (error) {
      if (peer.outbound === 'opening') peer.outbound = 'idle';
      const failure = error instanceof DeviceLinkError ? error
        : error instanceof SessionError ? toDeviceLinkError(error.code, error.message) : null;
      this.options.log.debug(`agent-net session link open failed dst=${shortDeviceRef(dst)} code=${failure?.code ?? 'UNKNOWN'}`
        + ` elapsed=${Math.round(performance.now() - openStartedAt)}ms`);
      throw failure ?? error;
    } finally {
      if (peer.refuseOpen === refuse) peer.refuseOpen = null;
    }
  }

  closeLink(dst: string, reason: LinkCloseReason, direction: 'outbound' | 'inbound' = 'outbound'): void {
    const peer = this.peers.get(dst);
    if (!peer) return;
    if (direction === 'inbound') {
      peer.inbound = false;
      peer.offer = null;
      peer.requests.clear();
      if (reason !== 'transport-timeout') this.releaseInboundPeer(dst);
    } else {
      peer.outbound = 'idle';
      peer.outboundLost = false;
      peer.outboundClosed = true;
      // 和 Device Link 一样，排队还没发出的调用随关链取消；已发出的等各自的结果或超时。
      this.scheduler.cancel(dst, new DeviceLinkError('LINK_NOT_OPEN', `control link closed locally (${reason})`));
      this.notifyReopen(dst);
    }
    try { this.live(dst)?.close(reason); }
    catch (error) { this.options.log.debug('agent-net session link-close notification failed', error); }
  }

  async invoke(dst: string, payload: InvokePayload, timeoutMs?: number,
    options?: { preSend?: () => void; beforeDispatch?: () => void; noResultCache?: boolean; background?: boolean; diagnosticSource?: 'renderer' | 'main' | 'mobile' }): Promise<InvokeResultPayload> {
    if (this.remoteControlDisabled.has(dst)) throw new DeviceLinkError('REMOTE_DISABLED', 'remote control is disabled by the target');
    if (!this.live(dst)) throw new DeviceLinkError('LINK_NOT_OPEN', 'no Agent-Net session with the target');
    const queuedAt = performance.now();
    const priority = resolveInvokePriority(payload.channel, options?.background, payload.args);
    const slotBudgetMs = Math.min(timeoutMs ?? this.requestTimeout(), 30_000);
    const send = async (): Promise<InvokeResultPayload> => {
      options?.preSend?.();
      options?.beforeDispatch?.();
      const peer = this.peer(dst);
      if (payload.channel === 'git-context:github-read' && !peer.githubRead) {
        return { ok: false, error: { code: 'IPC_ERROR', message: 'GITHUB_READ_UNSUPPORTED: update the target computer to use GitHub queries' } };
      }
      const sentAt = performance.now();
      // 跨账号对端和 Device Link 一样不用历史页增量和结果缓存（对方也不按这两样编码给受邀者的结果）。
      const scoped = isScopedPeer(dst);
      const attempt = async (fullHistory: boolean, timeout: number | undefined): Promise<Attempt> => {
        const reuse = this.messageReuse.prepare(dst, payload);
        const delta = scoped ? null : this.historyViewDelta.prepare(dst, reuse.payload, fullHistory);
        const tagged = requestSessionTagCatalog(delta?.payload ?? reuse.payload);
        // 文件块（stream-read，和带块内容的 stream-rpc，即附件块写入）每块参数都不同：不进结果缓存、不算标记，免得把列表的缓存挤掉；
        // 一律走后台通道，不挡普通请求，也保证同一次上传的块按发出顺序到：只按大小分通道时，最后一块常常小到走普通通道，越过前面还在路上的
        // 大块先到，按顺序追加的接收端就拒收（2026-11-17 真机复验：文件夹下载时对方经会话推回的包报 FILE_PEER_BLOCK，改走了云端中转）。
        const fileBlock = isFilePeerStreamRead(tagged)
          || (isFilePeerStreamTransfer(tagged) && (tagged.args?.[0] as { body?: unknown } | undefined)?.body !== undefined);
        // noResultCache：和 Device Link 一样不缓存这条的结果（MCP App 的 open／poll）。
        const transfer = scoped || fileBlock ? null : this.invokeResultCache.prepare(dst, tagged, options?.noResultCache);
        // 远程任务的上传块也走后台通道：控制端一次有几块在途，停止等交互请求不该排在它们后面（2026-11-19 实测，慢线路上停止要等 5 秒多）。
        // 只改通道，排队仍按原优先级，和 Device Link 同一套名额。
        const backgroundLane = fileBlock || isRemoteAgentUploadChunk(tagged);
        // Pass the resolved policy too: an explicit false would otherwise undo
        // a channel's default background lane after admission used its cap.
        const raw = await this.request(dst, transfer?.payload ?? tagged, timeout, priority === 'background' || backgroundLane);
        const result = transfer ? await transfer.decode(raw) : raw;
        if (transfer?.retryWithoutBase()) return { result, retry: 'remaining-budget' };
        if (!result.ok) return { result };
        const restored = reuse.decode(decodeModelSpeedPayload(payload.channel, decodeSessionTagCatalog(payload.channel, result.result)));
        try {
          return { result: { ...result, result: delta ? delta.decode(restored) : restored } };
        } catch (error) {
          if (!isHistoryViewDeltaMiss(error)) throw error;
          this.options.log.debug(`agent-net session history delta miss dst=${dst.slice(0, 8)}: ${error.message}`);
          return { retry: 'full-timeout', error };
        }
      };
      let outcome = await attempt(false, timeoutMs);
      if (outcome.retry) {
        const remainingMs = slotBudgetMs - Math.round(performance.now() - sentAt);
        if (outcome.retry === 'full-timeout' || remainingMs >= 100) {
          options?.preSend?.();
          options?.beforeDispatch?.();
          outcome = await attempt(outcome.retry === 'full-timeout', outcome.retry === 'full-timeout' ? timeoutMs : remainingMs);
        }
      }
      if (!('result' in outcome)) throw outcome.error;
      return outcome.result;
    };
    return (bypassInvokeScheduling(payload) ? send() : this.scheduler.run(dst, priority, slotBudgetMs, send,
      { channel: payload.channel, request: `session-${Math.round(queuedAt)}`, source: options?.diagnosticSource ?? 'client' }));
  }

  isLinkReady(dst: string): boolean { return this.peers.get(dst)?.outbound === 'open' && !!this.live(dst); }
  needsLinkRecovery(dst: string): boolean { const peer = this.peers.get(dst); return !!peer && peer.outboundLost && peer.outbound !== 'open'; }
  hasPendingRequestsTo(dst: string): boolean { return (this.peers.get(dst)?.pendingInvokes ?? 0) > 0; }
  isOutboundExplicitlyClosed(dst: string): boolean { return this.peers.get(dst)?.outboundClosed === true; }
  getPeerLinkGeneration(dst: string): number { return this.peers.get(dst)?.generation ?? 0; }
  getReliableSendQueueDepth(dst: string): number { return Math.ceil((this.live(dst)?.bufferedAmount ?? 0) / QUEUE_DEPTH_UNIT_BYTES); }
  canSendPush(dst: string): boolean { return !!this.live(dst); }

  // ─── 被控端 ────────────────────────────────────────────────────────────────

  sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void {
    const session = this.requireSession(dst);
    const peer = this.peer(dst);
    const offer = peer.offer?.id === requestId ? peer.offer : null;
    const epoch = this.options.invokeEpoch?.(dst) ?? null;
    session.accept(requestId, epoch && offer?.resumeOnly ? { ...payload, agentNetInvokeEpoch: epoch, agentNetResumeOnly: true } : payload);
    peer.generation += 1;
    peer.linkOnSession = true;
    peer.inbound = true;
    peer.offer = null;
    // 推送压缩只认这次 link-open 的声明；对不上（被挤掉、id 不符）时当作不支持，发明文。跨账号和 Device Link 一样不压缩。
    const accepted = offer && !isScopedPeer(dst) && !this.pushDeflateRejected.has(dst) ? acceptedPushDeflateDictionaries(offer.capabilities) : [];
    peer.pushDictionary = accepted.length > 0 ? Math.max(...accepted) : undefined;
    peer.sentAt = performance.now();
  }

  sendInvokeResult(dst: string, requestId: string, payload: InvokeResultPayload): void {
    const session = this.requireSession(dst);
    const transfer = this.options.transferCodec ? this.inboundTransfer.get(dst, requestId) : undefined;
    if (transfer) payload = encodeInvokeResultTransfer(transfer, payload, this.options.transferCodec!, { src: dst, bases: this.deltaBases });
    if (roughBytes(payload) > MAX_MESSAGE_BYTES) throw new DeviceLinkError('PAYLOAD_TOO_LARGE', 'invoke result too large for an Agent-Net session message');
    if (session.bufferedAmount > SEND_BACKLOG_LIMIT_BYTES) throw new DeviceLinkError('BACKPRESSURE', 'Agent-Net session send backlog is full');
    // 会话层的结果一律包一层：外层只表示送达，业务的成功与失败原样在里面，不和会话层自己的失败码混在一起。
    session.respond(requestId, { ok: true, result: payload });
    const peer = this.peers.get(dst);
    peer?.requests.delete(requestId);
    if (peer) peer.sentAt = performance.now();
  }

  sendPush(dst: string, channel: string, payload: unknown, ownerStamp?: PushOwnerStamp): void {
    const session = this.live(dst);
    if (!session) return;
    let push: PushPayload = { channel, payload: encodeModelSpeedPayload(channel, payload), ...(ownerStamp ? { ownerStamp } : {}) };
    const peer = this.peers.get(dst);
    const codec = this.options.transferCodec;
    if (codec?.deflateRawBase64 && peer?.pushDictionary !== undefined) push = encodePushTransfer(push, codec, peer.pushDictionary);
    if (roughBytes(push) > MAX_MESSAGE_BYTES) throw new DeviceLinkError('PAYLOAD_TOO_LARGE', 'push too large for an Agent-Net session message');
    if (session.bufferedAmount > SEND_BACKLOG_LIMIT_BYTES) throw new DeviceLinkError('BACKPRESSURE', 'Agent-Net session send backlog is full');
    session.push(channel, push);
    if (peer) peer.sentAt = performance.now();
  }

  // ─── 事件与状态 ────────────────────────────────────────────────────────────

  onFrame(cb: FrameHandler): () => void { this.frameHandlers.add(cb); return () => this.frameHandlers.delete(cb); }
  onPeerRouteStateChanged(cb: (change: DeviceLinkPeerRouteStateChanged) => void): () => void { this.routeHandlers.add(cb); return () => this.routeHandlers.delete(cb); }
  onPeerStreamAccepted(cb: (peer: string, streamId: string) => void): () => void { this.acceptedHandlers.add(cb); return () => this.acceptedHandlers.delete(cb); }
  onInboundPeerReleased(cb: (peer: string) => void): () => void { this.releasedHandlers.add(cb); return () => this.releasedHandlers.delete(cb); }

  /** 和 Device Link 客户端一样，按在线快照记下「对端关了允许被控」，之后的调用立即报 REMOTE_DISABLED。 */
  notePresence(snapshot: PresenceSnapshot): void {
    if (snapshot.online !== true) return;
    if (snapshot.remoteControlEnabled === false) this.remoteControlDisabled.add(snapshot.deviceId);
    else this.remoteControlDisabled.delete(snapshot.deviceId);
  }
  noteRemoteControlDisabled(deviceId: string): void { this.remoteControlDisabled.add(deviceId); }
  noteRemoteControlEnabled(deviceId: string): void { this.remoteControlDisabled.delete(deviceId); }

  getPeerLinkSnapshots(): DeviceLinkPeerLinkSnapshot[] {
    const now = performance.now();
    const ago = (at: number | null) => (at === null ? null : Math.max(0, Math.round(now - at)));
    const out: DeviceLinkPeerLinkSnapshot[] = [];
    for (const [deviceId, peer] of this.peers) {
      if (peer.outbound === 'idle' && !peer.inbound) continue;
      const path = this.options.path?.(deviceId);
      out.push({ deviceId, path: path === 'direct' ? 'direct' : 'relay', rttMs: this.options.rttMs?.(deviceId) ?? null,
        open: this.isLinkReady(deviceId) || peer.inbound, sentAgoMs: ago(peer.sentAt), receivedAgoMs: ago(peer.receivedAt) });
    }
    return out;
  }

  /** 客户端重新启动（多实例仲裁接回持有权）：之后的建链可以再走会话。 */
  start(): void { this.stopped = false; }

  /** 停止或换账号：不再走会话，排队的调用失败，缓存按 Device Link 客户端的 stop 同样处理。 */
  stop(options?: { retainResultCache?: boolean }): void {
    this.stopped = true;
    for (const wait of [...this.sessionWaits.values()]) wait.release();
    this.scheduler.clear(new DeviceLinkError('NOT_CONNECTED', 'Agent-Net sessions stopped'));
    if (options?.retainResultCache) this.invokeResultCache.fence(); else this.invokeResultCache.clear();
    this.inboundTransfer.clear();
    this.deltaBases.clear();
    this.messageReuse.clear();
    this.historyViewDelta.clear();
    this.peers.clear();
    for (const dst of [...this.reopenWaiters.keys()]) this.notifyReopen(dst);
  }

  // ─── 入站 ──────────────────────────────────────────────────────────────────

  private receiveOpen(src: string, id: string, payload: unknown): void | Promise<void> {
    const peer = this.peer(src);
    const capabilities = isRecord(payload) && Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === 'string') : [];
    peer.offer = { id, capabilities, resumeOnly: isRecord(payload) && payload.agentNetResumeOnly === true };
    peer.receivedAt = performance.now();
    return this.emit({ v: PROTOCOL_VERSION, kind: 'link-open', id, src, dst: this.options.selfDeviceId() ?? undefined, payload } as Envelope);
  }

  private receiveRequest(src: string, request: SessionRequest): void | Promise<void> {
    const peer = this.peer(src);
    peer.requests.add(request.id);
    if (peer.requests.size > MAX_TRACKED_REQUESTS) peer.requests.delete(peer.requests.values().next().value!);
    peer.receivedAt = performance.now();
    const { agentNetResumeOnly: resumeOnly, ...extra } = request.extra ?? {};
    const payload: PeerInvokePayload = { ...extra, channel: request.channel, args: request.args };
    if (resumeOnly === true) payload[SESSION_INVOKE_REPLAY] = true;
    // 跨账号的结果和 Device Link 一样不按控制端的传输声明编码。
    if (!isScopedPeer(src)) this.inboundTransfer.record(src, request.id, payload);
    return this.emit({ v: PROTOCOL_VERSION, kind: 'invoke', id: request.id, src, dst: this.options.selfDeviceId() ?? undefined, payload } as Envelope);
  }

  private receivePush(src: string, channel: string, raw: unknown): void | Promise<void> {
    // 和 Device Link 一样：推送只在本机开着的控制链路上收，少数不需要链路的同账号请求与同步除外（isUnlinkedPushChannel）。
    // 2026-11-17 排查：会话上原来什么推送都收，同账号的一台电脑没建链也能往这台的业务里推任意通道。
    let push: PushPayload = isRecord(raw) && typeof raw.channel === 'string' ? raw as unknown as PushPayload : { channel, payload: raw };
    if (push.channel !== channel) return;
    const owner = this.peers.get(src)?.outbound;
    if (owner !== 'open' && owner !== 'opening' && !isSessionUnlinkedPushChannel(push.channel)) {
      this.options.log.debug(`agent-net session dropped a push without a control link src=${shortDeviceRef(src)}`);
      return;
    }
    if (isEncodedPushPayload(push)) {
      const decoded = decodePushTransfer(push, this.options.transferCodec);
      if (!decoded.ok) {
        // 和 Device Link 一样不能静默丢掉之后还接着收增量：之后建链不再声明推送压缩，这条丢弃并记下。
        this.pushDeflateRejected.add(src);
        this.options.log.warn(`agent-net session undecodable push src=${src.slice(0, 8)} reason=${decoded.reason}; push-deflate disabled for this peer`);
        return;
      }
      push = decoded.push;
    }
    const decoded = decodeModelSpeedPayload(push.channel, push.payload);
    if (decoded !== push.payload) push = { ...push, payload: decoded };
    this.messageReuse.receive(src, push.channel, decoded);
    this.historyViewDelta.receive(src, push.channel, decoded);
    const peer = this.peers.get(src);
    if (peer) peer.receivedAt = performance.now();
    return this.emit({ v: PROTOCOL_VERSION, kind: 'push', src, dst: this.options.selfDeviceId() ?? undefined, payload: push } as Envelope);
  }

  /** 对端关链：和 Device Link 收到 link-close 一样，两个方向都作废（帧里不分方向），帧照常交给业务。 */
  private receiveClose(src: string, reason: string): void | Promise<void> {
    const peer = this.peers.get(src);
    if (peer) {
      peer.offer = null;
      if (reason !== 'transport-timeout') {
        // 和 Device Link 收到 link-close 一样，本机还在等的建链马上失败：撤权报 ACCESS_REVOKED，其余报 LINK_NOT_OPEN
        // （2026-11-17 审查：会话上要等满超时，期间界面一直在连接中）。
        peer.refuseOpen?.(reason === 'revoked'
          ? new DeviceLinkError('ACCESS_REVOKED', 'access revoked by target device')
          : new DeviceLinkError('LINK_NOT_OPEN', 'control link closed by peer'));
        peer.refuseOpen = null;
        peer.outbound = 'idle';
        peer.outboundLost = false;
        peer.inbound = false;
        peer.requests.clear();
        this.notifyReopen(src);
      } else if (peer.outbound === 'open') {
        peer.outbound = 'idle';
        peer.outboundLost = true;
      }
    }
    return this.emit({ v: PROTOCOL_VERSION, kind: 'link-close', src, dst: this.options.selfDeviceId() ?? undefined, payload: { reason } } as Envelope);
  }

  /** 会话没了（连接断、对端重建节点、授权变了）：在途调用已由会话层判失败；两个方向都离线，按 Device Link 的离线事件通知。 */
  private broken(src: string, code: string): void {
    try { this.options.onSessionClosed?.(src); }
    catch (error) { this.options.log.error('session closed handler threw', error); }
    const peer = this.peers.get(src);
    if (!peer) return;
    const hadLink = peer.outbound !== 'idle' || peer.inbound;
    this.options.log.info(`agent-net session closed peer=${shortDeviceRef(src)} code=${code} hadLink=${hadLink}`);
    if (peer.outbound !== 'idle') peer.outboundLost = !peer.outboundClosed;
    peer.outbound = 'idle';
    peer.inbound = false;
    peer.offer = null;
    peer.requests.clear();
    // 跨账号：分享连接是用到时才拨的，会话不会自己回来。有请求在等续传（request）时马上请业务重开（重开循环会先连上对方电脑）。
    if (isScopedPeer(src) && peer.outboundLost && peer.pendingInvokes > 0 && this.options.reopenLink && !this.stopped) {
      queueMicrotask(() => {
        if (this.stopped || !this.peers.get(src)?.outboundLost || this.peers.get(src)?.outbound !== 'idle') return;
        try { this.options.reopenLink?.(src); } catch (error) { this.options.log.error('session link reopen threw', error); }
      });
    }
    this.scheduler.cancel(src, new DeviceLinkError('DEVICE_OFFLINE', `Agent-Net session ${code}`));
    if (!hadLink || this.stopped) return;
    const change: DeviceLinkPeerRouteStateChanged = { deviceId: src, state: 'offline', connectionEpoch: this.options.connectionEpoch(src), linkGeneration: peer.generation };
    for (const cb of this.routeHandlers) {
      try { cb(change); } catch (error) { this.options.log.error('peer route state handler threw', error); }
    }
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  /**
   * 一次请求。写出去以后会话断了（连接断、换网、对方重建节点）：和 Device Link 断线重连后按原序号续传一样，等这个对端的控制链路
   * 在新会话上重开（reopenLink 请业务重开），用原请求号再发一次。对方按请求号去重（Desktop dispatch 记着的结果、或还在跑的那次），
   * 只找回已记住的结果；等不到重开或结果无法确认时报告「可能已执行」，不再启动该写操作。
   * 幂等读照旧报 PEER_RESET 让业务重读；文件块不在这里续（文件直传随会话收掉）。跨账号同样续：分享连接不会自己回来，会话断时就请业务重开
   * （broken）。
   */
  private async request(dst: string, payload: InvokePayload, timeoutMs: number | undefined, background?: boolean): Promise<InvokeResultPayload> {
    let session = this.live(dst);
    if (!session) throw new DeviceLinkError('LINK_NOT_OPEN', 'no Agent-Net session with the target');
    const peer = this.peer(dst);
    const { channel, args, ...extra } = payload;
    const deadline = performance.now() + (timeoutMs ?? this.requestTimeout());
    // 只在对方说了它的去重记忆是哪一份时才续：重开后那份没变（没重启、没清空）才再发，免得它已经忘了这次请求、再执行一遍。
    const hostEpoch = peer.hostInvokeEpoch;
    const continuable = hostEpoch !== null && !isPeerResetRetryableInvoke(channel, args) && !isFilePeerStreamTransfer({ channel, args });
    const id = newSessionRequestId();
    const lane = agentNetRequestLane(channel, args);
    peer.pendingInvokes += 1;
    peer.sentAt = performance.now();
    const startedAt = peer.sentAt;
    let attempts = 0;
    let outcome: SessionResult = { ok: false, error: { code: 'NOT_SENT', message: 'not sent' } };
    try {
      for (let attempt = 0; ; attempt++) {
        attempts = attempt + 1;
        const generation = peer.generation;
        outcome = await session.request(channel, args ?? [], { id, timeoutMs: Math.max(1, Math.round(deadline - performance.now())), background,
          // 幂等读不排在之前因为太大改走后台通道的请求后面；写照原来的先后（lanes.ts）。
          unordered: isPeerResetRetryableInvoke(channel, args),
          ...(lane ? { lane } : {}), ...(attempt > 0 ? { extra: { ...extra, agentNetResumeOnly: true } }
            : Object.keys(extra).length ? { extra } : {}) });
        if (attempt > 0 && outcome.ok) {
          const result = outcome.result as InvokeResultPayload;
          if (result?.ok === false && result.error?.code === 'INVOKE_TIMEOUT') {
            outcome = { ok: false, error: { code: 'INVOKE_TIMEOUT', message: result.error.message } };
          }
        }
        if (outcome.ok || outcome.error.code !== 'DEVICE_OFFLINE' || !continuable) break;
        const next = await this.awaitReopened(dst, generation, deadline);
        if (!next) break;
        if (peer.hostInvokeEpoch !== hostEpoch) {
          this.options.log.info(`agent-net session request not sent again: the peer no longer remembers it peer=${shortDeviceRef(dst)}`);
          break;
        }
        session = next;
        this.options.log.info(`agent-net session request sent again on the re-opened link peer=${shortDeviceRef(dst)} attempt=${attempt + 2}`);
      }
    } finally {
      peer.pendingInvokes = Math.max(0, peer.pendingInvokes - 1);
      this.logRequest(dst, channel, args, lane, startedAt, outcome, attempts);
    }
    if (!outcome.ok) {
      const code = outcome.error.code;
      // 没写出去（NOT_SENT）可以放心重开再发；写出去以后丢了，只有幂等读和 Device Link 一样报 PEER_RESET 让业务重读一次。
      const error = code === 'DEVICE_OFFLINE' && isPeerResetRetryableInvoke(channel, args)
        ? new DeviceLinkError('PEER_RESET', `Agent-Net session lost: ${outcome.error.message}`)
        : toDeviceLinkError(code, outcome.error.message);
      if (code !== 'NOT_SENT') error.inFlight = true;
      throw error;
    }
    peer.receivedAt = performance.now();
    return outcome.result as InvokeResultPayload;
  }

  /**
   * 会话上的请求日志，和 Device Link 的一样（client.ts 的 logFinished，2026-11-17：会话上原来没有，卡住时无从查起）：超时记 warn，
   * 失败与慢请求记 debug。只写通道名（不在远程调用名单里的写 unknown）、缩短的设备号、通道、次数与耗时，不写参数和结果。
   */
  private logRequest(dst: string, channel: string, args: unknown[] | undefined, lane: SessionLane | undefined, startedAt: number,
    outcome: SessionResult, attempts: number): void {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const description = `channel=${diagnosticChannel(channel)} dst=${shortDeviceRef(dst)} lane=${lane ?? 'auto'} attempts=${attempts}`;
    if (!outcome.ok) {
      const code = outcome.error.code;
      if (code === 'INVOKE_TIMEOUT') { this.options.log.warn(`agent-net session request timeout ${description} elapsed=${elapsedMs}ms`); return; }
      if (code !== 'NOT_SENT' || elapsedMs >= SLOW_REQUEST_LOG_MS) {
        this.options.log.debug(`agent-net session request failed ${description} code=${code} elapsed=${elapsedMs}ms`);
      }
      return;
    }
    if (elapsedMs >= SLOW_REQUEST_LOG_MS + invokeIntendedHoldMs(channel, args)) {
      this.options.log.debug(`agent-net session request slow ${description} elapsed=${elapsedMs}ms`);
    }
  }

  /**
   * 等这个对端的控制链路在新会话上重开（代次比 generation 大）并给出那条会话；本机关了链路、改在 Device Link 上开了、停了或到了
   * deadline 给 null。
   */
  private awaitReopened(dst: string, generation: number, deadline: number): Promise<SessionHandle | null> {
    return new Promise((resolve) => {
      const waiters = this.reopenWaiters.get(dst) ?? new Set<() => void>();
      this.reopenWaiters.set(dst, waiters);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: SessionHandle | null) => {
        waiters.delete(check);
        if (waiters.size === 0 && this.reopenWaiters.get(dst) === waiters) this.reopenWaiters.delete(dst);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        const peer = this.peers.get(dst), live = this.live(dst);
        if (this.stopped || !peer || peer.outboundClosed) { finish(null); return; }
        if (peer.outbound === 'open' && peer.generation > generation && live) { finish(live); return; }
        // 没在等恢复了：改在 Device Link 上建了链，或链路状态已清（对方关链）。
        if (peer.outbound === 'idle' && !peer.outboundLost) finish(null);
      };
      waiters.add(check);
      const remaining = deadline - performance.now();
      if (remaining <= 0) { finish(null); return; }
      timer = setTimeout(() => finish(null), remaining);
      check();
    });
  }

  private notifyReopen(dst: string): void {
    for (const check of [...(this.reopenWaiters.get(dst) ?? [])]) check();
  }

  private emit(env: Envelope): void | Promise<void> {
    let chain: Promise<void> | null = null;
    for (const cb of this.frameHandlers) {
      const run = (): void | Promise<void> => {
        try {
          const result = cb(env);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            return Promise.resolve(result).then(() => undefined, (error) => { this.options.log.error('frame handler threw', error); });
          }
        } catch (error) { this.options.log.error('frame handler threw', error); }
      };
      if (chain) chain = chain.then(run);
      else { const value = run(); if (value) chain = value; }
    }
    return chain ?? undefined;
  }

  private withLocalCapabilities(dst: string, payload: unknown): unknown {
    if (!isRecord(payload) || (!('controllerName' in payload) && !('protocolVersion' in payload))) return payload;
    const deflate = this.options.transferCodec?.inflateRawBase64 && !isScopedPeer(dst) && !this.pushDeflateRejected.has(dst) ? pushDeflateCapabilities() : [];
    return { ...payload, agentNetResumeOnly: true, capabilities: mergeCapabilities(payload.capabilities, deflate) };
  }

  private releaseInboundPeer(dst: string): void {
    this.deltaBases.forgetPeer(dst);
    for (const cb of this.releasedHandlers) {
      try { cb(dst); } catch (error) { this.options.log.error('inbound peer release handler threw', error); }
    }
  }

  private requireSession(dst: string): SessionHandle {
    const session = this.stopped ? null : this.live(dst);
    if (!session) throw new DeviceLinkError('LINK_NOT_OPEN', 'no Agent-Net session with the target');
    return session;
  }

  /**
   * 交给 onPeerStreamAccepted 的流标识：每个会话一个，会话换了（对端重启、连接换了）就变，同一会话里重开链路不变，和 Device Link
   * 对端的传输流一样。共享任务据此推进来源代次（index.ts sharedHostStreams）；原来固定一个值时，主人电脑重启后的新推送会被界面当成旧的丢掉。
   */
  private streamIdFor(session: SessionHandle): string {
    let id = this.streamIds.get(session);
    if (!id) { id = `agent-net-session-${++this.streamCounter}`; this.streamIds.set(session, id); }
    return id;
  }

  /** 还能用的会话：连接上有、也没有被关掉（关掉的会话对象可能还被别处拿着）。 */
  private live(deviceId: string): SessionHandle | null {
    const session = this.options.session(deviceId);
    return session && session.closedReason === null ? session : null;
  }

  private requestTimeout(): number { return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS; }

  private peer(deviceId: string): PeerState {
    let peer = this.peers.get(deviceId);
    if (!peer) {
      peer = { generation: 0, outbound: 'idle', outboundLost: false, outboundClosed: false, inbound: false, offer: null,
        pushDictionary: undefined, githubRead: false, pendingInvokes: 0, requests: new Set(), sentAt: null, receivedAt: null, linkOnSession: false, refuseOpen: null, hostInvokeEpoch: null };
      this.peers.set(deviceId, peer);
    }
    return peer;
  }
}
