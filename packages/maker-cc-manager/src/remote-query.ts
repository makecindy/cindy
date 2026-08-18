/**
 * RemoteQuery — a "fake SDK Query" that fulfils the @anthropic-ai/claude-agent-sdk
 * Query interface by translating each call into NDJSON RPC against a remote
 * cc-manager daemon.
 *
 * Lifecycle:
 *   const remote = await createRemoteQuery({ client, sessionId, startParams });
 *   for await (const message of remote) { ... }
 *   await remote.setModel('claude-haiku-4-5');
 *   await remote.interrupt();
 *   await remote.close();
 *
 * Threading model: events arrive as RpcNotifications and are queued; the
 * AsyncIterator pulls them in FIFO order. setModel/etc. issue RPC requests
 * and await the matching response.
 *
 * The returned object intentionally narrows the SDK Query interface to what
 * ClaudeCodeAgent's consumer loop actually needs. Methods like rewindFiles
 * / supportedModels / mcpServerStatus are not exposed (not MVP).
 */

import { createAsyncQueue } from './async-queue.js';
import { NOTIFICATIONS, METHODS } from './protocol.js';
import type {
  QueryEventNotification,
  QueryStartParams,
  QueryStartResult,
  SessionAttachResult,
  SessionClosedNotification,
} from './protocol.js';
import { RpcClientError } from './client.js';
import type { RpcClient, RpcPendingRequest } from './client.js';

export interface RemoteQueryOptions {
  /** Connected + hello'd RpcClient. Caller owns lifecycle. */
  client: RpcClient;
  /** Session id (manager-side). Must match the one used at create / attach. */
  sessionId: string;
}

export interface CreateRemoteQueryOptions extends RemoteQueryOptions {
  /**
   * If set, calls `query/start` to create a new session before yielding the
   * remote query. Mutually exclusive with `attach`.
   */
  startParams?: Omit<QueryStartParams, 'sessionId'>;
  /**
   * If set, calls `session/attach` to resume an existing session. Mutually
   * exclusive with `startParams`. Optional `sinceSeq` is forwarded so the
   * server can replay missed events (Phase 5).
   */
  attach?: { sinceSeq?: number };
  /**
   * Per-request RPC timeout (ms). Applied to query/start, query/send,
   * setModel/setPermissionMode/applyFlagSettings/interrupt, query/close.
   * 不传 = 无 timeout (request 永远等); 强烈建议传, 否则 daemon hang 时
   * client send 路径无限等。RPC 默认 timeoutMs=15_000 跟 cc-manager-client
   * 顶层 RPC_REQUEST_TIMEOUT_MS 对齐。
   */
  rpcTimeoutMs?: number;
  /** Called when the manager reports that ring-buffer replay lost events
   *  (mid-turn reattach 超出内存 buffer 容量)。jsonl recovery 会兜底, 仅用于日志。 */
  onReplayLossy?: (result: SessionAttachResult) => void;
}

export interface RemoteQuery extends AsyncIterable<unknown> {
  /** Session id. */
  readonly sessionId: string;
  /** Push a user message into the session's input queue (transports to query/send RPC). */
  send(message: unknown): Promise<void>;
  /** Split local transport submission from the later query/send RPC response. */
  sendWithSubmission(message: unknown): RpcPendingRequest<void>;
  /** True only for a correlated manager RPC error response, never timeout/close. */
  isAuthoritativeResponseError(error: unknown): boolean;
  /** Forward to query/setModel. */
  setModel(model?: string): Promise<void>;
  /** Forward to query/setPermissionMode. */
  setPermissionMode(mode: string): Promise<void>;
  /** Forward to query/applyFlagSettings. */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  /** Forward to query/getContextUsage. */
  getContextUsage(): Promise<unknown>;
  /** Forward to query/interrupt. */
  interrupt(): Promise<void>;
  /**
   * Forward to query/stopTask — stop a single background task (subagent /
   * workflow). Old daemons without this method reject the RPC; callers should
   * degrade gracefully (maker-core catches and warns).
   */
  stopTask(taskId: string): Promise<void>;
  /**
   * Close: ends the local iterator and calls query/close on manager.
   * After close, send/setModel/etc. all reject. Iterator yields done.
   */
  close(): Promise<void>;
  /**
   * Detach: ends the local iterator without query/close, preserving the
   * daemon-side session for later reattach.
   */
  detach(): Promise<void>;
}

export async function createRemoteQuery(opts: CreateRemoteQueryOptions): Promise<RemoteQuery> {
  if (opts.startParams && opts.attach) {
    throw new Error('createRemoteQuery: startParams and attach are mutually exclusive');
  }
  if (!opts.startParams && !opts.attach) {
    throw new Error('createRemoteQuery: must specify either startParams or attach');
  }

  const messageQueue = createAsyncQueue<{ seq: number; message: unknown }>();
  let closed = false;
  // round-14: 所有内部 RPC 走同款 timeout 兜底, 跟 cc-manager-client 顶层 RPC
  // 一致 (greptile P2 finding remote-query.ts:172)。daemon hang 时 send/control
  // 路径不会无限等。
  const rpcOpts = opts.rpcTimeoutMs !== undefined ? { timeoutMs: opts.rpcTimeoutMs } : {};

  // Subscribe to notifications for this session BEFORE start/attach to avoid
  // racing the first event (init message arrives immediately after start).
  const unsubscribe = opts.client.subscribe((n) => {
    if (n.method === NOTIFICATIONS.QUERY_EVENT) {
      const evt = n.params as QueryEventNotification;
      if (evt.sessionId === opts.sessionId) {
        messageQueue.push({ seq: evt.seq, message: evt.message });
      }
      return;
    }
    if (n.method === NOTIFICATIONS.SESSION_CLOSED) {
      const evt = n.params as SessionClosedNotification;
      if (evt.sessionId === opts.sessionId) {
        if (!closed) {
          closed = true;
          messageQueue.end();
        }
      }
      return;
    }
    if (n.method === NOTIFICATIONS.CLIENT_REPLACED) {
      const evt = n.params as { sessionId: string };
      if (evt.sessionId === opts.sessionId) {
        if (!closed) {
          closed = true;
          messageQueue.end();
        }
      }
      return;
    }
  });

  // Lifecycle: when the underlying RPC stream closes (peer hung up — daemon
  // killed by force-upgrade / SIGKILL / network blip / restart), treat it as
  // an implicit session end. Without this, the async iterator wedges on an
  // empty queue forever — SESSION_CLOSED notification may have been lost in
  // the truncated write buffer of a dying daemon.
  // The U2 fallback in ClaudeCodeAgent's startForwardLoop relies on the
  // iterator actually returning to push its error event; we deliver that
  // signal here.
  const unsubscribeClose = opts.client.subscribeClose(() => {
    if (!closed) {
      closed = true;
      messageQueue.end();
    }
  });

  // Perform start or attach.
  if (opts.startParams) {
    const params: QueryStartParams = {
      sessionId: opts.sessionId,
      ...opts.startParams,
    };
    await opts.client.request<QueryStartResult>(METHODS.QUERY_START, params, rpcOpts);
  } else if (opts.attach) {
    const params = {
      sessionId: opts.sessionId,
      ...(opts.attach.sinceSeq !== undefined ? { sinceSeq: opts.attach.sinceSeq } : {}),
    };
    const result = await opts.client.request<SessionAttachResult>(METHODS.SESSION_ATTACH, params, rpcOpts);
    if (result.replayLossy) {
      closed = true;
      unsubscribe();
      unsubscribeClose();
      messageQueue.end();
      opts.onReplayLossy?.(result);
      throw new Error(
        `RemoteQuery(${opts.sessionId}) replay buffer is lossy; start a new remote session`,
      );
    }
    if (!result.alive) {
      closed = true;
      messageQueue.end();
    }
  }

  function sendWithSubmission(message: unknown): RpcPendingRequest<void> {
    if (closed) {
      const failed: Promise<never> = Promise.reject(
        new Error(`RemoteQuery(${opts.sessionId}) is closed`),
      );
      return { submitted: failed, response: failed };
    }
    return opts.client.requestWithSubmission<void>(METHODS.QUERY_SEND, {
      sessionId: opts.sessionId,
      message,
    }, rpcOpts);
  }

  async function send(message: unknown): Promise<void> {
    const pending = sendWithSubmission(message);
    void pending.submitted.catch(() => undefined);
    await pending.response;
  }

  async function setModel(model?: string): Promise<void> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    await opts.client.request(METHODS.QUERY_SET_MODEL, {
      sessionId: opts.sessionId,
      model: model ?? '',
    }, rpcOpts);
  }

  async function setPermissionMode(mode: string): Promise<void> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    await opts.client.request(METHODS.QUERY_SET_PERMISSION_MODE, {
      sessionId: opts.sessionId,
      mode,
    }, rpcOpts);
  }

  async function applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    await opts.client.request(METHODS.QUERY_APPLY_FLAG_SETTINGS, {
      sessionId: opts.sessionId,
      settings,
    }, rpcOpts);
  }

  async function getContextUsage(): Promise<unknown> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    return opts.client.request(METHODS.QUERY_GET_CONTEXT_USAGE, {
      sessionId: opts.sessionId,
    }, rpcOpts);
  }

  async function interrupt(): Promise<void> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    await opts.client.request(METHODS.QUERY_INTERRUPT, {
      sessionId: opts.sessionId,
    }, rpcOpts);
  }

  async function stopTask(taskId: string): Promise<void> {
    if (closed) throw new Error(`RemoteQuery(${opts.sessionId}) is closed`);
    await opts.client.request(METHODS.QUERY_STOP_TASK, {
      sessionId: opts.sessionId,
      taskId,
    }, rpcOpts);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeClose();
    try {
      await opts.client.request(METHODS.QUERY_CLOSE, {
        sessionId: opts.sessionId,
      }, rpcOpts);
    } catch {
      /* manager may be unreachable — best effort */
    }
    messageQueue.end();
  }

  async function detach(): Promise<void> {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeClose();
    messageQueue.end();
  }

  return {
    sessionId: opts.sessionId,
    send,
    sendWithSubmission,
    isAuthoritativeResponseError: (error: unknown) => error instanceof RpcClientError,
    setModel,
    setPermissionMode,
    applyFlagSettings,
    getContextUsage,
    interrupt,
    stopTask,
    close,
    detach,
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<unknown> {
      // live 事件直接透传 — 持久化由 desktop 的 message DB 收口(register.ts
      // onEvent → broadcaster)。RemoteQuery 不承担 cursor / prefill / ack 职责。
      // **MVP**:断开期间(dead session)的历史不恢复;基于 SDK jsonl 的
      // read-since-lineNo recovery 是 follow-up,尚未实现。
      for await (const evt of messageQueue) {
        yield evt.message;
      }
    },
  };
}
