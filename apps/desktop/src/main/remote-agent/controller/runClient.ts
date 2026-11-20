/**
 * 远程 Agent 任务的协议客户端(控制端：任务、文件与命令所在的电脑)。
 *
 * 一个任务一份：发 open 后登记到这台电脑的共享拉取器(RemoteAgentPoller)，把事件流的行分发给
 * 调用方(Agent 事件、状态镜像、方法结果、反向请求、WebSocket 帧)；反向请求处理完用 reply 回包。
 * 大载荷先分段上传再引用。
 *
 * 链路抖动由拉取器处理(poll 按游标幂等)；reply / push 链路失败时按同一 id / 序号重试(对方按
 * id 去重，歧义交付不会重复投递)；open / call 不自动重放，结果不明时由调用方决定。对方长时间
 * 不可达时拉取器结束任务并报告原因。
 */
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import {
  REMOTE_AGENT_CHANNEL,
  REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS,
  REMOTE_AGENT_MAX_PAYLOAD_BYTES,
  REMOTE_AGENT_MAX_UPLOAD_CHUNKS,
  REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
  parseRemoteAgentCaps,
  parseRemoteAgentStreamItem,
  shortDeviceRef,
  type RemoteAgentCaps,
  type RemoteAgentErrorInfo,
  type RemoteAgentKind,
  type RemoteAgentMethod,
  type RemoteAgentPayload,
  type RemoteAgentPushFrame,
  type RemoteAgentReply,
  type RemoteAgentReverseRequest,
  type RemoteAgentStreamItem,
  type RemoteAgentTeardownReason,
} from '@cindy/device-link';

import { LineSplitter } from '../eventLog';
import { remoteAgentStartupTiming } from '../startupTiming';
import { isRetryableLinkError, RemoteAgentPoller, type PolledRun, type RemoteAgentInvoke } from './poller';
import { isDeliveryBackpressure, RemoteAgentDeliveryGate } from './deliveryPressure';

export { isRetryableLinkError, RemoteAgentPoller, type RemoteAgentInvoke } from './poller';

const gzipAsync = promisify(gzip);

// These are sender preferences, not protocol limits. A 512 KiB upload becomes
// roughly 683 KiB on the wire and can exceed the 30s invoke deadline on relay.
// Keep ordinary uploads within one transport fragment, and compress large
// inline values too; character counts alone understate UTF-8 delivery cost.
const INLINE_PAYLOAD_BYTES = 64 * 1024;
const PREFERRED_UPLOAD_CHUNK_BYTES = 64 * 1024;
/**
 * 一台被控端上所有任务的上传块合起来最多同时在途这么多：不超过 Device Link 每台对端的后台名额（4 个），
 * 给拉取、读取和交互请求留出调度名额；几个任务同时启动也只共用这几个。
 * 2026-11-18：启动资料 26 块逐块等回执，回程变慢后每块约 1.6 秒，启动等了 41 秒。被控端从第一版起就按
 * (uploadId, index) 存块、重复的块忽略，块之间不依赖先后，所以可以同时在途，旧版被控端照样收。
 */
const UPLOAD_SLOTS_PER_PEER = 4;
/** 一份载荷开始时同时在途的块数；回执快就加一，慢就减半，最少一块。 */
const UPLOAD_WINDOW_START = 2;
/**
 * 一块从发出到回执超过这么久就把窗口减半：同时在途的块分着同一条线路，后面的块要等前面的，
 * 慢线路上不能让排在后面的块拖过 30 秒的请求时限。
 */
const UPLOAD_SLOW_CHUNK_MS = 10_000;
/** 一块遇到链路类错误时按同一块号重发的次数（被控端按块号去重，重发不会多存）。 */
const UPLOAD_CHUNK_RETRIES = 2;
const UPLOAD_RETRY_BASE_MS = 500;

/** 每台被控端（共用一个拉取器）的上传名额。 */
class UploadSlots {
  private used = 0;
  private readonly waiting: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.used < UPLOAD_SLOTS_PER_PEER) {
      this.used += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  /** 名额直接交给排着的下一个；没人排时才收回。 */
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.used -= 1;
  }
}
const uploadSlots = new WeakMap<RemoteAgentPoller, UploadSlots>();

/** 单行事件上限(大工具结果)。 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** 结束时等对方收尾事件到达的最长时间。 */
const CLOSE_DRAIN_MS = 5_000;
/** 回包交付重试上限(链路抖动时对方一直在等同一 requestId 的回包)。 */
const MAX_REPLY_DELIVER_ATTEMPTS = 30;
/** push 帧批次交付重试上限(对方按 seq 去重，同序号重试不会重复投递)。 */
const MAX_PUSH_DELIVER_ATTEMPTS = 30;
/** Pollers are already shared per executor/transport; never coordinate unrelated peers. */
const deliveryGates = new WeakMap<RemoteAgentPoller, RemoteAgentDeliveryGate>();

export class RemoteAgentRemoteError extends Error {
  constructor(readonly info: RemoteAgentErrorInfo, readonly phase?: 'start') {
    super(info.message || info.code);
    this.name = info.name ?? 'RemoteAgentRemoteError';
  }
}

export interface RemoteAgentRunHandlers {
  onEvent(event: unknown): void;
  onState(state: Record<string, unknown>): void;
  onRequest(request: RemoteAgentReverseRequest, signal: AbortSignal): Promise<RemoteAgentReply>;
  onWs(item: Extract<RemoteAgentStreamItem, { t: 'ws' }>): void;
  /** idleReclaimed：对方按主人设置的时长收回了这个闲置任务(事件流 `closed` 带 idleReclaimed)。 */
  onClosed(reason: string, error?: RemoteAgentErrorInfo, idleReclaimed?: boolean): void;
  /** 本机还有这个任务的工作在进行、对方看不到(拉取时报 hold，对方不按闲置收回)。 */
  holdsRemote?(): boolean;
  recoverAuthorization?(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RemoteAgentRunClient implements PolledRun {
  private closed = false;
  private registered = false;
  private readonly drained: Promise<void>;
  private markDrained!: () => void;
  private pushSeq = 0;
  /** Stop invalidates unsent calls, including those waiting for link admission. */
  private sendGeneration = 0;
  /** 在途的 push 批次(含重试中的)。 */
  private pushing = 0;
  /** 正在回答的反向请求(从收到到回包交付完)。 */
  private answering = 0;
  private readonly pendingCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private started: { resolve(handle: Record<string, unknown>): void; reject(error: Error): void } | null = null;
  private readonly splitter = new LineSplitter(MAX_LINE_BYTES);
  private readonly inflight = new Map<string, AbortController>();
  private readonly deliveryAbort = new AbortController();
  private readonly deliveryGate: RemoteAgentDeliveryGate;

  private readonly invoke: RemoteAgentInvoke;

  constructor(
    readonly runId: string,
    private readonly poller: RemoteAgentPoller,
    private readonly handlers: RemoteAgentRunHandlers,
    private readonly newId: () => string,
    private readonly log?: {
      debug?(message: string, meta?: Record<string, unknown>): void;
      warn(message: string, meta?: Record<string, unknown>): void;
    },
  ) {
    this.invoke = poller.invoke;
    let gate = deliveryGates.get(poller);
    if (!gate) { gate = new RemoteAgentDeliveryGate(); deliveryGates.set(poller, gate); }
    this.deliveryGate = gate;
    this.drained = new Promise<void>((resolve) => {
      this.markDrained = resolve;
    });
  }

  async recoverAuthorization(): Promise<void> {
    if (!this.closed) await this.handlers.recoverAuthorization?.();
  }

  static async caps(invoke: RemoteAgentInvoke): Promise<RemoteAgentCaps> {
    return parseRemoteAgentCaps(await invoke([{ op: 'caps' }]));
  }

  /** 把一个 JSON 值做成载荷：小的内联，大的 gzip 后分段上传。 */
  async payload(value: unknown, uploadId = this.newId(), requireActive?: () => void,
    invoke: RemoteAgentInvoke = this.invoke): Promise<RemoteAgentPayload> {
    const requireOpen = () => {
      if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      requireActive?.();
    };
    requireOpen();
    const text = JSON.stringify(value ?? null);
    if (text.length <= REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS && Buffer.byteLength(text, 'utf8') <= INLINE_PAYLOAD_BYTES) {
      return { json: JSON.parse(text) as unknown };
    }
    const gz = await gzipAsync(Buffer.from(text, 'utf8'));
    requireOpen();
    if (gz.length > REMOTE_AGENT_MAX_PAYLOAD_BYTES) throw new Error('The request is too large to send to the other computer.');
    // Older receivers accept at most MAX_UPLOAD_CHUNKS. Grow the slice only
    // when necessary to retain the full existing payload capacity.
    const chunkBytes = Math.min(REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
      Math.max(PREFERRED_UPLOAD_CHUNK_BYTES, Math.ceil(gz.length / REMOTE_AGENT_MAX_UPLOAD_CHUNKS)));
    const chunks = Math.max(1, Math.ceil(gz.length / chunkBytes));
    await this.uploadChunks(chunks, (index) => gz.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64'),
      uploadId, requireOpen, invoke);
    // An in-flight chunk can finish after cancellation, but no next chunk or open may start.
    requireOpen();
    return { uploadId, chunks, bytes: gz.length };
  }

  /**
   * 几块同时在途地上传，全部收到回执才返回（之后才发引用它的 open / call / reply，不依赖链路保序）。
   * 窗口见 UPLOAD_WINDOW_START / UPLOAD_SLOW_CHUNK_MS，同一台被控端共用 UPLOAD_SLOTS_PER_PEER 个名额。
   * 一块失败、被取消或任务结束后不再发新块，等已在途的块结束后抛出第一个错误。
   */
  private async uploadChunks(chunks: number, chunk: (index: number) => string, uploadId: string,
    requireOpen: () => void, invoke: RemoteAgentInvoke): Promise<void> {
    let slots = uploadSlots.get(this.poller);
    if (!slots) { slots = new UploadSlots(); uploadSlots.set(this.poller, slots); }
    let window = Math.min(UPLOAD_WINDOW_START, chunks);
    let failure: { error: unknown } | null = null;
    const running = new Set<Promise<void>>();
    const send = async (index: number): Promise<void> => {
      const data = chunk(index);
      for (let attempt = 0; ; attempt += 1) {
        const startedAt = performance.now();
        try {
          await invoke([{ op: 'upload', uploadId, index, data }]);
          window = performance.now() - startedAt > UPLOAD_SLOW_CHUNK_MS
            ? Math.max(1, Math.floor(window / 2))
            : Math.min(UPLOAD_SLOTS_PER_PEER, window + 1);
          return;
        } catch (error) {
          if (attempt >= UPLOAD_CHUNK_RETRIES || failure || this.closed || !isRetryableLinkError(error)) throw error;
          window = 1;
          await sleep(UPLOAD_RETRY_BASE_MS * 2 ** attempt);
          if (failure) throw error;
          requireOpen();
        }
      }
    };
    try {
      for (let index = 0; index < chunks && !failure; index += 1) {
        while (running.size >= window && !failure) await Promise.race(running);
        if (failure) break;
        requireOpen();
        await slots.acquire();
        if (failure) { slots.release(); break; }
        try { requireOpen(); } catch (error) { slots.release(); throw error; }
        const task = send(index)
          .catch((error) => { failure ??= { error }; })
          .finally(() => { slots!.release(); running.delete(task); });
        running.add(task);
      }
    } finally {
      await Promise.allSettled(running);
    }
    if (failure) throw (failure as { error: unknown }).error;
  }

  /**
   * 打开任务：等对方启动 Agent 成功(返回会话描述)或失败(抛出对方的错误)。已关闭的连接不能再打开：本机这边的
   * 任务已经结束(撤权、用户关闭)，再打开会在对方留下一个没人拉取、没人关闭的任务。
   */
  async open(agentKind: RemoteAgentKind, openPayload: unknown, requireActive?: () => void,
    onOpenRequest?: () => void): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
    requireActive?.();
    const sessionId =
      openPayload &&
      typeof openPayload === 'object' &&
      'sessionId' in openPayload &&
      typeof openPayload.sessionId === 'string'
        ? openPayload.sessionId
        : undefined;
    const timing = remoteAgentStartupTiming(this.log, {
      side: 'transport',
      kind: agentKind,
      sessionId,
      runId: this.runId,
    });
    let status: 'ok' | 'failed' = 'failed';
    try {
      const payload = await timing.measure('payload-upload', () => this.payload(openPayload, this.newId(), requireActive));
      if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      requireActive?.();
      const started = new Promise<Record<string, unknown>>((resolve, reject) => {
        this.started = { resolve, reject };
      });
      try {
        await timing.measure('open-request', () => {
          onOpenRequest?.();
          return this.invoke([{ op: 'open', runId: this.runId, agentKind, payload }]);
        });
      } catch (error) {
        this.started = null;
        throw error;
      }
      if (this.closed) {
        // 打开途中本机关掉了这个任务：对方可能先收到关闭(那时还没有这个任务)再收到打开，补发一次关闭。
        void started.catch(() => undefined);
        void this.invoke([{ op: 'close', runId: this.runId, mode: 'close', reason: 'navigation' }]).catch(() => undefined);
        throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      }
      this.registered = true;
      this.poller.register(this);
      const result = await timing.measure('session-ready', () => started);
      status = 'ok';
      return result;
    } finally {
      timing.finish(status);
    }
  }

  /** 调用对方会话的一个方法，等结果。 */
  call(method: RemoteAgentMethod, args: unknown[]): Promise<unknown> {
    return this.callWithId(this.newId(), method, args);
  }

  /** 预先分配的 callId(需要先把回调登记到 callId 上时用)。 */
  async callWithId(callId: string, method: RemoteAgentMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on the other computer.');
    if (method === 'abort' || method === 'requestGracefulStop') this.sendGeneration += 1;
    const generation = this.sendGeneration;
    const requireActive = () => {
      if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
      if (signal?.aborted || ((method === 'send' || method === 'steer') && generation !== this.sendGeneration)) {
        throw new DOMException('The message was cancelled before delivery to the other computer.', 'AbortError');
      }
    };
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject });
    });
    // finish() can reject this while payload preparation is still awaiting.
    // Observe it now; the public call still returns the original result below.
    void result.catch(() => undefined);
    try {
      const payload = await this.payload(args, this.newId(), requireActive);
      // Stop can overtake gzip or a chunk acknowledgement, including the final
      // await before dispatch. Never deliver that old send after Stop.
      requireActive();
      await this.invoke([{ op: 'call', runId: this.runId, callId, method, payload }], { beforeDispatch: requireActive });
    } catch (error) {
      this.pendingCalls.delete(callId);
      throw error;
    }
    return result;
  }

  /**
   * 推帧：对方按 seq 去重，所以链路抖动时用同一个 seq 重试——歧义交付(对方已收到但回包
   * 丢失)重发不会重复投递，帧序列也不会缺批。重试耗尽才抛给调用方决定后续处置。
   */
  async push(frames: RemoteAgentPushFrame[]): Promise<void> {
    if (this.closed || frames.length === 0) return;
    this.pushSeq += 1;
    const seq = this.pushSeq;
    let delay = 500;
    this.pushing += 1;
    try {
      for (let attempt = 1; ; attempt += 1) {
        if (this.closed) return;
        try {
          await this.deliveryGate.invoke(() => this.invoke([{ op: 'push', runId: this.runId, seq, frames,
            ...(this.holdsRemote() ? { hold: true } : {}) }]), this.deliveryAbort.signal);
          return;
        } catch (error) {
          if (this.closed) return;
          const retryable = isRetryableLinkError(error) && attempt < MAX_PUSH_DELIVER_ATTEMPTS;
          this.log?.warn(retryable ? 'remote agent: push failed; retrying' : 'remote agent: push failed', {
            runId: this.runId,
            seq,
            attempt,
            error: String(error),
          });
          if (!retryable) throw error;
          // Peer pressure owns one shared probe timer; per-run timers would
          // put the entire failed batch back into the send queue together.
          if (!isDeliveryBackpressure(error)) await sleep(delay);
          delay = Math.min(delay * 2, 5_000);
        }
      }
    } finally {
      this.pushing -= 1;
    }
  }

  async close(mode: 'close' | 'detach', reason: RemoteAgentTeardownReason): Promise<void> {
    if (this.closed) return;
    let delivered = false;
    try {
      await this.invoke([{ op: 'close', runId: this.runId, mode, reason }]);
      delivered = true;
    } finally {
      // 收尾事件仍会经 poll 到达；流结束时自行收口。close 没送到时对方不会收尾，不用等。
      if (this.registered && delivered) await Promise.race([this.drained, sleep(CLOSE_DRAIN_MS)]);
      this.finish('closed');
    }
  }

  /** 不再读取(本机任务已丢弃这个连接)。 */
  abandon(reason: string): void {
    this.finish(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  holdsRemote(): boolean {
    return !this.closed && this.handlers.holdsRemote?.() === true;
  }

  /** 还有没收尾的往来：在等的方法结果、正在回答的反向请求(权限确认、执行器 / MCP 请求等)或在推的帧。 */
  get hasPendingWork(): boolean {
    return this.pendingCalls.size > 0 || this.answering > 0 || this.pushing > 0 || this.started !== null;
  }

  private finish(reason: string, error?: RemoteAgentErrorInfo, idleReclaimed = false): void {
    if (this.closed) return;
    this.closed = true;
    this.deliveryAbort.abort();
    this.poller.unregister(this.runId);
    this.markDrained();
    const failure = new Error(error?.message ?? `[REMOTE_AGENT_EXPIRED] The task ended on the other computer (${reason}).`);
    this.started?.reject(error ? new RemoteAgentRemoteError(error) : failure);
    this.started = null;
    for (const abort of this.inflight.values()) abort.abort();
    this.inflight.clear();
    for (const pending of this.pendingCalls.values()) pending.reject(failure);
    this.pendingCalls.clear();
    this.handlers.onClosed(reason, error, idleReclaimed);
  }

  /** 拉取器交付的新数据(已去重，从上次的游标开始)。 */
  onData(data: Buffer, done: boolean): void {
    if (this.closed) return;
    if (data.length) {
      let lines: string[];
      try {
        lines = this.splitter.push(data);
      } catch {
        this.finish('invalid-stream', { code: 'REMOTE_AGENT_INVALID', message: 'The other computer sent an invalid event stream.' });
        return;
      }
      for (const line of lines) {
        if (!line) continue;
        let item: RemoteAgentStreamItem | null;
        try {
          item = parseRemoteAgentStreamItem(line);
        } catch {
          this.log?.warn('remote agent: dropped invalid stream item', { runId: this.runId });
          continue;
        }
        if (item) this.dispatch(item);
        if (this.closed) return;
      }
    }
    if (done) this.finish('ended');
  }

  onLost(reason: string, error: RemoteAgentErrorInfo): void {
    this.finish(reason, error);
  }

  private dispatch(item: RemoteAgentStreamItem): void {
    switch (item.t) {
      case 'started':
        this.started?.resolve(item.handle);
        this.started = null;
        return;
      case 'start-failed':
        this.started?.reject(new RemoteAgentRemoteError(item.error, 'start'));
        this.started = null;
        return;
      case 'event':
        this.handlers.onEvent(item.event);
        return;
      case 'state':
        this.handlers.onState(item.state);
        return;
      case 'result': {
        const pending = this.pendingCalls.get(item.callId);
        if (!pending) return;
        this.pendingCalls.delete(item.callId);
        if (item.ok) pending.resolve(item.value);
        else pending.reject(new RemoteAgentRemoteError(item.error));
        return;
      }
      case 'request':
        void this.answer(item.requestId, item.request);
        return;
      case 'cancel':
        this.inflight.get(item.requestId)?.abort();
        this.inflight.delete(item.requestId);
        return;
      case 'ws':
        this.handlers.onWs(item);
        return;
      case 'closed':
        this.finish(item.reason, item.error, item.idleReclaimed === true);
        return;
    }
  }

  private async answer(requestId: string, request: RemoteAgentReverseRequest): Promise<void> {
    const abort = new AbortController();
    this.inflight.set(requestId, abort);
    this.answering += 1;
    try {
      let reply: RemoteAgentReply;
      try {
        reply = await this.handlers.onRequest(request, abort.signal);
      } catch (error) {
        reply = { type: 'error', error: { code: 'CONTROLLER_ERROR', message: error instanceof Error ? error.message : String(error) } };
      }
      if (this.closed || abort.signal.aborted) return;
      await this.deliverReply(requestId, reply, abort.signal);
    } finally {
      if (this.inflight.get(requestId) === abort) this.inflight.delete(requestId);
      this.answering -= 1;
    }
  }

  /**
   * 回包交付：链路抖动导致发送失败时按退避重试。对方收到 reply 才会结束对该 requestId
   * 的等待，只记日志不重试会让任务一直停在权限确认 / 工具请求上；对方按 id 去重，
   * 重复交付无副作用。任务结束或非链路类错误(载荷过大等)才放弃。
   *
   * 载荷只建一次、重试复用，且复用同一个 uploadId(分段上传按 (uploadId, index) 幂等)：
   * 重试重建会再走一遍上传，而对方对重复 reply 在 pending 查询处就返回、不会消费新上传，
   * 白白占住对方的 staging 缓冲；若首份上传已被消费、只是响应丢了，复用同一载荷还能直接
   * 命中幂等返回。上传中途失败后同一 uploadId 重传，也不会多留半份暂存载荷。
   */
  private async deliverReply(requestId: string, reply: RemoteAgentReply, signal: AbortSignal): Promise<void> {
    const uploadId = this.newId();
    let payload: RemoteAgentPayload | undefined;
    let delay = 500;
    for (let attempt = 1; ; attempt += 1) {
      if (this.closed || signal.aborted) return;
      try {
        const requireActive = () => { if (signal.aborted) throw signal.reason; };
        const invoke: RemoteAgentInvoke = args => this.deliveryGate.invoke(() => this.invoke(args), signal);
        payload ??= await this.payload(reply, uploadId, requireActive, invoke);
        requireActive();
        await invoke([{ op: 'reply', runId: this.runId, requestId, payload }]);
        return;
      } catch (error) {
        if (this.closed || signal.aborted) return;
        const retryable = isRetryableLinkError(error) && attempt < MAX_REPLY_DELIVER_ATTEMPTS;
        this.log?.warn(retryable ? 'remote agent: reply failed; retrying' : 'remote agent: reply failed', {
          runId: this.runId,
          requestId,
          attempt,
          error: String(error),
        });
        if (!retryable) return;
        if (!isDeliveryBackpressure(error)) await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }
}

/**
 * 把设备互联的失败换成带 `[REMOTE_AGENT_*]` 前缀的错误(界面按前缀给出对应文案)，保留原 `code`
 * 供重试判断。对方版本过旧(没有这个通道)单独标出，提示去那台电脑更新。
 */
export function remoteAgentLinkError(error: { code?: string; message?: string } | unknown, target?: string): Error {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message
      : 'remote agent request failed';
  if (code === 'CHANNEL_NOT_ALLOWED') {
    return Object.assign(
      new Error("[REMOTE_AGENT_PEER_TOO_OLD] Cindy on the other computer is too old to run agents for this computer."),
      { code: 'REMOTE_AGENT_PEER_TOO_OLD' },
    );
  }
  // Only refine presentation. Error.code remains the transport's retry/permission
  // decision, and an existing remote business error keeps its original envelope.
  const envelopeCode = /^\[([A-Z_]+)\]/.exec(message)?.[1];
  const causeCode = typeof code === 'string' && code !== 'IPC_ERROR' ? code : envelopeCode;
  const displayCode = remoteAgentLinkGuidanceCode(causeCode);
  const diagnostic = displayCode && causeCode && envelopeCode !== causeCode ? `[${causeCode}] ${message}` : message;
  const keepRemoteError = !displayCode && /^\[REMOTE_[A-Z_]+\]/.test(message);
  // The requested route may be a share/group rather than a resolved computer.
  // Report only this known reference and channel, not a guessed name or status.
  const context = target ? `\nrequestedTarget=${shortDeviceRef(target)}; channel=${REMOTE_AGENT_CHANNEL}` : '';
  const wrapped = new Error(keepRemoteError
    ? message : `[${displayCode ?? 'REMOTE_AGENT_UNAVAILABLE'}] ${diagnostic}${context}`);
  return typeof code === 'string' ? Object.assign(wrapped, { code }) : wrapped;
}

function remoteAgentLinkGuidanceCode(code: string | undefined): string | undefined {
  switch (code) {
    case 'TIMEOUT': case 'INVOKE_TIMEOUT': case 'DEVICE_LINK_TIMEOUT': return 'REMOTE_AGENT_TIMEOUT';
    case 'BACKPRESSURE': case 'DEVICE_LINK_BUSY': return 'REMOTE_AGENT_LINK_BUSY';
    case 'DEVICE_UNRESPONSIVE': case 'DEVICE_LINK_DEVICE_UNRESPONSIVE': return 'REMOTE_AGENT_UNRESPONSIVE';
    case 'DEVICE_OFFLINE': case 'DEVICE_LINK_DEVICE_OFFLINE': return 'REMOTE_AGENT_OFFLINE';
    case 'ACCESS_REVOKED': case 'REMOTE_DISABLED':
    case 'DEVICE_LINK_ACCESS_REVOKED': case 'DEVICE_LINK_REMOTE_DISABLED': return 'REMOTE_AGENT_ACCESS_DENIED';
    default: return undefined;
  }
}

/** 生产接线：经设备互联后台链路调用某台电脑的远程 Agent 通道。 */
export function remoteAgentInvoker(
  deviceId: string,
  invoke: (deviceId: string, channel: string, args: unknown[], options?: { beforeDispatch?: () => void }) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>,
): RemoteAgentInvoke {
  return async (args, options) => {
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      result = options ? await invoke(deviceId, REMOTE_AGENT_CHANNEL, args, options)
        : await invoke(deviceId, REMOTE_AGENT_CHANNEL, args);
    } catch (error) {
      // Cancellation before wire dispatch is not a remote failure or retry hint.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw remoteAgentLinkError(error, deviceId);
    }
    if (result.ok) return result.result;
    throw remoteAgentLinkError(result.error ?? {}, deviceId);
  };
}
