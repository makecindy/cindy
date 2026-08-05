/**
 * hook-control/transport.ts
 * ---------------------------------------------------------------------------
 * 单条 hook 连接的 WS 传输层: desktop 主动拨出到中心 slack-hook-server。
 *
 *   - 拨出方向: 本机不开任何监听端口(与 feishu WSClient 同一模型),
 *     鉴权用 Authorization: Bearer <登录 accessToken> 头
 *     (与 device-link 同模型; token 每次重连实时取, 刷新天然兼容)。
 *   - 协议帧: 全部经 @cindy/slack-hook-protocol —— 出帧走构造器 + serialize, 入帧
 *     一律先过 parseHookMessage, 坏帧记日志丢弃(规则 9)。
 *   - 生命周期: open -> 发 hello -> 等 welcome(此后状态才算 connected) ->
 *     心跳(定期 ping + 空闲看门狗); 断开按指数退避重连(1s -> 30s 封顶),
 *     welcome 到达后退避归零。
 *   - ping 自动回 pong 在本层处理(纯协议行为); 其余消息透传给上层
 *     (manager 决定业务响应, 如 dispatch 的 stub ack)。
 */

import WebSocket from 'ws';

import {
  makeHello,
  makePing,
  makePong,
  parseHookMessage,
  serializeHookMessage,
  type HelloInput,
  type HookMessage,
  type WelcomePayload,
} from '@cindy/slack-hook-protocol';

import { createOutboundHttpAgent } from '../maker-host/outbound-fetch.js';

/** transport 对外状态(manager 映射为 HookConnectionStatus)。 */
export type HookTransportStatus = 'connecting' | 'connected' | 'standby' | 'error' | 'stopped';

export interface HookTransportOpts {
  url: string;
  /**
   * 建连时实时取登录 accessToken(每次重连重取; null = 当前未登录)。
   */
  getAuthToken: () => Promise<string | null>;
  /**
   * WS upgrade 被 401 拒绝时强制刷新一次登录凭证。单个 transport 生命周期内
   * 最多调用一次，避免坏凭证形成 refresh 风暴；成功后立即用新 token 重连。
   */
  refreshAuthToken: () => Promise<boolean>;
  /** 每次连接成功后发送的 hello 内容(重读配置, 别名变更即时生效)。 */
  buildHello: () => HelloInput;
  /** welcome / ping / pong 之外的消息透传(dispatch 等业务帧)。send 返回是否送出。 */
  onMessage: (msg: HookMessage, send: (m: HookMessage) => boolean) => void;
  /**
   * welcome 到达回调(onStatus('connected') 之前触发): 上层据 payload.features
   * 记 server 能力(如 slack-tools), 发对应帧前先短路老 server。
   */
  onWelcome?: (payload: WelcomePayload) => void;
  onStatus: (status: HookTransportStatus, lastError: string | null) => void;
  /** 测试注入重连时间参数；生产缺省 1s → 30s。 */
  timing?: { backoffBaseMs?: number; backoffMaxMs?: number; standbyRetryMs?: number };
  log: { info(msg: string): void; warn(msg: string): void; debug?(msg: string): void };
}

export interface HookTransport {
  send(msg: HookMessage): boolean;
  dispose(): void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** 服务端 first-wins：同账号同 deviceId 的后续 hello 被此 close code 拒绝。 */
const DUPLICATE_DEVICE_CLOSE_CODE = 4000;
const DUPLICATE_DEVICE_CLOSE_REASON = 'device already connected';
/** transport 向 manager 暴露的稳定错误标识；renderer 据此本地化，不解析原始英文。 */
export const HOOK_TRANSPORT_ERROR_NOT_LOGGED_IN = 'not logged in';
/** standby 下低频探测首实例是否已退出；避免永久停驻，同时不形成重连风暴。 */
const STANDBY_RETRY_MS = 30_000;
/** 心跳发送间隔。 */
const PING_INTERVAL_MS = 25_000;
/** 空闲看门狗: 超过该时长没收到任何帧视为死链, 主动断开触发重连。 */
const IDLE_TIMEOUT_MS = 65_000;

export function createHookTransport(opts: HookTransportOpts): HookTransport {
  const { url, getAuthToken, refreshAuthToken, buildHello, onMessage, onStatus, log } = opts;
  const backoffBaseMs = opts.timing?.backoffBaseMs ?? BACKOFF_BASE_MS;
  const backoffMaxMs = opts.timing?.backoffMaxMs ?? BACKOFF_MAX_MS;
  const standbyRetryMs = opts.timing?.standbyRetryMs ?? STANDBY_RETRY_MS;

  let ws: WebSocket | null = null;
  let stopped = false;
  let standby = false;
  let attempt = 0;
  let authRefreshAttempted = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = 0;
  let lastError: string | null = null;
  let unexpectedHttpStatus: number | null = null;
  /**
   * 建连世代。connect() 每次调用递增,建连路径上的每个 await 之后都要比对 —— 取 token
   * 与解析出站代理各是一次异步往返,期间 401 重连 / 退避重试 / dispose 都可能再触发一次
   * connect(),不比对就会并发建出多条 socket,旧的那条没人回收(review 2026-07-27)。
   */
  let connectEpoch = 0;

  function setStatus(status: HookTransportStatus): void {
    if (stopped && status !== 'stopped') return;
    // standby 的低频探测在内部仍会经历 connecting/error，但产品状态应持续
    // 表达“另一实例持有”，直到探测真正收到 welcome 或 transport 被重建。
    if (standby && status !== 'connected' && status !== 'stopped') return;
    onStatus(status, lastError);
  }

  function clearTimers(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleRetry(delayOverrideMs?: number): void {
    if (stopped || retryTimer) return;
    const delay =
      delayOverrideMs ?? Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function send(msg: HookMessage): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(serializeHookMessage(msg));
      return true;
    } catch (err) {
      log.warn(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  function startHeartbeat(): void {
    lastFrameAt = Date.now();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 看门狗先于 ping: 长时间静默直接判死, terminate 触发 close -> 重连
      if (Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) {
        log.warn('idle timeout, terminating connection');
        ws.terminate();
        return;
      }
      send(makePing());
    }, PING_INTERVAL_MS);
  }

  function connect(): void {
    if (stopped) return;
    const epoch = ++connectEpoch;
    unexpectedHttpStatus = null;
    setStatus('connecting');
    void getAuthToken()
      .catch(() => null)
      .then((token) => {
        if (stopped || epoch !== connectEpoch) return;
        if (!token) {
          // 未登录:不发起无凭证连接(必 401),记状态按退避重试;
          // 登录事件会经 manager.sync 重建 transport 即时恢复
          lastError = HOOK_TRANSPORT_ERROR_NOT_LOGGED_IN;
          setStatus('error');
          scheduleRetry();
          return;
        }
        void openSocket(token, epoch);
      });
  }

  function handleUnauthorized(): void {
    if (authRefreshAttempted) {
      lastError = 'Unexpected server response: 401';
      setStatus('error');
      scheduleRetry();
      return;
    }
    authRefreshAttempted = true;
    void refreshAuthToken()
      .catch(() => false)
      .then((ok) => {
        if (stopped) return;
        if (ok) {
          lastError = null;
          connect();
          return;
        }
        lastError = 'Unexpected server response: 401';
        setStatus('error');
        scheduleRetry();
      });
  }

  async function openSocket(token: string, epoch: number): Promise<void> {
    let socket: WebSocket;
    try {
      // `ws` 不吃系统代理;直连时 agent 为 undefined,行为与不传一致。
      const agent = await createOutboundHttpAgent(url);
      // 代理解析是一次异步往返,期间可能已 stop 或又发起了一次 connect —— 都不再建连。
      if (stopped || epoch !== connectEpoch) return;
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 15_000,
        agent,
      });
    } catch (err) {
      // URL 非法等同步失败: 记错误并按退避重试(配置修好后自然恢复)
      lastError = err instanceof Error ? err.message : String(err);
      setStatus('error');
      scheduleRetry();
      return;
    }
    ws = socket;

    socket.on('unexpected-response', (_req, response) => {
      if (stopped) return;
      unexpectedHttpStatus = response.statusCode ?? null;
      // 注册 listener 后 ws 不再自动 abort 握手，必须显式销毁半开连接。
      socket.terminate();
      if (unexpectedHttpStatus === 401) {
        log.warn('ws upgrade rejected: 401, refreshing auth token once');
        return;
      }
      lastError = `Unexpected server response: ${unexpectedHttpStatus ?? 'unknown'}`;
      log.warn(`ws upgrade rejected: ${unexpectedHttpStatus ?? 'unknown'}`);
    });

    socket.on('open', () => {
      if (stopped) return;
      unexpectedHttpStatus = null;
      // open 只代表 TCP/WS 通了; connected 状态等 welcome —— 先自报家门
      send(makeHello(buildHello()));
      startHeartbeat();
    });

    socket.on('message', (data) => {
      if (stopped) return;
      lastFrameAt = Date.now();
      const parsed = parseHookMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      if (!parsed.ok) {
        log.warn(`bad frame dropped: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      if (msg.type === 'ping') {
        send(makePong());
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'welcome') {
        standby = false;
        attempt = 0;
        authRefreshAttempted = false;
        lastError = null;
        log.info(`handshake complete with ${msg.payload.serverName}`);
        // 能力宣告先于 connected: 上层在状态回调里可能立刻发帧, 特性集必须已就位
        opts.onWelcome?.(msg.payload);
        setStatus('connected');
        return;
      }
      onMessage(msg, send);
    });

    socket.on('error', (err) => {
      // unexpected-response 已保留真实 HTTP status；terminate 半开握手会额外产生
      // “closed before established”，不能让它覆盖可诊断的 401/503。
      if (unexpectedHttpStatus !== null) return;
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`ws error: ${lastError}`);
    });

    socket.on('close', (code, reason) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      if (stopped) return;

      const reasonText = reason.toString('utf-8');
      if (code === DUPLICATE_DEVICE_CLOSE_CODE && reasonText === DUPLICATE_DEVICE_CLOSE_REASON) {
        standby = true;
        lastError = null;
        log.info(`duplicate device connection rejected; entering standby, retrying in ${standbyRetryMs}ms`);
        onStatus('standby', null);
        scheduleRetry(standbyRetryMs);
        return;
      }
      if (unexpectedHttpStatus === 401) {
        unexpectedHttpStatus = null;
        handleUnauthorized();
        return;
      }

      log.info(`ws closed (code=${code}), scheduling reconnect`);
      setStatus(lastError ? 'error' : 'connecting');
      scheduleRetry();
    });
  }

  connect();

  return {
    send,
    dispose() {
      stopped = true;
      clearTimers();
      try {
        ws?.terminate();
      } catch {
        /* already closed */
      }
      ws = null;
      onStatus('stopped', null);
    },
  };
}
