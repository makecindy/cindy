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
import { buildInteractiveCardV1 } from './cards.js';
import { decodeLaneUserId } from './codec.js';
import * as ownerGuard from './ownerGuard.js';
import { parseIncoming } from './incomingContent.js';
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
  return createMessage(requireSendTarget(userId), 'interactive', JSON.stringify(card));
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
  createTimeMs: number;
}

/**
 * 拉群会话最近历史(群 lane 触发时拼上下文前缀用)。倒序拉一页, 返回升序。
 * 需要「获取群组中所有消息」权限; 权限不足/失败返回空数组 + log warn —
 * 上下文前缀降级为无, turn 照跑。文本抽取复用 parseIncoming(text/post 之外
 * 的类型给占位标签)。
 */
export async function fetchRecentChatMessages(
  chatId: string,
  opts?: { limit?: number },
): Promise<RecentChatMessage[]> {
  const log = getLog();
  const c = client;
  if (!c) return [];
  try {
    const res = await c.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: Math.min(Math.max(opts?.limit ?? 50, 1), 50),
        with_sender_name: true,
      },
    });
    const items = res.data?.items ?? [];
    const out: RecentChatMessage[] = [];
    for (const item of items) {
      if (!item.message_id || item.deleted) continue;
      const msgType = item.msg_type ?? '';
      const rawContent = item.body?.content ?? '';
      let text = '';
      if (msgType === 'text' || msgType === 'post') {
        text = parseIncoming(msgType, rawContent).text;
      } else if (msgType === 'image') {
        text = '[图片]';
      } else if (msgType === 'file') {
        text = '[文件]';
      } else if (msgType === 'interactive') {
        text = '[卡片消息]';
      } else {
        continue; // audio/media/sticker 等对上下文无意义, 跳过
      }
      if (!text) continue;
      out.push({
        messageId: item.message_id,
        threadId: item.thread_id ?? '',
        senderName: item.sender?.sender_name ?? '',
        senderOpenId: item.sender?.id_type === 'open_id' ? (item.sender?.id ?? '') : '',
        senderIsBot: item.sender?.sender_type === 'app',
        text,
        createTimeMs: Number(item.create_time ?? 0),
      });
    }
    out.reverse();
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[feishu/outbound] fetchRecentChatMessages failed (context degraded): ${msg}`);
    return [];
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
