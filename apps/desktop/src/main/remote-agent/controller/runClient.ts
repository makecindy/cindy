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
  REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
  parseRemoteAgentCaps,
  parseRemoteAgentStreamItem,
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
import { isRetryableLinkError, RemoteAgentPoller, type PolledRun, type RemoteAgentInvoke } from './poller';

export { isRetryableLinkError, RemoteAgentPoller, type RemoteAgentInvoke } from './poller';

const gzipAsync = promisify(gzip);

/** 单行事件上限(大工具结果)。 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** 结束时等对方收尾事件到达的最长时间。 */
const CLOSE_DRAIN_MS = 5_000;
/** 回包交付重试上限(链路抖动时对方一直在等同一 requestId 的回包)。 */
const MAX_REPLY_DELIVER_ATTEMPTS = 30;
/** push 帧批次交付重试上限(对方按 seq 去重，同序号重试不会重复投递)。 */
const MAX_PUSH_DELIVER_ATTEMPTS = 30;

export class RemoteAgentRemoteError extends Error {
  constructor(readonly info: RemoteAgentErrorInfo) {
    super(info.message || info.code);
    this.name = info.name ?? 'RemoteAgentRemoteError';
  }
}

export interface RemoteAgentRunHandlers {
  onEvent(event: unknown): void;
  onState(state: Record<string, unknown>): void;
  onRequest(request: RemoteAgentReverseRequest, signal: AbortSignal): Promise<RemoteAgentReply>;
  onWs(item: Extract<RemoteAgentStreamItem, { t: 'ws' }>): void;
  onClosed(reason: string, error?: RemoteAgentErrorInfo): void;
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
  private readonly pendingCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private started: { resolve(handle: Record<string, unknown>): void; reject(error: Error): void } | null = null;
  private readonly splitter = new LineSplitter(MAX_LINE_BYTES);
  private readonly inflight = new Map<string, AbortController>();

  private readonly invoke: RemoteAgentInvoke;

  constructor(
    readonly runId: string,
    private readonly poller: RemoteAgentPoller,
    private readonly handlers: RemoteAgentRunHandlers,
    private readonly newId: () => string,
    private readonly log?: { warn(message: string, meta?: Record<string, unknown>): void },
  ) {
    this.invoke = poller.invoke;
    this.drained = new Promise<void>((resolve) => {
      this.markDrained = resolve;
    });
  }

  static async caps(invoke: RemoteAgentInvoke): Promise<RemoteAgentCaps> {
    return parseRemoteAgentCaps(await invoke([{ op: 'caps' }]));
  }

  /** 把一个 JSON 值做成载荷：小的内联，大的 gzip 后分段上传。 */
  async payload(value: unknown, uploadId = this.newId()): Promise<RemoteAgentPayload> {
    const text = JSON.stringify(value ?? null);
    if (text.length <= REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS) return { json: JSON.parse(text) as unknown };
    const gz = await gzipAsync(Buffer.from(text, 'utf8'));
    if (gz.length > REMOTE_AGENT_MAX_PAYLOAD_BYTES) throw new Error('The request is too large to send to the other computer.');
    const chunks = Math.max(1, Math.ceil(gz.length / REMOTE_AGENT_UPLOAD_CHUNK_BYTES));
    for (let index = 0; index < chunks; index += 1) {
      const data = gz.subarray(index * REMOTE_AGENT_UPLOAD_CHUNK_BYTES, (index + 1) * REMOTE_AGENT_UPLOAD_CHUNK_BYTES);
      await this.invoke([{ op: 'upload', uploadId, index, data: data.toString('base64') }]);
    }
    return { uploadId, chunks, bytes: gz.length };
  }

  /**
   * 打开任务：等对方启动 Agent 成功(返回会话描述)或失败(抛出对方的错误)。已关闭的连接不能再打开：本机这边的
   * 任务已经结束(撤权、用户关闭)，再打开会在对方留下一个没人拉取、没人关闭的任务。
   */
  async open(agentKind: RemoteAgentKind, openPayload: unknown): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
    const payload = await this.payload(openPayload);
    if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on this computer.');
    const started = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.started = { resolve, reject };
    });
    try {
      await this.invoke([{ op: 'open', runId: this.runId, agentKind, payload }]);
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
    return started;
  }

  /** 调用对方会话的一个方法，等结果。 */
  call(method: RemoteAgentMethod, args: unknown[]): Promise<unknown> {
    return this.callWithId(this.newId(), method, args);
  }

  /** 预先分配的 callId(需要先把回调登记到 callId 上时用)。 */
  async callWithId(callId: string, method: RemoteAgentMethod, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new Error('[REMOTE_AGENT_EXPIRED] The task has ended on the other computer.');
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject });
    });
    try {
      const payload = await this.payload(args);
      await this.invoke([{ op: 'call', runId: this.runId, callId, method, payload }]);
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
    for (let attempt = 1; ; attempt += 1) {
      if (this.closed) return;
      try {
        await this.invoke([{ op: 'push', runId: this.runId, seq, frames }]);
        return;
      } catch (error) {
        const retryable = isRetryableLinkError(error) && attempt < MAX_PUSH_DELIVER_ATTEMPTS;
        this.log?.warn(retryable ? 'remote agent: push failed; retrying' : 'remote agent: push failed', {
          runId: this.runId,
          seq,
          attempt,
          error: String(error),
        });
        if (!retryable) throw error;
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  async close(mode: 'close' | 'detach', reason: RemoteAgentTeardownReason): Promise<void> {
    if (this.closed) return;
    try {
      await this.invoke([{ op: 'close', runId: this.runId, mode, reason }]);
    } finally {
      // 收尾事件仍会经 poll 到达；流结束时自行收口。
      if (this.registered) await Promise.race([this.drained, sleep(CLOSE_DRAIN_MS)]);
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

  private finish(reason: string, error?: RemoteAgentErrorInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.poller.unregister(this.runId);
    this.markDrained();
    const failure = new Error(error?.message ?? `[REMOTE_AGENT_EXPIRED] The task ended on the other computer (${reason}).`);
    this.started?.reject(error ? new RemoteAgentRemoteError(error) : failure);
    this.started = null;
    for (const abort of this.inflight.values()) abort.abort();
    this.inflight.clear();
    for (const pending of this.pendingCalls.values()) pending.reject(failure);
    this.pendingCalls.clear();
    this.handlers.onClosed(reason, error);
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
        this.started?.reject(new RemoteAgentRemoteError(item.error));
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
        this.finish(item.reason, item.error);
        return;
    }
  }

  private async answer(requestId: string, request: RemoteAgentReverseRequest): Promise<void> {
    const abort = new AbortController();
    this.inflight.set(requestId, abort);
    let reply: RemoteAgentReply;
    try {
      reply = await this.handlers.onRequest(request, abort.signal);
    } catch (error) {
      reply = { type: 'error', error: { code: 'CONTROLLER_ERROR', message: error instanceof Error ? error.message : String(error) } };
    } finally {
      this.inflight.delete(requestId);
    }
    if (this.closed || abort.signal.aborted) return;
    await this.deliverReply(requestId, reply);
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
  private async deliverReply(requestId: string, reply: RemoteAgentReply): Promise<void> {
    const uploadId = this.newId();
    let payload: RemoteAgentPayload | undefined;
    let delay = 500;
    for (let attempt = 1; ; attempt += 1) {
      if (this.closed) return;
      try {
        payload ??= await this.payload(reply, uploadId);
        await this.invoke([{ op: 'reply', runId: this.runId, requestId, payload }]);
        return;
      } catch (error) {
        const retryable = isRetryableLinkError(error) && attempt < MAX_REPLY_DELIVER_ATTEMPTS;
        this.log?.warn(retryable ? 'remote agent: reply failed; retrying' : 'remote agent: reply failed', {
          runId: this.runId,
          requestId,
          attempt,
          error: String(error),
        });
        if (!retryable) return;
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }
}

/**
 * 把设备互联的失败换成带 `[REMOTE_AGENT_*]` 前缀的错误(界面按前缀给出对应文案)，保留原 `code`
 * 供重试判断。对方版本过旧(没有这个通道)单独标出，提示去那台电脑更新。
 */
export function remoteAgentLinkError(error: { code?: string; message?: string } | unknown): Error {
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
  const wrapped = new Error(/^\[REMOTE_[A-Z_]+\]/.test(message) ? message : `[REMOTE_AGENT_UNAVAILABLE] ${message}`);
  return typeof code === 'string' ? Object.assign(wrapped, { code }) : wrapped;
}

/** 生产接线：经设备互联后台链路调用某台电脑的远程 Agent 通道。 */
export function remoteAgentInvoker(
  deviceId: string,
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>,
): RemoteAgentInvoke {
  return async (args) => {
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      result = await invoke(deviceId, REMOTE_AGENT_CHANNEL, args);
    } catch (error) {
      throw remoteAgentLinkError(error);
    }
    if (result.ok) return result.result;
    throw remoteAgentLinkError(result.error ?? {});
  };
}
