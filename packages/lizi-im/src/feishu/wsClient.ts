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
import { getLog } from './moduleScope.js';
import { messages as transportMessages } from './messages.js';
import type { BotCredentials, FeishuConnectionStatus } from './internal-types.js';

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

/**
 * 本 bot 在自己 app 视角下的 open_id — 群消息判 @ 用(mentions[].id.open_id
 * 对比)。连接成功后从 /open-apis/bot/v3/info 拉取; null = 未知, 此时群消息
 * 一律丢弃(惰性失效, 不影响私聊)。换凭证/断开时清空。
 */
let botOpenId: string | null = null;

/** 非 owner 群 @ 的礼貌回应 per-user 冷却(open_id → 上次回应 ts)。 */
const STRANGER_NOTICE_COOLDOWN_MS = 60_000;
const strangerNoticeAt = new Map<string, number>();

const DEFAULT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 1500;
export const QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS = 4500;

// The SDK disables its ping watchdog when this value is omitted. Keep the
// timeout finite so a locally OPEN but silent connection is forced through the
// existing reconnect flow instead of dropping inbound messages indefinitely.
const FEISHU_WS_PING_TIMEOUT_SECONDS = 30;

function emitRendererStatus(error?: string): void {
  feishuEvents.emit('status', {
    status: currentStatus,
    error,
    botAppId: currentBotAppId,
    ownerOpenId: ownerGuard.firstAllowed() ?? storage.readOwnerOpenId(),
  });
}

function setStatus(status: FeishuConnectionStatus, error?: string): void {
  currentStatus = status;
  emitRendererStatus(error);
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
      botOpenId = openId;
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
  botOpenId = openId;
}

const FEISHU_CONFLICT_ERROR = '该 App 已被另一台设备占用 (exceed_conn_limit)';

function isConflictSignal(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('1000040350') || normalized.includes('exceed_conn_limit');
}

function isActiveConnection(generation: number, appId: string): boolean {
  return acceptingInbound && lifecycleGeneration === generation && currentBotAppId === appId;
}

async function transitionToConflict(generation: number, appId: string): Promise<void> {
  if (conflictTransitionGeneration === generation || !isActiveConnection(generation, appId)) {
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
  if (activeDetector.getVerdict()?.kind === 'connected' && currentStatus !== 'connected') {
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
  if (activeDetector.getVerdict()?.kind !== 'conflict' && currentStatus === 'connected') {
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
  if (activeDetector.getVerdict()?.kind === 'connected' && currentStatus !== 'connected') {
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

  const startDetector = new ConflictDetector({
    readyTimeoutMs: 8000,
    reconnectThreshold: 2,
  });
  detector = startDetector;

  client = new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: creds.service === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    wsConfig: {
      pingTimeout: FEISHU_WS_PING_TIMEOUT_SECONDS,
    },
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
      void fetchBotOpenId();
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
  botOpenId = null;
  strangerNoticeAt.clear();
  outbound.unbindClient();
  if (opts.clearOwnerBeforeIdle) {
    pendingOfflineNotice = false;
    ownerGuard.clear();
  }
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
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 群消息是否 @ 到本 bot。botOpenId 未知恒 false(群功能惰性失效)。 */
function mentionsSelf(
  mentions: NonNullable<RawMessageEvent['message']>['mentions'],
  selfOpenId: string | null,
): boolean {
  if (!selfOpenId || !mentions) return false;
  return mentions.some((m) => m.id?.open_id === selfOpenId);
}

async function handleIncomingMessage(botAppId: string, data: RawMessageEvent): Promise<void> {
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

  const chatType = data.message.chat_type;
  if (chatType !== 'p2p' && chatType !== 'group') {
    log.info(`[feishu/wsClient] drop unsupported chat_type=${chatType}`);
    return;
  }
  const isGroup = chatType === 'group';

  const senderOpenId = data.sender.sender_id?.open_id;
  const messageId = data.message.message_id;
  const chatId = data.message.chat_id;
  const msgType = data.message.message_type ?? '';
  const rawContent = data.message.content ?? '';
  if (!senderOpenId || !messageId || !chatId) return;

  if (isGroup) {
    // 没 @ 到本 bot 的群消息一律丢(bot open_id 未知时也丢 — 惰性失效)。
    if (!mentionsSelf(data.message.mentions, botOpenId)) return;
    // 群里绝不 TOFU 认主(钉钉同款): 没有 owner 时群消息全丢。
    if (!ownerGuard.firstAllowed()) {
      log.info('[feishu/wsClient] drop group mention: no owner bound yet');
      return;
    }
    // 非 owner @bot → 礼貌回应(per-user 冷却), 不起 turn。
    if (!ownerGuard.check(senderOpenId)) {
      const last = strangerNoticeAt.get(senderOpenId) ?? 0;
      if (Date.now() - last >= STRANGER_NOTICE_COOLDOWN_MS) {
        strangerNoticeAt.set(senderOpenId, Date.now());
        try {
          await outbound.replyText(messageId, transportMessages.group.strangerNotice);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[feishu/wsClient] stranger notice failed (non-fatal): ${msg}`);
        }
      }
      return;
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

  // 群消息: 剥 @bot 占位符、其他 @ 转显示名。
  const text =
    isGroup && data.message.mentions && botOpenId
      ? resolveMentionPlaceholders(parsed.text, data.message.mentions, botOpenId)
      : parsed.text;

  // Drop entirely only when there's literally nothing to relay.
  if (!text && attachments.length === 0 && unsupported.length === 0) {
    return;
  }

  // 群 lane: senderId = g/{chatId}[/{threadId}], 出站按 lane 解码回群;
  // 记录回挂锚点让本轮回复(引用式)挂回触发消息(话题内回复顺带落回话题)。
  const laneUserId = isGroup
    ? encodeLaneUserId(chatId, data.message.thread_id)
    : null;
  if (laneUserId) {
    outbound.pushReplyAnchor(laneUserId, messageId);
  }

  // Emit raw fields — orchestrator decides how to render unsupported (it owns
  // the user-facing wording and the "skip agent for pure-unsupported" rule).
  feishuEvents.emit('message', {
    channelName: 'feishu',
    senderId: laneUserId ?? senderOpenId,
    chatId,
    contextId: botAppId,
    messageId,
    text,
    ...(laneUserId
      ? {
          // 群轮次必带 speaker — 共享层以它识别群轮(强确认策略/命令主人门)。
          // 触发人恒为 owner(上面的门已保证), name 留空(飞书事件不带显示名)。
          speaker: { id: senderOpenId, name: '', isOwner: true },
        }
      : {}),
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
  return parsedOk ? { toast: { type: 'success', content: '已收到您的选择' } } : {};
}
