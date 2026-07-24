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
 *     → drop if chat_type ≠ 'p2p'
 *     → if no owner yet: TOFU-claim sender as owner + send welcome
 *     → drop if sender open_id ≠ owner
 *     → parse content + download attachments
 *     → emit IMMessageEvent
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
import { parseIncoming } from './incomingContent.js';
import { downloadAttachments } from './attachmentDownloader.js';
import { parseCardAction } from './cardActionParser.js';
import { getLog } from './moduleScope.js';
import { messages as transportMessages } from './messages.js';
import type {
  BotCredentials,
  FeishuConnectionStatus,
} from './internal-types.js';

// ── module state ──────────────────────────────────────────────────────────────

let client: Lark.WSClient | null = null;
let detector: ConflictDetector | null = null;
let currentBotAppId: string | null = null;
let currentStatus: FeishuConnectionStatus = 'idle';
let acceptingInbound = false;
let lifecycleGeneration = 0;
let conflictTransitionGeneration: number | null = null;

let lifecycleAnnouncementEnabled = true;
let pendingOfflineNotice = false;

const DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 1500;
export const QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 4500;

function setStatus(status: FeishuConnectionStatus, error?: string): void {
  currentStatus = status;
  feishuEvents.emit('status', { status, error, botAppId: currentBotAppId });
  // Also broadcast public IMStatus to host orchestrator subscribers
  feishuEvents.emit('imStatus', toImStatus(status, error));
}

function toImStatus(s: FeishuConnectionStatus, error?: string) {
  if (s === 'idle') return { kind: 'idle' as const };
  if (s === 'testing' || s === 'reconnecting') return { kind: 'connecting' as const };
  if (s === 'connected') return { kind: 'connected' as const, appId: currentBotAppId ?? '' };
  if (s === 'conflict') return { kind: 'conflict' as const, appId: currentBotAppId ?? '' };
  return { kind: 'error' as const, reason: error ?? 'unknown' };
}

export function getCurrentStatus(): FeishuConnectionStatus {
  return currentStatus;
}

export function getCurrentBotAppId(): string | null {
  return currentBotAppId;
}

export function setLifecycleAnnouncement(enabled: boolean): void {
  lifecycleAnnouncementEnabled = enabled;
  getLog().info(`[feishu/wsClient] lifecycleAnnouncement set to ${enabled}`);
}

const FEISHU_CONFLICT_ERROR = '该 App 已被另一台设备占用 (exceed_conn_limit)';

function isConflictSignal(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('1000040350') || normalized.includes('exceed_conn_limit');
}

function isActiveConnection(generation: number, appId: string): boolean {
  return (
    acceptingInbound &&
    lifecycleGeneration === generation &&
    currentBotAppId === appId
  );
}

async function transitionToConflict(
  generation: number,
  appId: string,
): Promise<void> {
  if (
    conflictTransitionGeneration === generation ||
    !isActiveConnection(generation, appId)
  ) {
    return;
  }

  conflictTransitionGeneration = generation;
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
  if (
    activeDetector.getVerdict()?.kind === 'connected' &&
    currentStatus !== 'connected'
  ) {
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
  if (
    activeDetector.getVerdict()?.kind !== 'conflict' &&
    currentStatus === 'connected'
  ) {
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
  if (
    activeDetector.getVerdict()?.kind === 'connected' &&
    currentStatus !== 'connected'
  ) {
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
    if (
      !activeDetector.markConflict() &&
      activeDetector.getVerdict()?.kind !== 'conflict'
    ) {
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
      const msg = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
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
        setStatus('error', '连接失败：飞书服务无法访问，请检查网络');
      }
    },
    warn: (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      log.warn('[feishu/sdk-warn]', msg);
    },
    error: (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      log.error('[feishu/sdk-error]', msg);
      if (!isActiveConnection(generation, appId)) return;
      if (isConflictSignal(msg)) {
        handleErrorSignal(
          new Error(FEISHU_CONFLICT_ERROR),
          activeDetector,
          generation,
          appId,
        );
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
  if (client) {
    await stop({
      announceOffline: opts.announceLifecycle !== false,
      reason: `${opts.reason ?? 'start'}:replace-existing-client`,
    });
  }

  const startedGeneration = ++lifecycleGeneration;
  acceptingInbound = true;
  currentBotAppId = creds.appId;
  setStatus('testing');

  const startDetector = new ConflictDetector({ readyTimeoutMs: 8000, reconnectThreshold: 2 });
  detector = startDetector;

  client = new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    logger: makeCapturingLogger(startDetector, startedGeneration, creds.appId),
    onReady: () => {
      handleReadySignal(startDetector, startedGeneration, creds.appId);
    },
    onError: (error) => {
      handleErrorSignal(error, startDetector, startedGeneration, creds.appId);
    },
    onReconnecting: () => {
      handleReconnectingSignal(startDetector, startedGeneration, creds.appId);
    },
    onReconnected: () => {
      handleReconnectedSignal(startDetector, startedGeneration, creds.appId);
    },
  });

  outbound.bindClient(creds);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await handleIncomingMessage(creds.appId, data as RawMessageEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('[feishu/wsClient] handleIncomingMessage threw:', msg);
      }
    },
    'card.action.trigger': handleCardAction,
    'card.action.trigger_v1': handleCardAction,
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
  if (detector === startDetector) detector = null;

  // stop() can abandon the detector while this start() is awaiting its
  // verdict. Ignore that stale result instead of overwriting the final idle
  // status or announcing online after logout.
  if (!acceptingInbound || lifecycleGeneration !== startedGeneration) {
    log.info('[feishu/wsClient] ignore stale start verdict after stop');
    return 'error';
  }

  switch (verdict.kind) {
    case 'connected':
      if (currentStatus !== 'connected') setStatus('connected');
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
  reason?: string;
}

export async function stop(opts: StopOptions = {}): Promise<void> {
  const log = getLog();
  // Close the logical ingress gate before awaiting the offline announcement.
  // Lark may still deliver callbacks while stop is waiting on network I/O;
  // those callbacks must never reach account-scoped host state after logout.
  acceptingInbound = false;
  lifecycleGeneration += 1;
  log.info(
    `[feishu/wsClient] stop requested reason=${opts.reason ?? 'unspecified'} status=${currentStatus} hasClient=${client ? 'yes' : 'no'} keepStatus=${opts.keepStatus ? 'yes' : 'no'} announceOffline=${opts.announceOffline === false ? 'no' : 'yes'} offlineTimeoutMs=${opts.offlineTimeoutMs ?? DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS}`,
  );
  // currentStatus === 'connected' 时一定发; 'reconnecting' 时也发 —— 关闭应用
  // 时 SDK 可能在 close() 之前先记录一条 reconnect 日志, 导致状态切到
  // 'reconnecting', 若只检查 'connected' 则 offline 通知会静默丢失。
  if (
    opts.announceOffline !== false &&
    client &&
    (currentStatus === 'connected' || currentStatus === 'reconnecting')
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
      `[feishu/wsClient] offline announcement skipped status=${currentStatus} hasClient=${client ? 'yes' : 'no'}`,
    );
  }
  if (client) {
    try {
      log.info('[feishu/wsClient] closing WS client');
      client.close({ force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[feishu/wsClient] close threw: ${msg}`);
    }
    client = null;
  }
  if (detector) {
    detector.abandon();
    detector = null;
  }
  outbound.unbindClient();
  if (!opts.keepStatus) {
    currentBotAppId = null;
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

  if (phase === 'offline') pendingOfflineNotice = true;

  if (!lifecycleAnnouncementEnabled) {
    log.info(`[feishu/wsClient] announceLifecycle ${phase}: message suppressed by setting`);
    return;
  }

  const text =
    phase === 'online'
      ? transportMessages.lifecycle.online
      : transportMessages.lifecycle.offline;
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
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

async function handleIncomingMessage(
  botAppId: string,
  data: RawMessageEvent,
): Promise<void> {
  const log = getLog();
  if (!acceptingInbound) {
    log.info('[feishu/wsClient] drop inbound message while connection is stopping');
    return;
  }
  if (!data?.message || !data?.sender) {
    log.warn(
      `[feishu/wsClient] DROP early: hasMessage=${!!data?.message} hasSender=${!!data?.sender}`,
    );
    return;
  }

  // p2p only
  if (data.message.chat_type !== 'p2p') {
    log.info(
      `[feishu/wsClient] drop non-p2p chat_type=${data.message.chat_type}`,
    );
    return;
  }

  const senderOpenId = data.sender.sender_id?.open_id;
  const messageId = data.message.message_id;
  const chatId = data.message.chat_id;
  const msgType = data.message.message_type ?? '';
  const rawContent = data.message.content ?? '';
  if (!senderOpenId || !messageId || !chatId) return;

  // TOFU: first p2p sender becomes owner. Send welcome and continue
  // processing this very message (so the user's first ask isn't lost).
  if (ownerGuard.tryClaimOwner(senderOpenId)) {
    log.info(`[feishu/wsClient] TOFU: claimed owner ...${senderOpenId.slice(-8)}`);
    try {
      await outbound.sendText(senderOpenId, transportMessages.ownerBinding.welcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/wsClient] TOFU welcome send failed (non-fatal): ${msg}`);
    }
  }

  // whitelist gate
  if (!ownerGuard.check(senderOpenId)) {
    log.warn(`[feishu/wsClient] drop non-whitelisted sender ...${senderOpenId.slice(-8)}`);
    return;
  }

  if (pendingOfflineNotice) {
    pendingOfflineNotice = false;
    try {
      await outbound.sendText(senderOpenId, transportMessages.lifecycle.offlineNotice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/wsClient] offlineNotice send failed (non-fatal): ${msg}`);
    }
  }

  const parsed = parseIncoming(msgType, rawContent);
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

  // Drop entirely only when there's literally nothing to relay.
  if (!parsed.text && attachments.length === 0 && unsupported.length === 0) {
    return;
  }

  // Emit raw fields — orchestrator decides how to render unsupported (it owns
  // the user-facing wording and the "skip agent for pure-unsupported" rule).
  feishuEvents.emit('message', {
    channelName: 'feishu',
    senderId: senderOpenId,
    chatId,
    contextId: botAppId,
    messageId,
    text: parsed.text,
    attachments,
    unsupported,
    raw: data,
  });
}

async function handleCardAction(data: unknown): Promise<unknown> {
  const log = getLog();
  if (!acceptingInbound) {
    log.info('[feishu/wsClient] drop card action while connection is stopping');
    return {};
  }
  let parsedOk = false;
  try {
    const event = parseCardAction({ raw: data });
    if (event) {
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
  return parsedOk
    ? { toast: { type: 'success', content: '已收到您的选择' } }
    : {};
}
