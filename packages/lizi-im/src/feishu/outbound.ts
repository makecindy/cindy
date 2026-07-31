/**
 * feishu/outbound.ts
 * ---------------------------------------------------------------------------
 * Outbound primitives backed by Lark.Client. Exposes the surface that
 * `FeishuIM` re-exports + a few internal helpers (bindClient / addReaction /
 * removeReaction / patchCardRaw) consumed by sibling modules.
 *
 * p2p only — `receive_id_type` is always `open_id`. Group chats are blocked
 * upstream in wsClient.
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

export async function sendText(openId: string, text: string): Promise<{ messageId: string }> {
  const res = await ensureClient().im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  const id = res.data?.message_id ?? '';
  if (!id) throw new Error('[feishu/outbound] sendText: no message_id in response');
  return { messageId: id };
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
  openId: string,
  spec: InteractiveCardSpec,
): Promise<{ messageId: string }> {
  const card = buildInteractiveCardV1(spec);
  const res = await ensureClient().im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  const id = res.data?.message_id ?? '';
  if (!id) throw new Error('[feishu/outbound] sendInteractive: no message_id');
  return { messageId: id };
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

/** Send a brand-new card (used by streamingText to mint the initial message). */
export async function sendCardRaw(
  openId: string,
  cardJson: unknown,
): Promise<{ messageId: string }> {
  const res = await ensureClient().im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(cardJson),
    },
  });
  const id = res.data?.message_id ?? '';
  if (!id) throw new Error('[feishu/outbound] sendCardRaw: no message_id');
  return { messageId: id };
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
  openId: string,
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

  // Image fast-path: if the file is a feishu-supported image type and within
  // the image-msg size cap, send as msg_type:image so it previews inline.
  if (isFeishuImageExt(absPath) && stat.size <= FEISHU_IMAGE_MAX_BYTES) {
    return sendImageMessage(c, openId, absPath);
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
    const res = await c.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    return { ok: true, messageId: res.data?.message_id };
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

async function sendImageMessage(
  c: Lark.Client,
  openId: string,
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

    const res = await c.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    return { ok: true, messageId: res.data?.message_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[feishu/outbound] sendImageMessage failed: ${msg}`);
    return { ok: false, reason: 'SEND_FAIL' };
  }
}
