/**
 * feishu/outbound.ts
 * ---------------------------------------------------------------------------
 * Outbound primitives backed by Lark.Client. Exposes the surface that
 * `FeishuIM` re-exports + a few internal helpers (bindClient / addReaction /
 * removeReaction / patchCardRaw) consumed by sibling modules.
 *
 * Targets: p2p sends use `receive_id_type: 'open_id'`. Group lane userIds
 * (`g/{chatId}[/{threadId}]`, see codec.ts) resolve to a reply anchor
 * (im.message.reply — 话题内自动落回话题) or `receive_id_type: 'chat_id'`.
 *
 * Note (parity gap from legacy replyClient.ts): the inline `xdt-image://` /
 * `xdt-file://` markdown rewriting (upload local images → img element, split
 * out file links into separate file messages) is NOT included here. That
 * behaviour is business-policy and belongs in the host orchestrator. When
 * orchestrator wants to embed images, it should pre-resolve `xdt-image://`
 * URLs to feishu image_keys via `uploadImage` + build the card JSON with
 * `img` elements directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { getLog } from './moduleScope.js';
import { buildInteractiveCardV1, buildMarkdownCardV2 } from './cards.js';
import { decodeLaneUserId } from './codec.js';
import * as ownerGuard from './ownerGuard.js';
import { parseIncoming } from './incomingContent.js';
import type { AttachmentRef } from './incomingContent.js';
import { messages as transportMessages } from './messages.js';
import type {
  IMMessageEvent,
  InteractiveCardSpec,
  SendFileResult,
} from '../types.js';
import type { BotCredentials } from './internal-types.js';

/** 30 MB per file — feishu's upper limit for `im.file.create`. */
const FEISHU_FILE_SIZE_LIMIT = 30 * 1024 * 1024;
/** 10 MB per image when sending as `msg_type:image`. */
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

let client: Lark.Client | null = null;
let creds: BotCredentials | null = null;

/** 最近一次 bind 的账号身份 — 跨 unbind 保留, 用于判「账号是否真替换」。 */
let lastBoundCreds: BotCredentials | null = null;

function sameBoundAccount(next: BotCredentials): boolean {
  return (
    lastBoundCreds !== null &&
    lastBoundCreds.appId === next.appId &&
    lastBoundCreds.service === next.service
  );
}

/**
 * 账号代次 — 账号身份变化(换账号 bind / 明确清凭证)时递增: 在途的排空/兜底
 * 续段据此丢弃, 旧账号的终态不得经新账号的 client 呈现。
 */
let accountEpoch = 0;

function clearAccountScopedOutboundState(): void {
  laneAnchors.clear();
  patchableOpeners.clear();
  openerTriggers.clear();
  clearDeferredOpenerConsumes();
  accountEpoch += 1;
}

/**
 * 明确清除凭证/登出路径(clearAndDisconnect)用: 与 transport 重连区分 —
 * 清掉账号态并重置 lastBoundCreds, 之后重新保存相同 appId/service 不会被
 * 误判为同账号重连(登出前的 opener/锚点不得被新一轮会话认领)。
 */
export function forgetBoundAccount(): void {
  clearAccountScopedOutboundState();
  lastBoundCreds = null;
}

/** 当前账号代次(清凭证递增) — 在途排空续段比对用。 */
export function getAccountEpoch(): number {
  return accountEpoch;
}

export function bindClient(c: BotCredentials): void {
  // 账号真正替换(appId/service 变化)才清开场白卡与话题锚点: 同账号 transport
  // 重连(reconnectSavedCredentials: stop → start 同凭证)时 turn 仍在跑, 未消费
  // 的 opener / 锚点必须仍可被认领, 否则答案无处 patch、话题出站没有 reply 根。
  if (!sameBoundAccount(c)) clearAccountScopedOutboundState();
  lastBoundCreds = c;
  creds = c;
  client = new Lark.Client({
    appId: c.appId,
    appSecret: c.appSecret,
    domain: c.service === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  });
}

export function unbindClient(): void {
  client = null;
  creds = null;
  cardLanes.clear();
  // patchableOpeners / laneAnchors 不随 unbind 清空(见 bindClient 的账号替换清理)。
}

// ── group lane reply anchors ──────────────────────────────────────────────────
// 群 lane 的「答案挂回提问」: wsClient 在 owner 触发时 push 触发消息 id,
// 出站按回合领取(流式建卡时 advance)。话题 lane 的**所有**出站都走 reply
// 锚点 — 被回复消息在话题里, 回复自动落回话题(会话与挂回一次解决);
// 普通群 lane 只有回合首条出站 reply(引用式"挂在提问下"), 后续 chat_id 直发。
// 账号替换时清空 — 同账号 transport 重连保留, 避免进行中的 turn 丢掉话题锚点。

interface LaneAnchorState {
  /** 待领取的触发消息 id FIFO(多条消息先后触发同一 lane 各自排队)。 */
  queue: string[];
  /** 当前回合持有的锚点。 */
  held: string | null;
  /** 普通群: held 是否已用于引用回复(用过则后续 chat_id 直发)。 */
  quotedHeld: boolean;
  /**
   * held 是群主流触发消息(开场白撤回后的回拨锚点)时置位 — 对它 reply 必须带
   * reply_in_thread 才会落回话题(触发消息本人在群主流)。
   */
  inThreadReply: boolean;
}

const laneAnchors = new Map<string, LaneAnchorState>();

/** wsClient 在 owner 群触发时登记回挂锚点。 */
export function pushReplyAnchor(laneUserId: string, messageId: string): void {
  const state = laneAnchors.get(laneUserId) ?? {
    queue: [],
    held: null,
    quotedHeld: false,
    inThreadReply: false,
  };
  state.queue.push(messageId);
  laneAnchors.set(laneUserId, state);
}

// ── patchable opener (开话题开场白卡 = 本轮流式卡) ──────────────────────────
// 群主流 @ 开话题时, 开场白是一张「思考中」占位卡; 本轮流式卡不再新建一条
// 回复, 而是直接 patch 这张卡 — 话题里第一条可见内容就是答案。lane → opener
// 卡的映射由 wsClient 在 openThread 成功后登记, streamingText.start 认领。

const patchableOpeners = new Map<string, string>();

/**
 * 开场白卡对应的触发消息 id(lane → 群主流触发消息)。开场白 patch/替换失败
 * 被撤回后, 话题里不再有合法锚点 — 回拨到触发消息并带 reply_in_thread 回复
 * 才能落回话题(触发消息本人在群主流)。
 */
const openerTriggers = new Map<string, string>();

export function pushPatchableOpener(
  laneUserId: string,
  messageId: string,
  triggerMessageId?: string,
): void {
  patchableOpeners.set(laneUserId, messageId);
  if (triggerMessageId) openerTriggers.set(laneUserId, triggerMessageId);
}

/**
 * 认领本 lane 的开场白卡: 存在则把它推进为已持有锚点(后续 reply 挂它, 仍落
 * 在话题内)并返回消息 id, streamingText.start 拿它直接 patch; 不存在(开话题
 * 失败的降级群 lane / 话题内 @)返回 null, 走新建流式卡的老路。
 */
export function claimPatchableOpener(laneUserId: string): string | null {
  const openerId = patchableOpeners.get(laneUserId);
  if (!openerId) return null;
  patchableOpeners.delete(laneUserId);
  // openerTriggers 保留 — patch/替换失败撤回开场白卡时需要回拨锚点
  // (rearmAnchorToTrigger 消费); 正常认领成功则随下次 push 覆盖或账号替换清空。
  const state = laneAnchors.get(laneUserId) ?? {
    queue: [],
    held: null,
    quotedHeld: false,
    inThreadReply: false,
  };
  // 锚点队列头正常就是这张开场白卡; 对不上说明顺序被破坏, 保守起见仍保留队列。
  if (state.queue[0] === openerId) state.queue.shift();
  state.held = openerId;
  state.quotedHeld = true;
  state.inThreadReply = false;
  laneAnchors.set(laneUserId, state);
  return openerId;
}

/**
 * 重连空窗(outbound client 已解绑)时到达的开场白卡消费暂存 — 同账号重连后
 * 由 FeishuIM 排空(见 drainDeferredOpenerConsumes): 若此时直接认领, 后续
 * patch/撤回全部失败且注册被永久移除; 若完全放弃, 本轮终态丢失且注册残留
 * 会被下一条消息误认领。上限防御, 超限丢最旧。
 */
export type DeferredOpenerConsume = (
  | { userId: string; openerId: string; markdown: string }
  | { userId: string; openerId: string; spec: InteractiveCardSpec }
) & { epoch: number };

const MAX_DEFERRED_OPENER_CONSUMES = 50;
const deferredOpenerConsumes: DeferredOpenerConsume[] = [];

/**
 * 容量淘汰的开场白卡 id — 条目被挤掉时其 opener 已被原子预留(不可再认领),
 * 静默删除会留下永久「思考中」卡: 记录 id, 连接恢复排空时撤回。
 */
// 上限防御撤除: 每个条目只是短消息 id, 且连接恢复排空即清 — 有界淘汰会
// 再次静默丢卡(阈值从 51 推迟到 101 而已), 不留可收口记录违背设计。
const evictedOpeners: string[] = [];

/** 账号替换时清空暂存消费(属旧账号的开场白卡, 新账号不需要)。 */
function clearDeferredOpenerConsumes(): void {
  deferredOpenerConsumes.length = 0;
  evictedOpeners.length = 0;
}

export function deferOpenerConsume(
  entry: { userId: string; openerId: string } & (
    | { markdown: string }
    | { spec: InteractiveCardSpec }
  ),
): void {
  deferredOpenerConsumes.push({ ...entry, epoch: accountEpoch });
  while (deferredOpenerConsumes.length > MAX_DEFERRED_OPENER_CONSUMES) {
    const evicted = deferredOpenerConsumes.shift();
    if (evicted) {
      evictedOpeners.push(evicted.openerId);
    }
  }
}

/** 取出被容量淘汰的开场白卡 id(清空), 连接恢复排空时撤回。 */
export function drainEvictedOpeners(): string[] {
  return evictedOpeners.splice(0, evictedOpeners.length);
}

/** 取出全部暂存的消费(清空), 调用方在连接就绪后排空。 */
export function drainDeferredOpenerConsumes(): DeferredOpenerConsume[] {
  return deferredOpenerConsumes.splice(0, deferredOpenerConsumes.length);
}

/**
 * 取出并移除某 lane 的匹配暂存消费 — 调用方的兜底发送在连接恢复后执行时,
 * 优先就地收口被预留的 opener(见 FeishuIM 的发送包装): patch/替换成功即
 * 不再另发、不留卡; 无匹配返回 undefined。
 */
export function takeMatchingDeferredOpenerConsume(
  userId: string,
  kind: 'markdown' | 'spec',
): DeferredOpenerConsume | undefined {
  for (let i = deferredOpenerConsumes.length - 1; i >= 0; i--) {
    const entry = deferredOpenerConsumes[i]!;
    if (entry.userId !== userId) continue;
    if (kind === 'markdown' && !('markdown' in entry)) continue;
    if (kind === 'spec' && !('spec' in entry)) continue;
    deferredOpenerConsumes.splice(i, 1);
    return entry;
  }
  return undefined;
}

/** 按 openerId 取出暂存消费 — 原兜底发送认领本轮条目, 避免同 lane 后续发送误领。 */
export function takeDeferredOpenerConsumeById(openerId: string): DeferredOpenerConsume | undefined {
  const index = deferredOpenerConsumes.findIndex((entry) => entry.openerId === openerId);
  if (index < 0) return undefined;
  return deferredOpenerConsumes.splice(index, 1)[0];
}

/**
 * 返回该 lane 上 pending opener 的触发消息 id(没有则返回 undefined)。
 * 调用方用它判断「这张思考卡是不是本轮消息创建的」— 空文本终态等场景下
 * 不应消费上一轮遗留的 opener。
 */
export function getOpenerTrigger(laneUserId: string): string | undefined {
  return openerTriggers.get(laneUserId);
}

/**
 * patch/替换失败撤回开场白卡后调用: 把 held 锚点回拨到触发消息(带
 * reply_in_thread 标记)。兜底发送向触发消息 reply 且 reply_in_thread=true,
 * 仍落回话题 — 而不是向已删除的开场白卡 reply 失败。无触发记录返回 false。
 */
export function rearmAnchorToTrigger(laneUserId: string): boolean {
  const triggerId = openerTriggers.get(laneUserId);
  openerTriggers.delete(laneUserId);
  if (!triggerId) return false;
  const state = laneAnchors.get(laneUserId) ?? {
    queue: [],
    held: null,
    quotedHeld: false,
    inThreadReply: false,
  };
  state.held = triggerId;
  state.quotedHeld = true;
  state.inThreadReply = true;
  laneAnchors.set(laneUserId, state);
  return true;
}

type SendTarget =
  | { kind: 'open_id'; id: string }
  | { kind: 'chat_id'; id: string }
  | { kind: 'reply'; messageId: string; replyInThread?: boolean };

/**
 * userId → 本次出站目标。
 *
 * advanceRound = true(流式建卡 — 每个 agent 回合的首条出站)时强制从 FIFO
 * 领取新锚点; 其它出站沿用已持有的锚点, 没有才领取。回合边界 transport 感知
 * 不到, 以「流式建卡」为回合锚点领取点在本编排下成立: agent turn 恒以流式卡
 * 开场, 一次性回复(slash 提示等)则一条消息领取一次。
 */
function resolveSendTarget(userId: string, opts?: { advanceRound?: boolean }): SendTarget | null {
  const lane = decodeLaneUserId(userId);
  if (!lane) return { kind: 'open_id', id: userId };

  const state = laneAnchors.get(userId) ?? {
    queue: [],
    held: null,
    quotedHeld: false,
    inThreadReply: false,
  };
  laneAnchors.set(userId, state);
  // 领取条件: advanceRound(流式建卡 = 新回合)必领; 其余出站只在完全没有
  // 持有时领(首次一次性回复)。回合中途的卡片/文件**不领** — 队列里可能已经
  // 排着下一轮的触发锚点, 中途领取会把下一轮的锚点偷来错挂。队列空时保留
  // held: 话题 lane 复用旧锚点仍落回正确话题(话题内任意消息都是合法锚点)。
  if ((opts?.advanceRound || !state.held) && state.queue.length > 0) {
    state.held = state.queue.shift() ?? null;
    state.quotedHeld = false;
    state.inThreadReply = false;
  }

  if (lane.threadId) {
    // 话题 lane: 必须 reply 锚点才能落回话题; 没有锚点宁可失败也不能把
    // 消息发进群主流(位置错误比丢失更糟)。held 是回拨的群主流触发消息时
    // 带 reply_in_thread 回复才能落回话题。
    return state.held
      ? { kind: 'reply', messageId: state.held, replyInThread: state.inThreadReply || undefined }
      : null;
  }
  if (state.held && !state.quotedHeld) {
    state.quotedHeld = true;
    return { kind: 'reply', messageId: state.held };
  }
  return { kind: 'chat_id', id: lane.chatId };
}

/** 统一出站: target 三形态 → message.create(open_id/chat_id) 或 message.reply。 */
async function createMessage(
  target: SendTarget,
  msgType: string,
  content: string,
): Promise<{ messageId: string }> {
  const c = ensureClient();
  if (target.kind === 'reply') {
    const res = await c.im.v1.message.reply({
      path: { message_id: target.messageId },
      data: {
        content,
        msg_type: msgType,
        // 回拨到群主流触发消息的锚点: 必须 reply_in_thread 才落回话题。
        ...(target.replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    const id = res.data?.message_id ?? '';
    if (!id) throw new Error('[feishu/outbound] reply: no message_id in response');
    return { messageId: id };
  }
  const res = await c.im.v1.message.create({
    params: { receive_id_type: target.kind },
    data: { receive_id: target.id, msg_type: msgType, content },
  });
  const id = res.data?.message_id ?? '';
  if (!id) throw new Error('[feishu/outbound] create: no message_id in response');
  return { messageId: id };
}

function requireSendTarget(userId: string, opts?: { advanceRound?: boolean }): SendTarget {
  const target = resolveSendTarget(userId, opts);
  if (!target) {
    throw new Error(
      `[feishu/outbound] no reply anchor for topic lane ...${userId.slice(-8)} — message dropped`,
    );
  }
  return target;
}

export function getBoundClient(): Lark.Client | null {
  return client;
}

export function getBoundCreds(): BotCredentials | null {
  return creds;
}

function ensureClient(): Lark.Client {
  if (!client)
    throw new Error('[feishu/outbound] Lark.Client not bound — feishu connection not established');
  return client;
}

// ── basic text ────────────────────────────────────────────────────────────────

export async function sendText(userId: string, text: string): Promise<{ messageId: string }> {
  return createMessage(requireSendTarget(userId), 'text', JSON.stringify({ text }));
}

/** 直接回复某条消息(非 owner 群 @ 的礼貌回应等 — 不走 lane 锚点)。 */
export async function replyText(
  replyToMessageId: string,
  text: string,
): Promise<{ messageId: string }> {
  return createMessage(
    { kind: 'reply', messageId: replyToMessageId },
    'text',
    JSON.stringify({ text }),
  );
}

// ── openThread (群主流 @ 开话题) ────────────────────────────────────────────
// 开话题对同一触发消息幂等: 飞书可能重复投递同一条群主流 @ 事件(WS 重连等),
// 不合并就会同一条消息开出多个话题、重复 agent 回答。进行中的请求共享同一
// promise, 已完成的按 TTL 短缓存 — 重投事件直接复用同一个话题。缓存键是
// 触发消息 id(平台内唯一), 不随 unbindClient 清空(换代不会重放别的消息 id)。

/** 开话题结果 — 调用方按状态决定路由与降级(见 openThread 文档)。 */
export type OpenThreadOutcome =
  /** 话题已开, 开场白 messageId + threadId 都是话题内合法锚点/身份。 */
  | { kind: 'opened'; messageId: string; threadId: string }
  /** 无可确认已发出的开场白(API 失败/无 id, 或已成功撤回) — 可降级群 lane。 */
  | { kind: 'degraded' }
  /**
   * 开场白已发出但 thread_id 恢复失败、撤回也失败 — 开场白孤立在话题里。
   * 降级群 lane 会一边留着「思考中」的开场白卡、一边把回答刷进群主流;
   * 调用方应回复开场白(落回话题)说明失败并放弃本轮, 而不是降级。
   */
  | { kind: 'orphaned'; openerMessageId: string }
  /**
   * reply 在超时/断线后用同一 uuid 有界重试仍拿不到回执 — 服务端可能已经
   * 发出「思考中」卡。不能降级群 lane(会刷屏 + 留卡), 调用方应放弃本轮
   * 并 evict 缓存, 让重投再用同一 uuid 取回原 message_id/thread_id。
   */
  | { kind: 'unconfirmed' };

const OPEN_THREAD_DEDUP_TTL_MS = 10 * 60_000;
const OPEN_THREAD_DEDUP_MAX_ENTRIES = 200;
/** 超时/断线后用同一 uuid 再打 reply 的次数(不含首次)。 */
const OPEN_THREAD_UNCERTAIN_RETRIES = 2;
const openThreadByTrigger = new Map<
  string,
  { ts: number; promise: Promise<OpenThreadOutcome> }
>();

function pruneOpenThreadDedup(): void {
  const now = Date.now();
  for (const [triggerId, entry] of openThreadByTrigger) {
    if (now - entry.ts > OPEN_THREAD_DEDUP_TTL_MS) openThreadByTrigger.delete(triggerId);
  }
  while (openThreadByTrigger.size > OPEN_THREAD_DEDUP_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [triggerId, entry] of openThreadByTrigger) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = triggerId;
      }
    }
    if (oldestKey === undefined) break;
    openThreadByTrigger.delete(oldestKey);
  }
}

/**
 * 以 reply_in_thread 回复触发消息, 用它作为根开一个新话题。开场白**就是
 * 本轮流式卡**: 发一张「思考中」占位卡片(message 可被 patch 升级成正文),
 * 之后流式卡直接 patch 它 — 话题里不会多出一条「开个话题聊这条」的占位
 * 消息, 第一条可见内容就是答案本身(streamingText.start 经
 * claimPatchableOpener 认领)。返回 opened / degraded / orphaned / unconfirmed
 * (见类型注释)。同一触发消息并发/重复调用
 * 共享同一次开话题 — 防飞书重投事件开出多个话题(含进程重启: uuid 走服务端
 * 去重)。
 *
 * 失败语义: API 失败或响应缺 message_id → degraded(没有可确认已发出的开场白);
 * 响应有 message_id 但缺 thread_id → 用 message.get 补查话题 id; 查不到就
 * 撤回开场白 — 撤回成功 → degraded, 撤回失败(含业务错误码)→ orphaned。
 * reply 超时/断线等不确定错误 → 同一 uuid 有界重试取回原消息; 仍无回执 →
 * unconfirmed(不降级)。任何状态都不出现「开场白可见但回答进群主流」。
 */
export function openThread(replyToMessageId: string): Promise<OpenThreadOutcome> {
  const now = Date.now();
  const cached = openThreadByTrigger.get(replyToMessageId);
  if (cached && now - cached.ts <= OPEN_THREAD_DEDUP_TTL_MS) return cached.promise;

  const promise = doOpenThread(replyToMessageId).then((outcome) => {
    // unconfirmed 不是稳定结论: 清掉缓存, 重投再用同一 uuid 取回原消息。
    if (outcome.kind === 'unconfirmed') openThreadByTrigger.delete(replyToMessageId);
    return outcome;
  });
  openThreadByTrigger.set(replyToMessageId, { ts: now, promise });
  pruneOpenThreadDedup();
  return promise;
}

/**
 * 移除某触发消息的开话题结果缓存 — 只在「放弃本轮、期待重投重试」的路径
 * 调用(连接换代丢弃时与入站认领释放配套)。不 evict 的话, 重投会复用旧连接
 * 上的 degraded/orphaned 结果(旧客户端已 unbind, 补查/撤回必然失败), 而不是
 * 用新客户端重试 API。孤儿提示失败的重试路径不 evict — 复用 orphaned 结果
 * 重试提示正是设计意图。
 */
export function evictOpenThreadOutcome(replyToMessageId: string): void {
  openThreadByTrigger.delete(replyToMessageId);
}

/**
 * 用指定 client 撤回 bot 自己发的消息 — patch/替换失败路径把撤回 pin 到
 * 触发账号: 中途换凭证时不得拿新账号的 client 删除旧账号的开场白。
 */
/** 飞书 REST 2xx 仍可能带非零业务码; SDK 对此不抛。缺省或 0 才算成功。 */
function feishuBusinessRejectReason(res: { code?: number; msg?: string }): string | null {
  if (res.code === undefined || res.code === 0) return null;
  return res.msg ? `${res.msg} (code=${res.code})` : `code=${res.code}`;
}

export async function recallOwnMessageWith(
  c: Lark.Client,
  messageId: string,
): Promise<boolean> {
  const log = getLog();
  try {
    const res = await c.im.v1.message.delete({ path: { message_id: messageId } });
    const rejected = feishuBusinessRejectReason(res);
    if (rejected) {
      log.warn(`[feishu/outbound] recallOwnMessage rejected: ${rejected}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] recallOwnMessage failed: ${msg}`);
    return false;
  }
}

/**
 * 撤回 bot 自己发的消息(孤儿开场白卡重试耗尽后的最后兜底)。返回是否成功;
 * 失败只 log — 撤回成功用户看到干净群主流而不是永久「思考中」卡, 撤回失败
 * 说明故障仍未恢复, 已无更进一步的兜底手段。
 */
export async function recallOwnMessage(messageId: string): Promise<boolean> {
  return recallOwnMessageWith(ensureClient(), messageId);
}

/** reply 抛错是否「结果不确定」: 请求可能已在服务端落地, 不能立刻假定没发。 */
function isUncertainOpenThreadError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const hay = `${name} ${code} ${msg}`.toLowerCase();
  return /timeout|timed?\s*out|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|epipe|socket hang up|network|fetch failed|aborted|und_err/.test(
    hay,
  );
}

async function replyOpenThread(
  c: Lark.Client,
  replyToMessageId: string,
): Promise<{ messageId: string; threadId: string } | 'degraded' | 'unconfirmed'> {
  const log = getLog();
  const maxAttempts = 1 + OPEN_THREAD_UNCERTAIN_RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await c.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content: JSON.stringify(buildMarkdownCardV2(transportMessages.streaming.randomThinking())),
          msg_type: 'interactive',
          reply_in_thread: true,
          // 服务端幂等键: 同一触发消息重复开话题(重投事件、进程重启后重放)时,
          // 飞书按 uuid 去重(1 小时内同 uuid 至多发一条, 重复调用返回原消息
          // id), 不会开出第二个话题。超时后用同一 uuid 重试即可取回原消息。
          uuid: replyToMessageId,
        },
      });
      const messageId = res.data?.message_id ?? '';
      const threadId = res.data?.thread_id ?? '';
      if (!messageId) {
        log.warn(
          '[feishu/outbound] openThread: no message_id in response — nothing provably sent',
        );
        return 'degraded';
      }
      return { messageId, threadId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const uncertain = isUncertainOpenThreadError(err);
      if (uncertain && attempt < maxAttempts) {
        log.warn(
          `[feishu/outbound] openThread reply uncertain (retry ${attempt}/${OPEN_THREAD_UNCERTAIN_RETRIES} with same uuid): ${msg}`,
        );
        continue;
      }
      if (uncertain) {
        log.warn(
          `[feishu/outbound] openThread reply unconfirmed after ${maxAttempts} attempts — not degrading: ${msg}`,
        );
        return 'unconfirmed';
      }
      log.warn(`[feishu/outbound] openThread failed (fallback to group lane): ${msg}`);
      return 'degraded';
    }
  }
  return 'unconfirmed';
}

async function doOpenThread(replyToMessageId: string): Promise<OpenThreadOutcome> {
  const log = getLog();
  // 全程 pin 到触发时的 client: reply / message.get / message.delete 都用
  // 同一个实例。中途换账号(unbindClient + bindClient 新凭证)时, 补查与
  // 撤回仍走创建开场白的那条连接 — 不会经新账号的 client 操作旧消息。
  let c: Lark.Client;
  try {
    c = ensureClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] openThread failed (fallback to group lane): ${msg}`);
    return { kind: 'degraded' };
  }
  const replied = await replyOpenThread(c, replyToMessageId);
  if (replied === 'degraded') return { kind: 'degraded' };
  if (replied === 'unconfirmed') return { kind: 'unconfirmed' };
  const { messageId, threadId } = replied;
  if (threadId) return { kind: 'opened', messageId, threadId };
  // 部分成功: 开场白已发出但响应缺 thread_id — 补查消息详情恢复话题 id。
  const recovered = await tryFetchMessageThreadId(c, messageId);
  if (recovered) return { kind: 'opened', messageId, threadId: recovered };
  // 恢复不了: 撤回开场白再降级, 避免「思考中」的开场白卡留在群里误导。
  try {
    const del = await c.im.v1.message.delete({
      path: { message_id: messageId },
    });
    // SDK 对业务错误不抛异常, 2xx 响应也可能带非零 code — 只有 code 缺省
    // 或为 0 才算撤回成功, 否则开场白卡仍在群里, 降级会制造误导组合。
    if (del.code !== undefined && del.code !== 0) {
      log.error(
        `[feishu/outbound] openThread: opener recall rejected (code=${del.code}) — opener orphaned: ${del.msg ?? ''}`,
      );
      return { kind: 'orphaned', openerMessageId: messageId };
    }
    log.warn(
      '[feishu/outbound] openThread: thread_id unrecoverable — opener recalled, fallback to group lane',
    );
    return { kind: 'degraded' };
  } catch (err) {
    // 撤回也失败: 开场白卡孤立在话题里 — 宁可让调用方放弃本轮(回复开场白
    // 说明失败), 也不能降级群 lane 制造「开场白可见 + 回答刷群主流」。
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      `[feishu/outbound] openThread: thread_id unrecoverable and opener recall failed — opener orphaned: ${msg}`,
    );
    return { kind: 'orphaned', openerMessageId: messageId };
  }
}

/** 用 message.get 补查开场白消息的 thread_id(部分成功恢复);失败返回 ''。 */
async function tryFetchMessageThreadId(c: Lark.Client, messageId: string): Promise<string> {
  const log = getLog();
  try {
    const res = await c.im.v1.message.get({ path: { message_id: messageId } });
    return res.data?.items?.[0]?.thread_id ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] openThread: thread_id recovery via message.get failed: ${msg}`);
    return '';
  }
}

// ── reactions (used by host orchestrator to ack user msgs) ────────────────────

/**
 * 给消息加一个表情回复,返回 reaction_id 供后续 removeReaction 使用。
 * - 失败 swallow,返 null(emoji ack 是 nice-to-have,不应阻塞主流程)。
 * - 飞书规则:只有原始添加者(此处是 bot 自己)能删除该 reaction,所以
 *   reaction_id 必须配对持有,跨进程/重启不可恢复 → 调用方负责短期持有。
 */
export async function addReaction(messageId: string, emojiType: string): Promise<string | null> {
  const log = getLog();
  try {
    const res = await ensureClient().im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    return (res as { data?: { reaction_id?: string } }).data?.reaction_id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] addReaction failed (non-fatal): ${msg}`);
    return null;
  }
}

/**
 * 撤销之前 addReaction 返回的 reaction_id 对应的表情。
 * 失败 swallow,因为这是 ack 的清理动作,不应影响 turn 结束流程。
 */
export async function removeReaction(messageId: string, reactionId: string): Promise<void> {
  const log = getLog();
  try {
    await ensureClient().im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] removeReaction failed (non-fatal): ${msg}`);
  }
}

// ── interactive cards ─────────────────────────────────────────────────────────

// ── card lane registry (发卡登记 messageId → lane) ────────────────────────────
// 卡片回调(card.action.trigger)的 context 只带 open_message_id / open_chat_id,
// 不带话题 thread_id — 编排层按 (bot, senderId) 记 /ctr 锁与接管 binding, 消息
// 侧 senderId 是群话题 lane(g/{chatId}/{threadId}), 回调侧只有 operator.open_id,
// 键对不上会让 /ctr 锁永远清不掉。发往 lane 的卡在发送成功后把 messageId 登记
// 回发卡 lane, 回调时反查归一成同一条 lane;私聊卡(open_id)与改投 owner DM 的卡
// 不登记, 回调保持 open_id。飞书卡片回调有效期 30 天, 过期条目不会再有点击,
// 按 31 天 TTL + 上限淘汰;unbindClient 清空(卡片回调不跨连接认领旧卡)。

const CARD_LANE_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const CARD_LANE_MAX_ENTRIES = 512;
const cardLanes = new Map<string, { ts: number; lane: string }>();

function pruneCardLanes(): void {
  const now = Date.now();
  for (const [messageId, entry] of cardLanes) {
    if (now - entry.ts > CARD_LANE_TTL_MS) cardLanes.delete(messageId);
  }
  while (cardLanes.size > CARD_LANE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [messageId, entry] of cardLanes) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = messageId;
      }
    }
    if (oldestKey === undefined) break;
    cardLanes.delete(oldestKey);
  }
}

/** 发卡成功后在 lane 通道登记 card messageId → laneUserId;私聊发送不登记。 */
/** 登记交互卡的发卡 lane(按钮回调 resolveCardLane 反查用)。 */
export function registerCardLane(userId: string, messageId: string): void {
  if (!decodeLaneUserId(userId)) return;
  cardLanes.set(messageId, { ts: Date.now(), lane: userId });
  pruneCardLanes();
}

/**
 * 按卡片回调的 open_message_id 反查发卡 lane。chatId 兜底比对防串(卡在话题里
 * 时 open_chat_id 是群 id, 与 lane 的 chatId 恒一致)。查不到返回 null — 私聊卡、
 * 改投 DM 卡或已过期淘汰的条目, 回调 senderId 保持 operator.open_id。
 */
export function resolveCardLane(messageId: string, chatId: string): string | null {
  pruneCardLanes();
  const entry = cardLanes.get(messageId);
  if (!entry) return null;
  const lane = decodeLaneUserId(entry.lane);
  if (!lane || lane.chatId !== chatId) return null;
  return entry.lane;
}

export async function sendInteractive(
  userId: string,
  spec: InteractiveCardSpec,
  opts?: { deliverToOwnerDm?: boolean; ownerDmNote?: string },
): Promise<{ messageId: string }> {
  // 授权卡改投宿主私聊(群 lane 专用语义): 群里的授权卡只有 owner 能答且
  // 消不掉。owner 未知时保持原 lane 投递, 不吞掉这次交互(telegram 同口径)。
  const owner = ownerGuard.firstAllowed();
  if (opts?.deliverToOwnerDm && decodeLaneUserId(userId) && owner) {
    const dmSpec: InteractiveCardSpec = opts.ownerDmNote
      ? { ...spec, body: `${opts.ownerDmNote}\n\n${spec.body}` }
      : spec;
    const card = buildInteractiveCardV1(dmSpec);
    return createMessage({ kind: 'open_id', id: owner }, 'interactive', JSON.stringify(card));
  }
  const card = buildInteractiveCardV1(spec);
  const result = await createMessage(
    requireSendTarget(userId),
    'interactive',
    JSON.stringify(card),
  );
  registerCardLane(userId, result.messageId);
  return result;
}

export async function updateInteractive(
  messageId: string,
  spec: InteractiveCardSpec,
): Promise<void> {
  const card = buildInteractiveCardV1(spec);
  const res = await ensureClient().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
  const rejected = feishuBusinessRejectReason(res);
  if (rejected) {
    throw new Error(`updateInteractive rejected: ${rejected}`);
  }
}

// ── raw card patch (used by streamingText for v2 markdown patching) ───────────

export async function patchCardRaw(messageId: string, cardJson: unknown): Promise<void> {
  const res = await ensureClient().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(cardJson) },
  });
  const rejected = feishuBusinessRejectReason(res);
  if (rejected) {
    throw new Error(`patchCardRaw rejected: ${rejected}`);
  }
}

/**
 * Send a brand-new card (used by streamingText to mint the initial message).
 * 流式建卡是每个 agent 回合的首条出站 — 群 lane 在此领取新的回挂锚点。
 */
export async function sendCardRaw(
  userId: string,
  cardJson: unknown,
): Promise<{ messageId: string }> {
  return createMessage(
    requireSendTarget(userId, { advanceRound: true }),
    'interactive',
    JSON.stringify(cardJson),
  );
}

// ── file send ────────────────────────────────────────────────────────────────

const FEISHU_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function isFeishuImageExt(absPath: string): boolean {
  return FEISHU_IMAGE_EXTS.has(path.extname(absPath).toLowerCase());
}

function inferFeishuFileType(
  absPath: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.opus') return 'opus';
  if (ext === '.mp4' || ext === '.mov') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx'].includes(ext)) return 'doc';
  if (['.xls', '.xlsx'].includes(ext)) return 'xls';
  if (['.ppt', '.pptx'].includes(ext)) return 'ppt';
  return 'stream';
}

export async function sendFile(
  userId: string,
  absPath: string,
  displayName?: string,
): Promise<SendFileResult> {
  const log = getLog();
  const c = ensureClient();
  const baseName = path.basename(absPath);
  const showName = displayName?.length ? displayName : baseName;

  if (!fs.existsSync(absPath)) return { ok: false, reason: 'NOT_FOUND' };
  const stat = fs.statSync(absPath);
  if (stat.size === 0) return { ok: false, reason: 'EMPTY' };
  if (stat.size > FEISHU_FILE_SIZE_LIMIT) return { ok: false, reason: 'TOO_LARGE' };

  const target = resolveSendTarget(userId);
  if (!target) {
    log.error(`[feishu/outbound] sendFile: no reply anchor for topic lane ...${userId.slice(-8)}`);
    return { ok: false, reason: 'SEND_FAIL' };
  }

  // Image fast-path: if the file is a feishu-supported image type and within
  // the image-msg size cap, send as msg_type:image so it previews inline.
  if (isFeishuImageExt(absPath) && stat.size <= FEISHU_IMAGE_MAX_BYTES) {
    return sendImageMessage(c, target, absPath);
  }

  // 1. Upload to obtain file_key.
  let fileKey: string;
  try {
    const fileType = inferFeishuFileType(absPath);
    const res = await c.im.file.create({
      data: {
        file_type: fileType,
        file_name: showName,
        file: fs.createReadStream(absPath),
      },
    });
    const key = (res as { file_key?: string } | null)?.file_key;
    if (!key) return { ok: false, reason: 'UPLOAD_FAIL' };
    fileKey = key;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/outbound] sendFile UPLOAD_FAIL: ${msg}`);
    return { ok: false, reason: 'UPLOAD_FAIL' };
  }

  // 2. Send message referencing file_key.
  try {
    const res = await createMessage(target, 'file', JSON.stringify({ file_key: fileKey }));
    return { ok: true, messageId: res.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/outbound] sendFile SEND_FAIL: ${msg}`);
    return { ok: false, reason: 'SEND_FAIL' };
  }
}

/**
 * Upload a local image file to feishu and return its `image_key`. Used by
 * streamingText to inline `xdt-image://...` references as feishu `img`
 * elements inside an interactive card. Caller is responsible for size /
 * format checks; we fail-soft (log + null) on any error so a single bad image
 * doesn't break the whole card patch.
 *
 * 10 MB cap (feishu image-message limit). Use `sendFile` for larger blobs.
 */
export async function uploadImage(absPath: string): Promise<string | null> {
  const log = getLog();
  try {
    if (!fs.existsSync(absPath)) {
      log.warn(`[feishu/outbound] uploadImage NOT_FOUND ${absPath}`);
      return null;
    }
    const stat = fs.statSync(absPath);
    if (stat.size === 0 || stat.size > FEISHU_IMAGE_MAX_BYTES) {
      log.warn(`[feishu/outbound] uploadImage size ineligible ${stat.size} for ${absPath}`);
      return null;
    }
    const res = await ensureClient().im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(absPath),
      },
    });
    const key = (res as { image_key?: string }).image_key;
    return key ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] uploadImage failed: ${msg}`);
    return null;
  }
}

// ── exact reply context ───────────────────────────────────────────────────────

export interface ResolvedReplyMessage {
  replyContext: NonNullable<IMMessageEvent['replyContext']>;
}

function renderReplyMessageText(
  parsed: ReturnType<typeof parseIncoming>,
): string {
  const parts: string[] = [];
  if (parsed.text) parts.push(parsed.text);
  for (const attachment of parsed.attachments) {
    parts.push(attachment.kind === 'image' ? '[图片]' : `[文件: ${attachment.fileName}]`);
  }
  for (const unsupported of parsed.unsupported) parts.push(`[${unsupported.label}]`);
  return parts.join('\n').trim();
}

function replaceFetchedMentions(
  text: string,
  mentions: Array<{ key: string; name?: unknown }> | undefined,
): string {
  let out = text;
  for (const mention of mentions ?? []) {
    if (!mention.key) continue;
    const rawName = typeof mention.name === 'string' ? mention.name : '';
    const name = rawName.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 64);
    out = out.split(mention.key).join(`@${name || 'user'}`);
  }
  return out;
}

/**
 * 精确读取一条飞书普通回复所引用的原消息。全程 pin 到开始时的 client;
 * 账号换代后调用方会用 connection generation 丢弃结果, 不会串进新账号。
 *
 * 任何读取、解析失败都降级为 null, 当前 turn 继续走既有群历史上下文路径。
 * 跨群 parent_id fail closed, 防止异常事件带出别处内容。被引附件只渲染
 * [图片]/[文件] 占位, 不在 transport 层提前下载或并入当前消息附件:正文要先
 * 经 host 的注入扫描, 且引用附件不应按触发消息语义落库。
 */
export async function resolveReplyMessage(
  messageId: string,
  expectedChatId: string,
): Promise<ResolvedReplyMessage | null> {
  const c = client;
  if (!c) return null;
  const log = getLog();
  try {
    const res = await c.im.v1.message.get({
      params: { user_id_type: 'open_id', with_sender_name: true },
      path: { message_id: messageId },
    });
    const rejected = feishuBusinessRejectReason(res);
    if (rejected) {
      log.warn(`[feishu/outbound] reply context fetch rejected: ${rejected}`);
      return null;
    }
    const item = res.data?.items?.[0];
    if (!item || item.deleted) return null;
    if (item.chat_id !== expectedChatId) {
      log.warn('[feishu/outbound] reply context dropped: parent message belongs to another chat');
      return null;
    }

    const parsed = parseIncoming(item.msg_type ?? '', item.body?.content ?? '');
    const text = replaceFetchedMentions(
      renderReplyMessageText(parsed),
      item.mentions,
    );
    if (!text) return null;

    const isBot = item.sender?.sender_type === 'app';
    const author = item.sender?.sender_name?.trim() || (isBot ? 'bot' : 'user');
    return {
      replyContext: {
        author,
        text,
        ...(isBot ? { isBot: true } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] reply context fetch failed (degraded): ${msg}`);
    return null;
  }
}

// ── group history (context assembly for group lanes) ──────────────────────────

export interface RecentChatMessage {
  messageId: string;
  threadId: string;
  senderName: string;
  senderOpenId: string;
  senderIsBot: boolean;
  text: string;
  /** 图片/文件附件引用(image_key / file_key) — 下载需要配对的 messageId。 */
  attachments: AttachmentRef[];
  createTimeMs: number;
}

export interface ChatHistoryPage {
  /** 页内按时间升序(拉取是倒序的, 返回前翻正)。 */
  messages: RecentChatMessage[];
  /** 还有更早的页时给下一次调用的 page_token; 没有更早历史为 null。 */
  nextPageToken: string | null;
}

/**
 * 按页拉群/话题历史(群 lane 触发时 adapter 拼上下文用)。倒序拉一页, 返回
 * 页内升序。话题 lane 传 threadId 走 thread 容器, 只回本话题消息; 群主流
 * 不传, 调用方自行按 thread_id 过滤(chat 容器会混入话题消息)。
 *
 * 需要「获取群组中所有消息」权限。**失败(权限不足/网络)直接抛错** — 调用方
 * 需要区分「真的没有历史」与「拉取失败」来做降级提示, 不能吞成空数组。
 * 文本抽取复用 parseIncoming; audio/media/sticker 等对上下文无意义的类型跳过。
 */
export async function fetchChatHistoryPage(args: {
  chatId: string;
  threadId?: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<ChatHistoryPage> {
  const c = client;
  if (!c) throw new Error('feishu client not bound');
  const res = await c.im.v1.message.list({
    params: {
      container_id_type: args.threadId ? 'thread' : 'chat',
      container_id: args.threadId ?? args.chatId,
      sort_type: 'ByCreateTimeDesc',
      page_size: Math.min(Math.max(args.pageSize ?? 50, 1), 50),
      with_sender_name: true,
      ...(args.pageToken ? { page_token: args.pageToken } : {}),
    },
  });
  if (res.code !== 0) {
    throw new Error(`im.message.list failed: code=${res.code} msg=${res.msg ?? 'unknown'}`);
  }
  const items = res.data?.items ?? [];
  const out: RecentChatMessage[] = [];
  for (const item of items) {
    if (!item.message_id || item.deleted) continue;
    const msgType = item.msg_type ?? '';
    const rawContent = item.body?.content ?? '';
    let text = '';
    let attachments: AttachmentRef[] = [];
    if (
      msgType === 'text' ||
      msgType === 'post' ||
      msgType === 'image' ||
      msgType === 'file' ||
      msgType === 'interactive' ||
      msgType === 'card'
    ) {
      const parsed = parseIncoming(msgType, rawContent);
      text = parsed.text;
      attachments = parsed.attachments;
    } else {
      continue; // audio/media/sticker 等对上下文无意义, 跳过
    }
    if (!text && attachments.length === 0) continue;
    out.push({
      messageId: item.message_id,
      threadId: item.thread_id ?? '',
      senderName: item.sender?.sender_name ?? '',
      senderOpenId: item.sender?.id_type === 'open_id' ? (item.sender?.id ?? '') : '',
      senderIsBot: item.sender?.sender_type === 'app',
      text,
      attachments,
      createTimeMs: Number(item.create_time ?? 0),
    });
  }
  out.reverse();
  const hasMore = res.data?.has_more === true;
  const nextToken = res.data?.page_token;
  return {
    messages: out,
    nextPageToken: hasMore && nextToken ? nextToken : null,
  };
}

/**
 * 拉群名称(群 lane 会话标题用)。需要「获取群基本信息」权限; 失败/无权限
 * 返回 null — 调用方回落 chatId 后 6 位。bot 拉不到群名的常见原因与群历史
 * 相同: 应用未开权限或未发布版本。
 */
export async function getChatName(chatId: string): Promise<string | null> {
  const log = getLog();
  const c = client;
  if (!c) return null;
  try {
    const res = await c.im.v1.chat.get({ path: { chat_id: chatId } });
    if (res.code !== 0) {
      log.warn(`[feishu/outbound] chat.get failed: code=${res.code} msg=${res.msg ?? 'unknown'}`);
      return null;
    }
    return res.data?.name ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] chat.get failed: ${msg}`);
    return null;
  }
}

async function sendImageMessage(
  c: Lark.Client,
  target: SendTarget,
  absPath: string,
): Promise<SendFileResult> {
  const log = getLog();
  try {
    const upRes = await c.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(absPath),
      },
    });
    const imageKey = (upRes as { image_key?: string }).image_key;
    if (!imageKey) return { ok: false, reason: 'UPLOAD_FAIL' };

    const res = await createMessage(target, 'image', JSON.stringify({ image_key: imageKey }));
    return { ok: true, messageId: res.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/outbound] sendImageMessage failed: ${msg}`);
    return { ok: false, reason: 'SEND_FAIL' };
  }
}
