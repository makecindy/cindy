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
 *       → 连接换代门禁: 处理途中的 await(附件下载/开话题)之后复查
 *         isActiveConnection(generation, botAppId) — 断开/换账号的旧连接轮次
 *         直接丢弃, 不 push 锚点、不 emit, 不会路由进新账号的 client/session
 *       → 群主流 @ 开话题三态(opened / degraded / orphaned):
 *         opened → 新话题 lane; degraded → 降级群 lane 旧行为; orphaned →
 *         回复开场白(落回话题)说明失败并放弃本轮, 不降级刷群主流
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

/**
 * 开场白孤立(话题 id 不可恢复且撤回失败)时回复开场白说明失败 — per-opener
 * 冷却(开场白消息 id → 上次提示 ts)防重投事件重复提示。回复挂在开场白下
 * 自动落回话题, 不惊动群主流。
 *
 * 提示发送失败时: 释放入站认领(重推若来可重新处理)并**主动调度递增间隔的
 * 延迟重试** — 飞书长连接对「处理 3s 内完成」的事件直接 ACK 不再重推, 只靠
 * 释放认领等重推不可靠, 用户会永久看着「思考中」的开场白卡等不到说明。
 * 每次重试前 gate 到触发时的 connection generation — 换代后旧账号的开场白
 * 不会发进新账号的会话。重试由定时器执行, 不经过本函数的冷却(重推在冷却期
 * 内到达会被拦截, 不会双发); 3 次重试(总窗口 ~2 分钟)全失败后放弃 —
 * 再长的故障窗口里平台重推同样无效, 无限重试只会让定时器跨连接悬挂。
 */
const ORPHAN_NOTICE_COOLDOWN_MS = 60_000;
const orphanNoticeAt = new Map<string, number>();

/**
 * 提示**成功送达**的 opener 集合。与 orphanNoticeAt 分离: 后者在发送前
 * 就 set(表达「最近一次尝试」, 失败不回溯), 前者只在成功路径加入 —
 * 送达是终态事实, 不随时间失效: 重试链用它判断「提示已由其它路径送达,
 * 本链应收尾」, 挂起超 60s 的旧重试失败时同样成立。stop() 清空, 并有
 * 容量上限(孤儿事件每次一个 opener, 进程内不会无界增长)。
 */
const ORPHAN_DELIVERED_MAX_ENTRIES = 200;
const orphanNoticeDelivered = new Set<string>();

function markNoticeDelivered(openerMessageId: string): void {
  orphanNoticeDelivered.add(openerMessageId);
  while (orphanNoticeDelivered.size > ORPHAN_DELIVERED_MAX_ENTRIES) {
    const oldest = orphanNoticeDelivered.values().next().value;
    if (typeof oldest !== 'string') break;
    orphanNoticeDelivered.delete(oldest);
  }
}

/** 重试间隔按尝试次数递增 — attempt 0 用首个间隔, 超出数组则放弃。 */
const ORPHAN_NOTICE_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const;

interface PendingOrphanRetry {
  timer: ReturnType<typeof setTimeout>;
  botAppId: string;
  generation: number;
  openerMessageId: string;
  /** 触发消息 id — 重试成功时重新认领, 抑制冷却后的重投再次进入提示流程。 */
  messageId: string;
}

const orphanNoticeRetries = new Map<string, PendingOrphanRetry>();

/** 该 opener 的提示是否已成功送达过(首发/重投/重试任一成功 — 终态)。 */
function wasNoticeDelivered(openerMessageId: string): boolean {
  return orphanNoticeDelivered.has(openerMessageId);
}

/**
 * 该 opener 当前**正在执行**的提示发送(in-flight 去重)。重试的 timer 条目
 * 在 setTimeout 回调里先删后发 — 仅凭 orphanNoticeRetries 看不到执行中的
 * 发送; 这里单独记账, 任何路径的发送开始前先查: 冷却后的重投不会与执行
 * 中的重试并发发出第二条提示。结果在所有等待者间共享 — 谁发起都只有一条。
 */
const orphanNoticeInFlight = new Map<string, Promise<'delivered' | 'failed'>>();

/**
 * 发送孤儿提示(单一 in-flight): 同一 opener 并发进入时共享同一次发送结果,
 * 不会打出第二条。成功即标记送达(终态); 失败返回 'failed' 由调用方决定
 * 释放认领/安排重试。
 */
function sendOrphanNoticeOnce(
  openerMessageId: string,
): Promise<'delivered' | 'failed'> {
  const inFlight = orphanNoticeInFlight.get(openerMessageId);
  if (inFlight) return inFlight;
  const log = getLog();
  const attempt = (async (): Promise<'delivered' | 'failed'> => {
    try {
      await outbound.replyText(openerMessageId, transportMessages.group.threadOrphanNotice);
      markNoticeDelivered(openerMessageId);
      log.info('[feishu/wsClient] orphan opener notice delivered');
      return 'delivered';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/wsClient] orphan opener notice send failed: ${msg}`);
      return 'failed';
    }
  })();
  // set 与 get 在同一同步块内完成 — 并发调用不会双双通过(JS 单线程)。
  orphanNoticeInFlight.set(openerMessageId, attempt);
  return attempt.finally(() => {
    // 结果已共享给所有等待者后才清理; 幂等删除, 早到的 finally 不影响
    // 已经持有 promise 引用的等待者。
    orphanNoticeInFlight.delete(openerMessageId);
  });
}

async function sendOrphanOpenerNotice(
  botAppId: string,
  messageId: string,
  openerMessageId: string,
  generation: number,
): Promise<void> {
  const log = getLog();
  // 终态守卫: 提示已送达过(执行中重试/重投任一成功)则不再发送 — 这次投递
  // 不产出可见结果, 释放本次认领。
  if (wasNoticeDelivered(openerMessageId)) {
    releaseInboundClaim(botAppId, messageId);
    return;
  }
  const last = orphanNoticeAt.get(openerMessageId) ?? 0;
  if (Date.now() - last < ORPHAN_NOTICE_COOLDOWN_MS) {
    // 冷却命中(重投场景): 这次投递不产出任何可见结果 — 释放本次认领, 否则
    // 冷却期间的 claim 会卡满 10 分钟, 换代后新连接的重投被丢弃(stop 已清掉
    // 定时重试), 用户的 @ 就丢了。
    releaseInboundClaim(botAppId, messageId);
    return;
  }
  orphanNoticeAt.set(openerMessageId, Date.now());
  // in-flight 去重: 执行中的重试会与这里共享同一次发送 — 重投不并发打出
  // 第二条提示; 结果为共享, 送达/失败按共享结果处理。
  const outcome = await sendOrphanNoticeOnce(openerMessageId);
  if (outcome === 'delivered') {
    // 送达: 重新认领触发消息(后续重投被入站去重拦下) + 清掉该 opener 的
    // 挂起重试(重试绕过冷却, 不清会在稍后重复提示, 甚至重试耗尽时误撤回)。
    claimInboundMessage(botAppId, messageId);
    const pending = orphanNoticeRetries.get(openerMessageId);
    if (pending) {
      clearTimeout(pending.timer);
      orphanNoticeRetries.delete(openerMessageId);
    }
  } else {
    releaseInboundClaim(botAppId, messageId);
    log.warn(
      '[feishu/wsClient] orphan opener notice failed — inbound claim released, retry scheduled',
    );
    scheduleOrphanNoticeRetry(botAppId, generation, openerMessageId, messageId, 0);
  }
}

function scheduleOrphanNoticeRetry(
  botAppId: string,
  generation: number,
  openerMessageId: string,
  messageId: string,
  attempt: number,
): void {
  const log = getLog();
  const delay = ORPHAN_NOTICE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    // 提示已由其它路径(重投成功)送达时, 撤回会误删一张已经给出说明的卡 —
    // 跳过撤回, 收尾重试链。
    if (wasNoticeDelivered(openerMessageId)) {
      log.info('[feishu/wsClient] orphan notice already delivered — skipping opener recall');
      return;
    }
    // gate 到触发连接: 换代/断开后旧账号的开场白卡不得经新 client 撤回
    // (重试耗尽发生在最后那次重试的 replyText 之后 — 期间可能已换代)。
    if (!isActiveConnection(generation, botAppId)) {
      log.info('[feishu/wsClient] orphan opener recall skipped: connection changed');
      return;
    }
    // 重试耗尽: 最后兜底是撤回开场白卡 — 撤回成功用户看到干净群主流而不是
    // 永久「思考中」卡; 撤回失败说明故障仍未恢复, 已无更进一步的兜底手段。
    log.error(
      '[feishu/wsClient] orphan opener notice retries exhausted — recalling opener card as last resort',
    );
    void outbound.recallOwnMessage(openerMessageId);
    return;
  }
  const existing = orphanNoticeRetries.get(openerMessageId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    orphanNoticeRetries.delete(openerMessageId);
    void retryOrphanOpenerNotice(botAppId, generation, openerMessageId, messageId, attempt);
  }, delay);
  orphanNoticeRetries.set(openerMessageId, {
    timer,
    botAppId,
    generation,
    openerMessageId,
    messageId,
  });
}

async function retryOrphanOpenerNotice(
  botAppId: string,
  generation: number,
  openerMessageId: string,
  messageId: string,
  attempt: number,
): Promise<void> {
  const log = getLog();
  // gate 到触发时的连接: 换代/断开后不再重试 — 旧账号的开场白不该发进
  // 新账号的会话(新账号的重推路径会走它自己的 orphaned 处理)。
  if (!isActiveConnection(generation, botAppId)) {
    log.info('[feishu/wsClient] orphan opener notice retry skipped: connection changed');
    return;
  }
  // 提示已由其它路径送达(执行中的重试与重投成功交错) — 放弃整条重试链。
  if (wasNoticeDelivered(openerMessageId)) {
    log.info('[feishu/wsClient] orphan notice already delivered — retry chain dropped');
    return;
  }
  // in-flight 去重: 与冷却后的重投共享同一次发送 — 不会并发打出第二条提示;
  // 若重投的发送已在进行, 这里等待它的结果而不是另发一条。
  const outcome = await sendOrphanNoticeOnce(openerMessageId);
  if (outcome === 'delivered') {
    // 送达: 重新认领触发消息(抑制冷却后的重投再次进入提示流程)。
    claimInboundMessage(botAppId, messageId);
    log.info('[feishu/wsClient] orphan opener notice retry succeeded');
    return;
  }
  // 失败发生在共享发送 await 期间时, 其它路径可能已成功送达 — 先查终态
  // 标记再决定是否继续, 否则会重复提示甚至耗尽后误撤回已成功提示过的卡。
  if (wasNoticeDelivered(openerMessageId)) {
    log.info('[feishu/wsClient] orphan notice delivered during retry — retry chain dropped');
    return;
  }
  log.warn(`[feishu/wsClient] orphan opener notice retry failed (attempt ${attempt})`);
  scheduleOrphanNoticeRetry(botAppId, generation, openerMessageId, messageId, attempt + 1);
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
const seenInboundMessages = new Map<string, number>();

/** true = 本进程没见过这条消息(可以处理); false = 重推, 应当丢弃。 */
function claimInboundMessage(appId: string, messageId: string): boolean {
  const key = `${appId}:${messageId}`;
  const now = Date.now();
  const seenAt = seenInboundMessages.get(key);
  if (seenAt !== undefined && now - seenAt < INBOUND_DEDUPE_TTL_MS) return false;
  // delete + set: Map 对已存在的 key 保留旧插入序, 过期条目刷新后必须重新排到
  // 队尾, 否则下面按插入序淘汰会先砍掉刚刷新的那条。
  seenInboundMessages.delete(key);
  seenInboundMessages.set(key, now);
  for (const [k, ts] of seenInboundMessages) {
    const withinBudget = seenInboundMessages.size <= INBOUND_DEDUPE_MAX_ENTRIES;
    // 插入序 = 时间序, 最老的都没过期且没超量 ⇒ 后面的也不用看。
    if (withinBudget && now - ts < INBOUND_DEDUPE_TTL_MS) break;
    if (k === key) continue;
    seenInboundMessages.delete(k);
  }
  return true;
}

/**
 * 释放某条消息的入站认领 —— 只在「认领了但本轮没有产出任何用户可见结果」的
 * 放弃路径上调用(连接换代丢弃、孤儿开场白提示发送失败), 让重推能在新连接/
 * 重试路径上重新处理。正常处理完(含已给出失败说明的放弃)绝不释放, 否则重推
 * 会再次起 turn。
 */
function releaseInboundClaim(appId: string, messageId: string): void {
  seenInboundMessages.delete(`${appId}:${messageId}`);
}

/**
 * 放弃一条已认领但未产出结果的入站消息(连接换代丢弃路径): 释放去重认领 +
 * evict 开话题结果缓存。只释放认领不 evict 的话, 重投会复用旧连接上的
 * degraded/orphaned 缓存结果(旧客户端已 unbind, 补查/撤回必然失败)而不是
 * 用新客户端重试 API。孤儿提示失败的重试不经过这里 — 复用 orphaned 结果
 * 重试提示正是设计意图。
 */
function abandonInboundTurn(botAppId: string, messageId: string): void {
  releaseInboundClaim(botAppId, messageId);
  outbound.evictOpenThreadOutcome(messageId);
}

/** 测试注入口 — 生产代码不要调用(生产语义就是跨 stop/start 不清空)。 */
export function resetInboundDedupeForTest(): void {
  seenInboundMessages.clear();
}

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
        // 传入本代 connection 的 generation — 处理途中有 await(附件下载/
        // 开话题), 恢复执行时必须复查门禁, 防止旧连接的轮次漏进新连接。
        await handleIncomingMessage(creds.appId, startedGeneration, data as RawMessageEvent);
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
  orphanNoticeAt.clear();
  orphanNoticeDelivered.clear();
  for (const retry of orphanNoticeRetries.values()) clearTimeout(retry.timer);
  orphanNoticeRetries.clear();
  // in-flight 共享发送是连接级状态: 换代后旧发送的共享语义不再有意义
  // (旧 client 的 replyText 会随 close 失败自结, 这里只清记账)。
  orphanNoticeInFlight.clear();
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

async function handleIncomingMessage(
  botAppId: string,
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
  const msgType = data.message.message_type ?? '';
  const rawContent = data.message.content ?? '';
  if (!senderOpenId || !messageId || !chatId) return;

  // 重推闸门 —— 必须在第一个 await 之前同步认领(见 claimInboundMessage), 也必须
  // 排在所有副作用(开话题 / 打表情 / 下附件 / 陌生人提示)之前: 重推一旦漏过去,
  // 这些动作都会再做一遍。
  if (!claimInboundMessage(botAppId, messageId)) {
    log.info(
      `[feishu/wsClient] drop duplicate inbound message ...${messageId.slice(-8)} ` +
        '(feishu re-push; already handled)',
    );
    return;
  }

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

  // 入站门禁复查: 附件下载等 await 期间连接可能已 stop()/换账号换代 — 不复查
  // 会把旧连接的轮次推进新连接的编排状态(锚点污染/跨账号出站)。
  if (!isActiveConnection(generation, botAppId)) {
    // 本轮没有产出任何用户可见结果 — 释放入站认领, 让重推能在新连接上处理。
    abandonInboundTurn(botAppId, messageId);
    log.info('[feishu/wsClient] drop inbound message: connection changed during processing');
    return;
  }

  // 群 lane: senderId = g/{chatId}[/{threadId}], 出站按 lane 解码回群。
  // 话题内触发直接进话题 lane(锚点=触发消息, 回复自动落回话题); 群主流
  // 触发先以触发消息为根开话题再进新话题 lane(锚点=开场白消息) — 每话题
  // 独立 session, 群主流保持干净; 开话题失败才降级回群 lane 旧行为。
  let laneUserId: string | null = null;
  let groupContextLane: { chatId: string; threadId: string } | undefined;
  if (isGroup) {
    const incomingThreadId = data.message.thread_id;
    if (incomingThreadId) {
      laneUserId = encodeLaneUserId(chatId, incomingThreadId);
      outbound.pushReplyAnchor(laneUserId, messageId);
    } else {
      // 群主流的 @ 恒开新话题 —— 群里存在 /ctr 接管也不例外: 接管严格按话题
      // 记账(binding 的 userId 就是话题 lane), 群主流不是任何接管的入口。
      // 拿接管话题去截流群主流消息会让「群里随便 @ 一句」都掉进那条被接管的
      // 会话(用户感知: 不管在哪问, 工作目录都是绑定那个项目)。要跟接管会话
      // 说话就在那个话题里说。
      const opener = await outbound.openThread(messageId);
      // 开话题是一次跨网络的 await — 期间用户可能断开/换账号: 复查门禁,
      // 防止旧连接的锚点与事件漏进新连接(或已停机的编排状态)。
      if (!isActiveConnection(generation, botAppId)) {
        // 话题可能已开但本轮没有 emit — 释放入站认领并 evict 开话题结果缓存,
        // 让重推在新连接上用新客户端重试 API(复用旧缓存会拿到旧客户端上的
        // degraded/orphaned 结果)。
        abandonInboundTurn(botAppId, messageId);
        log.info('[feishu/wsClient] drop group message: connection changed while opening thread');
        return;
      }
      if (opener.kind === 'opened') {
        laneUserId = encodeLaneUserId(chatId, opener.threadId);
        outbound.pushReplyAnchor(laneUserId, opener.messageId);
        // 开场白卡是本轮流式卡: streamingText.start 认领后直接 patch,
        // 话题里不会多出一条占位消息。
        outbound.pushPatchableOpener(laneUserId, opener.messageId);
        // 上下文取数 lane 与路由 lane 分离: 新话题是空的, 群历史前缀仍按
        // 触发时所在的群主流拉取(「总结上面」等依赖上文的消息才能拿到
        // 群主流历史), 由 host adapter 消费(IMMessageEvent.groupContextLane)。
        groupContextLane = { chatId, threadId: '' };
      } else if (opener.kind === 'orphaned') {
        // 开场白卡已发出但话题 id 恢复失败、撤回也失败: 降级群 lane 会一边
        // 留着「思考中」的开场白卡、一边把回答刷进群主流。不起 turn, 回复
        // 开场白(落回话题)说明失败 — 宁可丢一轮, 不误导 + 不刷屏。
        log.error(
          `[feishu/wsClient] openThread orphaned opener=...${opener.openerMessageId.slice(-8)} — turn dropped with in-topic notice`,
        );
        await sendOrphanOpenerNotice(botAppId, messageId, opener.openerMessageId, generation);
        return;
      } else {
        laneUserId = encodeLaneUserId(chatId, null);
        outbound.pushReplyAnchor(laneUserId, messageId);
      }
    }
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
    ...(groupContextLane ? { groupContextLane } : {}),
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
