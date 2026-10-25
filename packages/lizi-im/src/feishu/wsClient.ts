/**
 * feishu/wsClient.ts
 * ---------------------------------------------------------------------------
 * Lark.WSClient + Lark.EventDispatcher wrapper.
 *
 * 关键设计：连接生命周期优先使用 SDK 的 onReady / onError /
 * onReconnecting / onReconnected callback。自定义 Logger 仍保留同一套
 * 信号解析作为兼容兜底：
 *
 *   info  '[ws] ws client ready'    → detector.markReady()
 *   info  '[ws] reconnect success'  → detector.markReconnected()
 *   info  '[ws] reconnect'          → detector.markReconnecting()
 *   error '[ws] connect failed' / 'ws error' / 'unable to connect' → markError()
 *
 * SDK v1.24+ 验证过的字符串。SDK 升级时需要重新 grep。
 *
 * Inbound flow:
 *   im.message.receive_v1
 *     p2p:
 *       → if no owner yet: TOFU-claim sender as owner + send welcome
 *       → drop if sender open_id ≠ owner
 *       → parse content + download attachments
 *       → emit IMMessageEvent
 *     group:
 *       → drop if not @-mentioning this bot (bot open_id fetched via
 *         /open-apis/bot/v3/info after connect; unknown → drop all group msgs)
 *       → drop if no owner bound yet (群里绝不 TOFU 认主 — 钉钉同款)
 *       → non-owner @bot → polite notice (per-user cooldown), no turn
 *       → owner @bot → strip mention placeholders, senderId = lane id
 *         `g/{chatId}[/{threadId}]`, speaker = owner, record reply anchor,
 *         emit IMMessageEvent
 *
 *   入站统一门禁(所有 chat_type 生效):
 *       → 重推去重: 同一 (appId, message_id) 只处理一次(见 claimInboundMessage)
 *       → 连接换代门禁: 处理途中的 await(附件下载/引用查询)之后复查
 *         isActiveConnection(generation, botAppId) — 断开/换账号的旧连接轮次
 *         直接丢弃, 不 push 锚点、不 emit, 不会路由进新账号的 client/session
 *       → 群主流保持群 lane，话题消息保持原话题 lane
 *
 *   card.action.trigger(_v1)
 *     → drop if sender not in whitelist
 *     → parse button value
 *     → emit IMCardActionEvent
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import { ConflictDetector } from './conflictDetector.js';
import { feishuEvents } from './events.js';
import * as outbound from './outbound.js';
import * as ownerGuard from './ownerGuard.js';
import * as storage from './storage.js';
import { parseIncoming } from './incomingContent.js';
import { downloadAttachments } from './attachmentDownloader.js';
import { parseCardAction } from './cardActionParser.js';
import { encodeLaneUserId } from './codec.js';
import {
  coordinateDualDelivery,
  resetDualDeliveryForTest,
} from './dualDelivery.js';
import { bindScope, getLog, getScope, runInScope, scopeSlot } from './moduleScope.js';
import { messages as transportMessages } from './messages.js';
import type { BotCredentials, FeishuConnectionStatus } from './internal-types.js';

// ── module state ──────────────────────────────────────────────────────────────

const ws_SLOT = Symbol('feishu.ws');
function createWsState() {
  return {
    client: null as Lark.WSClient | null,
    detector: null as ConflictDetector | null,
    currentBotAppId: null as string | null,
    currentService: null as BotCredentials['service'] | null,
    pendingStartAccount: null as Pick<BotCredentials, 'appId' | 'service'> | null,
    topicLeaseDiscardThroughGeneration: 0,
    currentStatus: 'idle' as FeishuConnectionStatus,
    acceptingInbound: false,
    lifecycleGeneration: 0,
    conflictTransitionGeneration: null as number | null,
    lifecycleAnnouncementEnabled: true,
    pendingOfflineNotice: false,
    botOpenId: null as string | null,
    strangerNoticeAt: new Map<string, number>(),
    inboundInFlight: new Map<string, { generation: number }>(),
    seenInboundMessages: new Map<string, number>(),
  };
}
/** 本实例(FeishuScope)的模块状态; 没有 scope 时落在默认实例上。 */
const S = () => scopeSlot(ws_SLOT, createWsState);
/** 非 owner 群 @ 的礼貌回应 per-user 冷却(open_id → 上次回应 ts)。 */
const STRANGER_NOTICE_COOLDOWN_MS = 60_000;

/** Preserve pending topic leases only across same-account transport reconnects. */
function shouldAbandonTopicLease(
  botAppId: string,
  service: BotCredentials['service'],
  generation: number,
): boolean {
  if (generation <= S().topicLeaseDiscardThroughGeneration) return true;
  const pendingAccount = S().pendingStartAccount;
  if (pendingAccount) {
    return pendingAccount.appId !== botAppId || pendingAccount.service !== service;
  }
  return (
    S().currentBotAppId !== null &&
    (S().currentBotAppId !== botAppId || S().currentService !== service)
  );
}


/**
 * 入站消息去重 —— 飞书事件是「至少送达一次」: 服务端等不到我们的 ACK 就会把
 * 同一条消息**原样再推一遍**(同一个 message_id)。没有这道闸, 重推会被当成一条
 * 新消息跑完整一轮 turn: 群里多出一条 bot 回复 + 多花一次模型调用。
 *
 * 实测(2026-08-14 14:37, 本机网络抖动、relay 同时断线重连): 话题里只有一条
 * 用户消息, 却出现两条 bot 回复; 日志里同一句 9 字消息进了两次 processOne。
 *
 * 设计要点:
 *   - 按 (appId, message_id) 记账 —— 换 bot 不会互相串; 用户真的重复发一遍是
 *     **另一个** message_id, 不会被误杀。
 *   - 认领动作必须同步完成(检查 + 落账之间不许有 await), 否则两个并发帧会双双
 *     通过。调用点也因此放在 handleIncomingMessage 的第一个 await 之前。
 *   - **不随 stop/start 或重连清空**: 重推恰恰发生在断连重连前后, 那时清空等于
 *     闸门在最需要它的时刻失效。只按 TTL + 容量淘汰。
 */
const INBOUND_DEDUPE_TTL_MS = 10 * 60_000;
const INBOUND_DEDUPE_MAX_ENTRIES = 1_000;

/** true = 本进程没见过这条消息(可以处理); false = 重推, 应当丢弃。 */
function claimInboundMessage(appId: string, messageId: string): boolean {
  const key = `${appId}:${messageId}`;
  const now = Date.now();
  const seenAt = S().seenInboundMessages.get(key);
  if (seenAt !== undefined && now - seenAt < INBOUND_DEDUPE_TTL_MS) return false;
  // delete + set: Map 对已存在的 key 保留旧插入序, 过期条目刷新后必须重新排到
  // 队尾, 否则下面按插入序淘汰会先砍掉刚刷新的那条。
  S().seenInboundMessages.delete(key);
  S().seenInboundMessages.set(key, now);
  for (const [k, ts] of S().seenInboundMessages) {
    const withinBudget = S().seenInboundMessages.size <= INBOUND_DEDUPE_MAX_ENTRIES;
    // 插入序 = 时间序, 最老的都没过期且没超量 ⇒ 后面的也不用看。
    if (withinBudget && now - ts < INBOUND_DEDUPE_TTL_MS) break;
    if (k === key) continue;
    S().seenInboundMessages.delete(k);
  }
  return true;
}

/**
 * 释放某条消息的入站认领 —— 只在「认领了但本轮没有产出任何用户可见结果」的
 * 放弃路径上调用(连接换代丢弃), 让重推能在新连接/
 * 重试路径上重新处理。正常处理完(含已给出失败说明的放弃)绝不释放, 否则重推
 * 会再次起 turn。
 */
function releaseInboundClaim(appId: string, messageId: string): void {
  S().seenInboundMessages.delete(`${appId}:${messageId}`);
}

/** Release an unfinished turn when its connection changes. */
function abandonInboundTurn(botAppId: string, messageId: string): void {
  releaseInboundClaim(botAppId, messageId);
}

/** 测试注入口 — 生产代码不要调用(生产语义就是跨 stop/start 不清空)。 */
export function resetInboundDedupeForTest(): void {
  S().seenInboundMessages.clear();
  resetDualDeliveryForTest();
}

const DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 1500;
export const QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 4500;

// The SDK disables its ping watchdog when this value is omitted. Keep the
// timeout finite so a locally OPEN but silent connection is forced through the
// existing reconnect flow instead of dropping inbound messages indefinitely.
const FEISHU_WS_PING_TIMEOUT_SECONDS = 30;

function emitRendererStatus(error?: string): void {
  feishuEvents.emit('status', {
    status: S().currentStatus,
    error,
    botAppId: S().currentBotAppId,
    ownerOpenId: ownerGuard.firstAllowed() ?? storage.readOwnerOpenId(),
  });
}

function setStatus(status: FeishuConnectionStatus, error?: string): void {
  S().currentStatus = status;
  emitRendererStatus(error);
  // Also broadcast public IMStatus to host orchestrator subscribers
  feishuEvents.emit('imStatus', toImStatus(status, error));
}

function toImStatus(s: FeishuConnectionStatus, error?: string) {
  if (s === 'idle') return { kind: 'idle' as const };
  if (s === 'testing' || s === 'reconnecting') return { kind: 'connecting' as const };
  if (s === 'connected') return { kind: 'connected' as const, appId: S().currentBotAppId ?? '' };
  if (s === 'conflict') return { kind: 'conflict' as const, appId: S().currentBotAppId ?? '' };
  return { kind: 'error' as const, reason: error ?? 'unknown' };
}

export function getCurrentStatus(): FeishuConnectionStatus {
  return S().currentStatus;
}

export function getCurrentBotAppId(): string | null {
  return S().currentBotAppId;
}

export function setLifecycleAnnouncement(enabled: boolean): void {
  S().lifecycleAnnouncementEnabled = enabled;
  getLog().info(`[feishu/wsClient] lifecycleAnnouncement set to ${enabled}`);
}

/**
 * 拉取 bot 自身 open_id(判群 @ 用)。SDK 无专用封装, 走 Client.request 通用
 * 通道。失败只 log warn — 群功能惰性失效(群消息全丢), 私聊不受影响。
 */
async function fetchBotOpenId(): Promise<void> {
  const log = getLog();
  const c = outbound.getBoundClient();
  if (!c) return;
  try {
    const res = await c.request<{ bot?: { open_id?: string } }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    const openId = res?.bot?.open_id;
    if (typeof openId === 'string' && openId) {
      S().botOpenId = openId;
      log.info(`[feishu/wsClient] bot open_id resolved ...${openId.slice(-8)}`);
    } else {
      log.warn('[feishu/wsClient] bot/v3/info returned no open_id — group messages disabled');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/wsClient] fetchBotOpenId failed (group messages disabled): ${msg}`);
  }
}

/** 测试注入口 — 生产代码不要调用。 */
export function setBotOpenIdForTest(openId: string | null): void {
  S().botOpenId = openId;
}

const FEISHU_CONFLICT_ERROR = '该 App 已被另一台设备占用 (exceed_conn_limit)';

function isConflictSignal(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('1000040350') || normalized.includes('exceed_conn_limit');
}

function isActiveConnection(generation: number, appId: string): boolean {
  return S().acceptingInbound && S().lifecycleGeneration === generation && S().currentBotAppId === appId;
}

async function transitionToConflict(generation: number, appId: string): Promise<void> {
  if (S().conflictTransitionGeneration === generation || !isActiveConnection(generation, appId)) {
    return;
  }

  S().conflictTransitionGeneration = generation;
  setStatus('conflict', FEISHU_CONFLICT_ERROR);
  await stop({
    keepStatus: true,
    announceOffline: false,
    reason: 'connection-conflict',
  });
  feishuEvents.emit('conflict', { appId });
}

function handleReadySignal(
  activeDetector: ConflictDetector,
  generation: number,
  appId: string,
): void {
  if (!isActiveConnection(generation, appId)) return;
  activeDetector.markReady();
  if (activeDetector.getVerdict()?.kind === 'connected' && S().currentStatus !== 'connected') {
    setStatus('connected');
  }
}

function handleReconnectingSignal(
  activeDetector: ConflictDetector,
  generation: number,
  appId: string,
): void {
  if (!isActiveConnection(generation, appId)) return;
  activeDetector.markReconnecting();
  if (activeDetector.getVerdict()?.kind !== 'conflict' && S().currentStatus === 'connected') {
    setStatus('reconnecting');
  }
}

function handleReconnectedSignal(
  activeDetector: ConflictDetector,
  generation: number,
  appId: string,
): void {
  if (!isActiveConnection(generation, appId)) return;
  activeDetector.markReconnected();
  if (activeDetector.getVerdict()?.kind === 'connected' && S().currentStatus !== 'connected') {
    setStatus('connected');
  }
}

function handleErrorSignal(
  error: Error,
  activeDetector: ConflictDetector,
  generation: number,
  appId: string,
): void {
  if (!isActiveConnection(generation, appId)) return;
  if (isConflictSignal(error.message)) {
    if (!activeDetector.markConflict() && activeDetector.getVerdict()?.kind !== 'conflict') {
      void transitionToConflict(generation, appId);
    }
    return;
  }
  activeDetector.markError(error);
}

// ── SDK logger interceptor ────────────────────────────────────────────────────

interface SdkLogger {
  trace: (...msg: unknown[]) => void | Promise<void>;
  debug: (...msg: unknown[]) => void | Promise<void>;
  info: (...msg: unknown[]) => void | Promise<void>;
  warn: (...msg: unknown[]) => void | Promise<void>;
  error: (...msg: unknown[]) => void | Promise<void>;
}

function makeCapturingLogger(
  activeDetector: ConflictDetector,
  generation: number,
  appId: string,
): SdkLogger {
  const log = getLog();
  return {
    trace: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      log.debug('[feishu/sdk-info]', msg);
      if (!isActiveConnection(generation, appId)) return;
      if (msg.includes('ws client ready')) {
        handleReadySignal(activeDetector, generation, appId);
      } else if (msg.includes('reconnect success')) {
        handleReconnectedSignal(activeDetector, generation, appId);
      } else if (msg.includes('reconnect') && !msg.includes('success')) {
        handleReconnectingSignal(activeDetector, generation, appId);
      } else if (msg.includes('unable to connect to the server')) {
        activeDetector.markError(new Error('unable to connect after retries'));
        setStatus('error', '连接失败：IM 服务无法访问，请检查网络');
      }
    },
    warn: (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      log.warn('[feishu/sdk-warn]', msg);
    },
    error: (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      log.error('[feishu/sdk-error]', msg);
      if (!isActiveConnection(generation, appId)) return;
      if (isConflictSignal(msg)) {
        handleErrorSignal(new Error(FEISHU_CONFLICT_ERROR), activeDetector, generation, appId);
        return;
      }
      if (msg.includes('code: 514')) {
        activeDetector.markError(new Error('App ID / App Secret 不正确（auth_failed）'));
        setStatus('error', 'App ID 或 App Secret 不正确');
      }
    },
  };
}

// ── start / stop ──────────────────────────────────────────────────────────────

export async function start(
  creds: BotCredentials,
  opts: StartOptions = {},
): Promise<'connected' | 'conflict' | 'error'> {
  const log = getLog();
  log.info(
    `[feishu/wsClient] start requested reason=${opts.reason ?? 'unspecified'} announceLifecycle=${opts.announceLifecycle === false ? 'no' : 'yes'}`,
  );
  const pendingAccount = { appId: creds.appId, service: creds.service };
  S().pendingStartAccount = pendingAccount;
  try {
    if (S().client) {
      await stop({
        announceOffline: opts.announceLifecycle !== false,
        reason: `${opts.reason ?? 'start'}:replace-existing-client`,
      });
    }
  } catch (err) {
    if (S().pendingStartAccount === pendingAccount) S().pendingStartAccount = null;
    throw err;
  }

  const startedGeneration = ++S().lifecycleGeneration;
  S().acceptingInbound = true;
  S().currentBotAppId = creds.appId;
  S().currentService = creds.service;
  // 并发 start 时只清自己的标记，不覆盖更新一轮已经发布的待启动身份。
  if (S().pendingStartAccount === pendingAccount) S().pendingStartAccount = null;
  setStatus('testing');

  const startDetector = new ConflictDetector({
    readyTimeoutMs: 8000,
    reconnectThreshold: 2,
  });
  S().detector = startDetector;

  // Lark SDK 从它自己的 socket / 定时器里回调: 显式绑回本实例的作用域, 不靠
  // AsyncLocalStorage 隐式传播(多份 bot 并存时串线就是账号串线)。
  const scope = getScope();
  const bound = <A extends unknown[], R>(fn: (...args: A) => R) => bindScope(scope, fn);
  const sdkLogger = makeCapturingLogger(startDetector, startedGeneration, creds.appId);
  const client = new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: creds.service === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    wsConfig: {
      pingTimeout: FEISHU_WS_PING_TIMEOUT_SECONDS,
    },
    logger: {
      trace: bound(sdkLogger.trace),
      debug: bound(sdkLogger.debug),
      info: bound(sdkLogger.info),
      warn: bound(sdkLogger.warn),
      error: bound(sdkLogger.error),
    },
    onReady: bound(() => {
      handleReadySignal(startDetector, startedGeneration, creds.appId);
    }),
    onError: bound((error) => {
      handleErrorSignal(error, startDetector, startedGeneration, creds.appId);
    }),
    onReconnecting: bound(() => {
      handleReconnectingSignal(startDetector, startedGeneration, creds.appId);
    }),
    onReconnected: bound(() => {
      handleReconnectedSignal(startDetector, startedGeneration, creds.appId);
    }),
  });
  S().client = client;

  outbound.bindClient(creds);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      await runInScope(scope, async () => {
        try {
          // 传入本代 connection 的 generation — 处理途中有 await(附件下载/
          // 引用查询), 恢复执行时必须复查门禁, 防止旧连接的轮次漏进新连接。
          await handleIncomingMessage(
            creds.appId,
            creds.service,
            startedGeneration,
            data as RawMessageEvent,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('[feishu/wsClient] handleIncomingMessage threw:', msg);
        }
      });
    },
    'card.action.trigger': (data: unknown) => runInScope(scope, () => handleCardAction(data)),
    'card.action.trigger_v1': (data: unknown) => runInScope(scope, () => handleCardAction(data)),
  });

  try {
    void client.start({ eventDispatcher });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/wsClient] start threw: ${msg}`);
    setStatus('error', msg);
    startDetector.markError(err instanceof Error ? err : new Error(msg));
  }

  const verdict = await startDetector.waitForVerdict();
  if (S().detector === startDetector) S().detector = null;

  // stop() can abandon the detector while this start() is awaiting its
  // verdict. Ignore that stale result instead of overwriting the final idle
  // status or announcing online after logout.
  if (!S().acceptingInbound || S().lifecycleGeneration !== startedGeneration) {
    log.info('[feishu/wsClient] ignore stale start verdict after stop');
    return 'error';
  }

  switch (verdict.kind) {
    case 'connected':
      if (S().currentStatus !== 'connected') setStatus('connected');
      void fetchBotOpenId();
      // 恢复本 bot 在 stop() 时被挂起的排队重试(同账号重连) — 事件已被
      // ACK, 不恢复的话孤儿提示/撤回链随断连永久消失。
      if (opts.announceLifecycle !== false) {
        void announceLifecycle('online');
      } else {
        log.info('[feishu/wsClient] online announcement suppressed for transport restart');
      }
      return 'connected';
    case 'conflict':
      await transitionToConflict(startedGeneration, creds.appId);
      return 'conflict';
    case 'error':
      setStatus('error', verdict.message);
      return 'error';
  }
}

interface StartOptions {
  /** A transport-only restart keeps the logical bot online and must not announce again. */
  announceLifecycle?: boolean;
  reason?: string;
}

interface StopOptions {
  keepStatus?: boolean;
  offlineTimeoutMs?: number;
  /** False for transport recovery; true/default for a logical shutdown. */
  announceOffline?: boolean;
  /** Clear the owner after any offline notice, before broadcasting idle. */
  clearOwnerBeforeIdle?: boolean;
  /** Publish the account that will start immediately after this stop completes. */
  nextAccount?: Pick<BotCredentials, 'appId' | 'service'>;
  /** Logical logout/shutdown: old in-flight topic leases must never survive. */
  discardPendingTopicLeases?: boolean;
  reason?: string;
}

export async function stop(opts: StopOptions = {}): Promise<void> {
  const pendingAccount = opts.nextAccount
    ? { appId: opts.nextAccount.appId, service: opts.nextAccount.service }
    : null;
  if (opts.discardPendingTopicLeases) {
    // Explicit logout wins over any stale replacement intent.
    S().pendingStartAccount = null;
  } else if (pendingAccount) {
    S().pendingStartAccount = pendingAccount;
  }
  try {
    await stopCurrentClient(opts);
  } catch (err) {
    if (pendingAccount && S().pendingStartAccount === pendingAccount) S().pendingStartAccount = null;
    throw err;
  }
}

async function stopCurrentClient(opts: StopOptions): Promise<void> {
  const log = getLog();
  const stoppedGeneration = S().lifecycleGeneration;
  if (opts.discardPendingTopicLeases) {
    S().topicLeaseDiscardThroughGeneration = Math.max(
      S().topicLeaseDiscardThroughGeneration,
      stoppedGeneration,
    );
  }
  // Close the logical ingress gate before awaiting the offline announcement.
  // Lark may still deliver callbacks while stop is waiting on network I/O;
  // those callbacks must never reach account-scoped host state after logout.
  S().acceptingInbound = false;
  S().lifecycleGeneration += 1;
  log.info(
    `[feishu/wsClient] stop requested reason=${opts.reason ?? 'unspecified'} status=${S().currentStatus} hasClient=${S().client ? 'yes' : 'no'} keepStatus=${opts.keepStatus ? 'yes' : 'no'} announceOffline=${opts.announceOffline === false ? 'no' : 'yes'} offlineTimeoutMs=${opts.offlineTimeoutMs ?? DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS}`,
  );
  // currentStatus === 'connected' 时一定发; 'reconnecting' 时也发 —— 关闭应用
  // 时 SDK 可能在 close() 之前先记录一条 reconnect 日志, 导致状态切到
  // 'reconnecting', 若只检查 'connected' 则 offline 通知会静默丢失。
  if (
    opts.announceOffline !== false &&
    S().client &&
    (S().currentStatus === 'connected' || S().currentStatus === 'reconnecting')
  ) {
    const timeoutMs = opts.offlineTimeoutMs ?? DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        announceLifecycle('offline'),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      log.warn(`[feishu/wsClient] offline announcement timed out after ${timeoutMs}ms`);
    }
  } else {
    log.info(
      `[feishu/wsClient] offline announcement skipped status=${S().currentStatus} hasClient=${S().client ? 'yes' : 'no'}`,
    );
  }
  const closingClient = S().client;
  if (closingClient) {
    try {
      log.info('[feishu/wsClient] closing WS client');
      closingClient.close({ force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[feishu/wsClient] close threw: ${msg}`);
    }
    S().client = null;
  }
  const abandonedDetector = S().detector;
  if (abandonedDetector) {
    abandonedDetector.abandon();
    S().detector = null;
  }
  S().botOpenId = null;
  S().strangerNoticeAt.clear();
  // Release unfinished deliveries so the same account can process a redelivery.
  for (const key of S().inboundInFlight.keys()) {
    S().seenInboundMessages.delete(key);
  }
  S().inboundInFlight.clear();
  outbound.unbindClient();
  if (opts.clearOwnerBeforeIdle) {
    S().pendingOfflineNotice = false;
    ownerGuard.clear();
  }
  if (!opts.keepStatus) {
    S().currentBotAppId = null;
    S().currentService = null;
    setStatus('idle');
  }
}

// ── lifecycle announcement ────────────────────────────────────────────────────

async function announceLifecycle(phase: 'online' | 'offline'): Promise<void> {
  const log = getLog();

  const owner = ownerGuard.firstAllowed();
  if (!owner) {
    log.info(`[feishu/wsClient] announceLifecycle ${phase}: no owner whitelisted, skip`);
    return;
  }

  if (phase === 'offline') S().pendingOfflineNotice = true;

  if (!S().lifecycleAnnouncementEnabled) {
    log.info(`[feishu/wsClient] announceLifecycle ${phase}: message suppressed by setting`);
    return;
  }

  const text =
    phase === 'online' ? transportMessages.lifecycle.online : transportMessages.lifecycle.offline;
  try {
    log.info(`[feishu/wsClient] announceLifecycle ${phase}: sending to ...${owner.slice(-8)}`);
    const res = await outbound.sendText(owner, text);
    log.info(
      `[feishu/wsClient] announceLifecycle ${phase}: sent messageId=...${res.messageId.slice(-8)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/wsClient] announceLifecycle ${phase} failed: ${msg}`);
  }
}

// ── inbound handlers ──────────────────────────────────────────────────────────

/**
 * SDK callback shape for `im.message.receive_v1` — sender/message are at the
 * TOP level (NOT nested under `data.event` like the HTTP webhook shape).
 * Verified against @larksuiteoapi/node-sdk types/index.d.ts L291300.
 */
interface RawMessageEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    thread_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      key: string;
      id?: { open_id?: string };
      name?: string;
    }>;
  };
}

/** 平台显示名消毒: 控制字符/格式字符(含零宽)剥除 + 截断(不可信输入)。 */
function sanitizeMentionName(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 64);
}

/**
 * 群消息文本清洗: 剥掉 @bot 的占位符(`@_user_1` 形态, key 来自 mentions),
 * 其他人的占位符替换为 `@名字`(名字是平台可改字段 — 不可信输入, 控制字符
 * 剥除 + 截断后使用)。text/post 抽出的正文里的占位符同一口径处理。
 *
 * 纯 @bot 剥完保持空正文，召唤事实通过事件的 invoked 标记传递。
 */
function resolveMentionPlaceholders(
  text: string,
  mentions: NonNullable<NonNullable<RawMessageEvent['message']>['mentions']>,
  selfOpenId: string,
): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    const isSelf = mention.id?.open_id === selfOpenId;
    const safeName = sanitizeMentionName(mention.name ?? "");
    const replacement = isSelf ? '' : `@${safeName || 'user'}`;
    out = out.split(mention.key).join(replacement);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

/** 群消息是否 @ 到本 bot。botOpenId 未知恒 false(群功能惰性失效)。 */
function mentionsSelf(
  mentions: NonNullable<RawMessageEvent['message']>['mentions'],
  selfOpenId: string | null,
): boolean {
  if (!selfOpenId || !mentions) return false;
  return mentions.some((m) => m.id?.open_id === selfOpenId);
}

async function handleIncomingMessage(
  botAppId: string,
  service: BotCredentials['service'],
  generation: number,
  data: RawMessageEvent,
): Promise<void> {
  const log = getLog();
  if (!isActiveConnection(generation, botAppId)) {
    log.info('[feishu/wsClient] drop inbound message while connection is stopping');
    return;
  }
  if (!data?.message || !data?.sender) {
    log.warn(
      `[feishu/wsClient] DROP early: hasMessage=${!!data?.message} hasSender=${!!data?.sender}`,
    );
    return;
  }

  const chatType = data.message.chat_type;
  if (chatType !== 'p2p' && chatType !== 'group') {
    log.info(`[feishu/wsClient] drop unsupported chat_type=${chatType}`);
    return;
  }
  const isGroup = chatType === 'group';

  const senderOpenId = data.sender.sender_id?.open_id;
  const messageId = data.message.message_id;
  const chatId = data.message.chat_id;
  if (!senderOpenId || !messageId || !chatId) return;

  // 重推闸门 —— 必须在第一个 await 之前同步认领(见 claimInboundMessage), 也必须
  // 排在所有副作用(打表情 / 下附件 / 陌生人提示)之前: 重推一旦漏过去,
  // 这些动作都会再做一遍。
  if (!claimInboundMessage(botAppId, messageId)) {
    log.info(
      `[feishu/wsClient] drop duplicate inbound message ...${messageId.slice(-8)} ` +
        '(feishu re-push; already handled)',
    );
    return;
  }

  S().inboundInFlight.set(`${botAppId}:${messageId}`, { generation });
  try {
    await processClaimedMessage(botAppId, service, generation, data, {
      messageId,
      chatId,
      isGroup,
      senderOpenId,
    });
  } finally {
    // 自己的 entry 才清 — 重连后新连接可能已为同一条消息重新记账。
    const entry = S().inboundInFlight.get(`${botAppId}:${messageId}`);
    if (entry?.generation === generation) S().inboundInFlight.delete(`${botAppId}:${messageId}`);
  }
}

async function processClaimedMessage(
  botAppId: string,
  service: BotCredentials['service'],
  generation: number,
  data: RawMessageEvent,
  base: {
    messageId: string;
    chatId: string;
    isGroup: boolean;
    senderOpenId: string;
  },
): Promise<void> {
  const log = getLog();
  const { messageId, chatId, isGroup, senderOpenId } = base;
  const incomingThreadId = isGroup ? data.message?.thread_id : undefined;
  // 上游(handleIncomingMessage)已做过非空门, 这里保留可选链防御:
  // 提取分支后 data.message 的窄化不跨函数传递。
  const msgType = data.message?.message_type ?? '';
  const rawContent = data.message?.content ?? '';
  let commitUnpairedFlat: (() => boolean) | undefined;
  let abandonUnpairedFlat: (() => void) | undefined;
  let commitTopic: (() => boolean) | undefined;
  let abandonTopic: (() => void) | undefined;
  if (isGroup) {
    // 没 @ 到本 bot 的群消息一律丢(bot open_id 未知时也丢 — 惰性失效)。
    if (!mentionsSelf(data.message?.mentions, S().botOpenId)) return;
    // 群里绝不 TOFU 认主(钉钉同款): 没有 owner 时群消息全丢。
    if (!ownerGuard.firstAllowed()) {
      log.info('[feishu/wsClient] drop group mention: no owner bound yet');
      return;
    }
    // 非 owner @bot → 礼貌回应(per-user 冷却), 不起 turn; 对外开放的实例
    // (伙伴自有连接)放行, 带非主人标记进业务层。
    if (!ownerGuard.check(senderOpenId) && !getScope().guests) {
      const last = S().strangerNoticeAt.get(senderOpenId) ?? 0;
      if (Date.now() - last >= STRANGER_NOTICE_COOLDOWN_MS) {
        S().strangerNoticeAt.set(senderOpenId, Date.now());
        try {
          await outbound.replyText(messageId, transportMessages.group.strangerNotice);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[feishu/wsClient] stranger notice failed (non-fatal): ${msg}`);
        }
      }
      return;
    }

    const createTime = data.message?.create_time ?? '';
    if (createTime) {
      const paired = await coordinateDualDelivery({
        appId: botAppId,
        chatId,
        senderOpenId,
        createTime,
        messageType: msgType,
        rawContent,
        messageId,
        threadId: data.message?.thread_id ?? '',
      });
      if (paired.kind === 'suppress-main-copy') {
        log.info('[feishu/wsClient] native thread main-feed copy suppressed');
        return;
      }
      commitUnpairedFlat = paired.commitUnpairedFlat;
      abandonUnpairedFlat = paired.abandonUnpairedFlat;
      commitTopic = paired.commitTopic;
      abandonTopic = paired.abandonTopic;
    }
  } else {
    // TOFU: first p2p sender becomes owner. Send welcome and continue
    // processing this very message (so the user's first ask isn't lost).
    if (ownerGuard.tryClaimOwner(senderOpenId)) {
      log.info(`[feishu/wsClient] TOFU: claimed owner ...${senderOpenId.slice(-8)}`);
      emitRendererStatus();
      try {
        await outbound.sendText(senderOpenId, transportMessages.ownerBinding.welcome);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[feishu/wsClient] TOFU welcome send failed (non-fatal): ${msg}`);
      }
    }

    // whitelist gate(对外开放的实例放行非主人私聊, 下面带非主人标记进业务层)。
    if (!ownerGuard.check(senderOpenId) && !getScope().guests) {
      log.warn(`[feishu/wsClient] drop non-whitelisted sender ...${senderOpenId.slice(-8)}`);
      return;
    }

    if (S().pendingOfflineNotice) {
      S().pendingOfflineNotice = false;
      try {
        await outbound.sendText(senderOpenId, transportMessages.lifecycle.offlineNotice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[feishu/wsClient] offlineNotice send failed (non-fatal): ${msg}`);
      }
    }
  }

  const parsed = parseIncoming(msgType, rawContent);
  const senderIsOwner = ownerGuard.check(senderOpenId);
  // 命令永远只认主人: 对外开放时陌生人的 `/xxx` 静默丢(不可被探测, 与 Telegram 同口径)。
  if (!senderIsOwner && /^\s*[/!]/.test(parsed.text)) {
    abandonUnpairedFlat?.();
    abandonTopic?.();
    return;
  }
  let attachments: Awaited<ReturnType<typeof downloadAttachments>>['attachments'] = [];
  let unsupported = parsed.unsupported;
  if (parsed.attachments.length > 0) {
    const c = outbound.getBoundClient();
    if (c) {
      const downloaded = await downloadAttachments(c, messageId, parsed.attachments);
      attachments = downloaded.attachments;
      unsupported = [...unsupported, ...downloaded.unsupported];
    } else {
      unsupported = [
        ...unsupported,
        {
          type: 'no_client',
          label: `${parsed.attachments.length} 个附件下载失败：客户端未就绪`,
        },
      ];
    }
  }

  // 群消息: 剥 @bot 占位符、其他 @ 转显示名。
  const selfOpenId = S().botOpenId;
  const text =
    isGroup && data.message?.mentions && selfOpenId
      ? resolveMentionPlaceholders(parsed.text, data.message.mentions, selfOpenId)
      : parsed.text;

  // Drop entirely only when there's literally nothing to relay.
  if (!text && attachments.length === 0 && unsupported.length === 0 && !(isGroup && parsed.text.trim())) {
    abandonUnpairedFlat?.();
    abandonTopic?.();
    return;
  }

  // 飞书普通「回复某条消息」只在 parent_id 表达引用关系;root_id 也会出现在
  // 话题链路,不能拿它判普通回复。严格限定群主流(!thread_id),确保已有话题
  // @bot 与普通群主流 @bot 不经过新增 REST/上下文路径。
  const parentMessageId = data.message?.parent_id;
  const resolvedReply =
    isGroup && !incomingThreadId && parentMessageId
      ? await outbound.resolveReplyMessage(parentMessageId, chatId)
      : null;

  // 入站门禁复查: 附件下载等 await 期间连接可能已 stop()/换账号换代 — 不复查
  // 会把旧连接的轮次推进新连接的编排状态(锚点污染/跨账号出站)。
  if (!isActiveConnection(generation, botAppId)) {
    // stop() 已释放认领(重连接管)时不得再碰 — 新连接可能已为同一条消息
    // 重新认领; 记账还在(处理在 stop 之外被换代)→ 释放让重投可处理。
    if (S().inboundInFlight.get(`${botAppId}:${messageId}`)?.generation === generation) {
      abandonInboundTurn(botAppId, messageId);
    }
    log.info('[feishu/wsClient] drop inbound message: connection changed during processing');
    abandonUnpairedFlat?.();
    if (shouldAbandonTopicLease(botAppId, service, generation)) abandonTopic?.();
    return;
  }

  // Replies stay where the question was asked; never create a topic for a
  // main-timeline message. Commit the elected copy before queueing its anchor.
  let laneUserId: string | null = null;
  if (isGroup) {
    const commit = incomingThreadId ? commitTopic : commitUnpairedFlat;
    if (commit && !commit()) return;
    laneUserId = encodeLaneUserId(chatId, incomingThreadId ?? null);
    outbound.pushReplyAnchor(laneUserId, messageId);
  }

  // Emit raw fields — orchestrator decides how to render unsupported (it owns
  // the user-facing wording and the "skip agent for pure-unsupported" rule).
  feishuEvents.emit('message', {
    channelName: 'feishu',
    invoked: isGroup,
    senderId: laneUserId ?? senderOpenId,
    ...(!isGroup && data.message?.thread_id && data.message?.root_id
      ? { replyThread: { rootMessageId: data.message.root_id, threadId: data.message.thread_id } }
      : {}),
    chatId,
    contextId: botAppId,
    messageId,
    text,
    ...(laneUserId || !senderIsOwner
      ? {
          // 群轮次必带 speaker — 共享层以它识别群轮(强确认策略/命令主人门);
          // 对外开放的实例里非主人的私聊同样带 speaker(访客权限策略据此收紧)。
          // name 留空(飞书事件不带显示名)。
          speaker: { id: senderOpenId, name: '', isOwner: senderIsOwner },
        }
      : {}),
    ...(resolvedReply ? { replyContext: resolvedReply.replyContext } : {}),
    attachments,
    unsupported,
    raw: data,
  });
}

async function handleCardAction(data: unknown): Promise<unknown> {
  const log = getLog();
  if (!S().acceptingInbound) {
    log.info('[feishu/wsClient] drop card action while connection is stopping');
    return {};
  }
  let parsedOk = false;
  try {
    const event = parseCardAction({ raw: data });
    if (event) {
      // 群卡片的回调 senderId 归一成发卡 lane(与消息侧 /ctr 锁、接管 binding
      // 的键一致, 否则锁永远清不掉);私聊卡 / 改投 DM 卡没有登记, 保持
      // operator.open_id。白名单校验仍以 operator.open_id 为准(parser 内)。
      const lane = outbound.resolveCardLane(event.messageId, event.chatId);
      if (lane) {
        event.senderId = lane;
        log.info(
          `[feishu/wsClient] card action sender normalized to lane ...${lane.slice(-8)}`,
        );
      }
      // Keep the Feishu callback path short: card handlers often patch the
      // same message, and doing that before the action ACK returns can race
      // the client-side card action state. Dispatch on the next tick so the
      // toast response is settled first.
      setImmediate(() => {
        feishuEvents.emit('cardAction', event);
      });
      parsedOk = true;
    } else {
      // Schema drift detector — only fires when our parser fails. Dumps
      // payload so future SDK-shape changes can be diagnosed in one log line
      // instead of having to re-instrument.
      try {
        log.warn(
          `[feishu/wsClient] handleCardAction parsed null. raw=${JSON.stringify(data).slice(0, 800)}`,
        );
      } catch {
        log.warn('[feishu/wsClient] handleCardAction parsed null (raw not stringifiable)');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/wsClient] handleCardAction threw: ${msg}`);
  }
  // Feishu's card.action.trigger callback response can carry a `toast` (small
  // bubble) the client shows over the chat. Returning toast immediately here
  // gives the user instant "click registered" feedback even before the
  // orchestrator finishes patching the card. Generic wording — orchestrator's
  // updateInteractiveCard authoritatively replaces the card body.
  return parsedOk ? { toast: { type: 'success', content: '已收到您的选择' } } : {};
}
