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
import type { InteractiveCardSpec, SendFileResult } from '../types.js';
import type { BotCredentials } from './internal-types.js';

/** 30 MB per file — feishu's upper limit for `im.file.create`. */
const FEISHU_FILE_SIZE_LIMIT = 30 * 1024 * 1024;
/** 10 MB per image when sending as `msg_type:image`. */
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

let client: Lark.Client | null = null;
let creds: BotCredentials | null = null;

export function bindClient(c: BotCredentials): void {
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
  laneAnchors.clear();
  cardLanes.clear();
}

// ── group lane reply anchors ──────────────────────────────────────────────────
// 群 lane 的「答案挂回提问」: wsClient 在 owner 触发时 push 触发消息 id,
// 出站按回合领取(流式建卡时 advance)。话题 lane 的**所有**出站都走 reply
// 锚点 — 被回复消息在话题里, 回复自动落回话题(会话与挂回一次解决);
// 普通群 lane 只有回合首条出站 reply(引用式"挂在提问下"), 后续 chat_id 直发。
// 连接换代(unbindClient)清空 — 旧锚点不跨代错配(telegram 同语义)。

interface LaneAnchorState {
  /** 待领取的触发消息 id FIFO(多条消息先后触发同一 lane 各自排队)。 */
  queue: string[];
  /** 当前回合持有的锚点。 */
  held: string | null;
  /** 普通群: held 是否已用于引用回复(用过则后续 chat_id 直发)。 */
  quotedHeld: boolean;
}

const laneAnchors = new Map<string, LaneAnchorState>();

/** wsClient 在 owner 群触发时登记回挂锚点。 */
export function pushReplyAnchor(laneUserId: string, messageId: string): void {
  const state = laneAnchors.get(laneUserId) ?? { queue: [], held: null, quotedHeld: false };
  state.queue.push(messageId);
  laneAnchors.set(laneUserId, state);
}

// ── patchable opener (开话题开场白卡 = 本轮流式卡) ──────────────────────────
// 群主流 @ 开话题时, 开场白是一张「思考中」占位卡; 本轮流式卡不再新建一条
// 回复, 而是直接 patch 这张卡 — 话题里第一条可见内容就是答案。lane → opener
// 卡的映射由 wsClient 在 openThread 成功后登记, streamingText.start 认领。

const patchableOpeners = new Map<string, string>();

export function pushPatchableOpener(laneUserId: string, messageId: string): void {
  patchableOpeners.set(laneUserId, messageId);
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
  const state = laneAnchors.get(laneUserId) ?? { queue: [], held: null, quotedHeld: false };
  // 锚点队列头正常就是这张开场白卡; 对不上说明顺序被破坏, 保守起见仍保留队列。
  if (state.queue[0] === openerId) state.queue.shift();
  state.held = openerId;
  state.quotedHeld = true;
  laneAnchors.set(laneUserId, state);
  return openerId;
}

type SendTarget =
  | { kind: 'open_id'; id: string }
  | { kind: 'chat_id'; id: string }
  | { kind: 'reply'; messageId: string };

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

  const state = laneAnchors.get(userId) ?? { queue: [], held: null, quotedHeld: false };
  laneAnchors.set(userId, state);
  // 领取条件: advanceRound(流式建卡 = 新回合)必领; 其余出站只在完全没有
  // 持有时领(首次一次性回复)。回合中途的卡片/文件**不领** — 队列里可能已经
  // 排着下一轮的触发锚点, 中途领取会把下一轮的锚点偷来错挂。队列空时保留
  // held: 话题 lane 复用旧锚点仍落回正确话题(话题内任意消息都是合法锚点)。
  if ((opts?.advanceRound || !state.held) && state.queue.length > 0) {
    state.held = state.queue.shift() ?? null;
    state.quotedHeld = false;
  }

  if (lane.threadId) {
    // 话题 lane: 必须 reply 锚点才能落回话题; 没有锚点宁可失败也不能把
    // 消息发进群主流(位置错误比丢失更糟)。
    return state.held ? { kind: 'reply', messageId: state.held } : null;
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
      data: { content, msg_type: msgType },
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

interface OpenThreadResult {
  messageId: string;
  threadId: string;
}

const OPEN_THREAD_DEDUP_TTL_MS = 10 * 60_000;
const OPEN_THREAD_DEDUP_MAX_ENTRIES = 200;
const openThreadByTrigger = new Map<
  string,
  { ts: number; promise: Promise<OpenThreadResult | null> }
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
 * claimPatchableOpener 认领)。返回开场白卡 id + 新话题 thread_id。
 * 同一触发消息并发/重复调用共享同一次开话题 — 防飞书重投事件开出多个话题
 * (含进程重启: uuid 走服务端去重)。
 *
 * 失败语义: API 失败或响应缺 message_id → null(没有可确认已发出的开场白);
 * 响应有 message_id 但缺 thread_id → 用 message.get 补查话题 id, 查不到就
 * 撤回开场白再返回 null — 不让「回复都在里面」的开场白承诺落空。调用方在
 * null 时降级回群 lane 旧行为(引用回复 + chat_id 直发)。
 */
export function openThread(replyToMessageId: string): Promise<OpenThreadResult | null> {
  const now = Date.now();
  const cached = openThreadByTrigger.get(replyToMessageId);
  if (cached && now - cached.ts <= OPEN_THREAD_DEDUP_TTL_MS) return cached.promise;

  const promise = doOpenThread(replyToMessageId);
  openThreadByTrigger.set(replyToMessageId, { ts: now, promise });
  pruneOpenThreadDedup();
  return promise;
}

async function doOpenThread(replyToMessageId: string): Promise<OpenThreadResult | null> {
  const log = getLog();
  try {
    const res = await ensureClient().im.v1.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content: JSON.stringify(buildMarkdownCardV2(transportMessages.streaming.randomThinking())),
        msg_type: 'interactive',
        reply_in_thread: true,
        // 服务端幂等键: 同一触发消息重复开话题(重投事件、进程重启后重放)时,
        // 飞书按 uuid 去重(1 小时内同 uuid 至多发一条, 重复调用返回原消息
        // id), 不会开出第二个话题。
        uuid: replyToMessageId,
      },
    });
    const messageId = res.data?.message_id ?? '';
    const threadId = res.data?.thread_id ?? '';
    if (!messageId) {
      log.warn(
        '[feishu/outbound] openThread: no message_id in response — nothing provably sent',
      );
      return null;
    }
    if (threadId) return { messageId, threadId };
    // 部分成功: 开场白已发出但响应缺 thread_id — 补查消息详情恢复话题 id。
    const recovered = await tryFetchMessageThreadId(messageId);
    if (recovered) return { messageId, threadId: recovered };
    // 恢复不了: 撤回开场白再降级, 避免「回复都在里面」的开场白留在群里误导。
    try {
      await ensureClient().im.v1.message.delete({ path: { message_id: messageId } });
      log.warn(
        '[feishu/outbound] openThread: thread_id unrecoverable — opener recalled, fallback to group lane',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `[feishu/outbound] openThread: thread_id unrecoverable, opener recall failed (non-fatal): ${msg}`,
      );
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] openThread failed (fallback to group lane): ${msg}`);
    return null;
  }
}

/** 用 message.get 补查开场白消息的 thread_id(部分成功恢复);失败返回 ''。 */
async function tryFetchMessageThreadId(messageId: string): Promise<string> {
  const log = getLog();
  try {
    const res = await ensureClient().im.v1.message.get({ path: { message_id: messageId } });
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
// 按 31 天 TTL + 上限淘汰;unbindClient 随连接换代清空(与 laneAnchors 同口径)。

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
function registerCardLane(userId: string, messageId: string): void {
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
  await ensureClient().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
}

// ── raw card patch (used by streamingText for v2 markdown patching) ───────────

export async function patchCardRaw(messageId: string, cardJson: unknown): Promise<void> {
  await ensureClient().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(cardJson) },
  });
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
    if (msgType === 'text' || msgType === 'post' || msgType === 'image' || msgType === 'file') {
      const parsed = parseIncoming(msgType, rawContent);
      text = parsed.text;
      attachments = parsed.attachments;
    } else if (msgType === 'interactive') {
      text = '[卡片消息]';
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
