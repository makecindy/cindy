/**
 * telegram/codec.ts — 渠道内各类复合 id 的编码约定。
 * ---------------------------------------------------------------------------
 * 1. messageId: `${chatId}|${messageId}` — 出站编辑/回应需要 chat_id + message_id
 *    两个坐标, 编排层只认一个字符串。
 * 2. 群 lane id: `g/${chatId}` 或 `g/${chatId}/${threadId}` — 群/topic 会话在
 *    编排层的"userId"。编排层按 (botContextId, userId) 路由会话与出站目标,
 *    lane id 让「每群每话题一个会话」零共享层改动成立; transport 出站时解码
 *    路由回对应群聊。私聊 userId 就是 Telegram 数字 user id(私聊 chat_id ===
 *    user id), 与 lane id 无歧义。
 * 3. callback_data: Telegram 上限 64 字节, 卡片按钮 payload 一律走内存 ref 表
 *    (进程重启后按钮失效 → 过期卡提示, 与 Discord ref 缓存同语义)。
 */

const MESSAGE_ID_SEPARATOR = '|';
const LANE_PREFIX = 'g/';
const CALLBACK_REF_PREFIX = 'r:';
const CALLBACK_REF_CAPACITY = 512;

export function encodeMessageId(chatId: string, messageId: string): string {
  if (!isValidPart(chatId) || !isValidPart(messageId)) {
    throw new Error('invalid telegram messageId part');
  }
  return `${chatId}${MESSAGE_ID_SEPARATOR}${messageId}`;
}

export function decodeMessageId(encoded: string): { chatId: string; messageId: string } {
  const parts = encoded.split(MESSAGE_ID_SEPARATOR);
  if (parts.length !== 2 || !isValidPart(parts[0]) || !isValidPart(parts[1])) {
    throw new Error(`invalid telegram messageId: ${encoded}`);
  }
  return { chatId: parts[0], messageId: parts[1] };
}

export interface TelegramLane {
  chatId: string;
  /** forum topic id; '' = 主群流。 */
  threadId: string;
}

export function encodeLaneUserId(chatId: string, threadId: string | null | undefined): string {
  const thread = threadId ?? '';
  return thread ? `${LANE_PREFIX}${chatId}/${thread}` : `${LANE_PREFIX}${chatId}`;
}

/** 非 lane id(私聊数字 user id)返回 null。 */
export function decodeLaneUserId(userId: string): TelegramLane | null {
  if (!userId.startsWith(LANE_PREFIX)) return null;
  const rest = userId.slice(LANE_PREFIX.length);
  const [chatId, threadId = ''] = rest.split('/');
  if (!chatId) return null;
  return { chatId, threadId };
}

interface CallbackBody {
  i: string;
  p: Record<string, unknown>;
}

const callbackRefs = new Map<string, CallbackBody>();
let callbackCounter = 0;

export function encodeCallbackData(buttonId: string, payload: Record<string, unknown>): string {
  if (!buttonId) throw new Error('invalid telegram callback buttonId');
  const token = `${Date.now().toString(36)}${(callbackCounter += 1).toString(36)}`;
  callbackRefs.set(token, { i: buttonId, p: payload });
  while (callbackRefs.size > CALLBACK_REF_CAPACITY) {
    const oldest = callbackRefs.keys().next().value;
    if (oldest === undefined) break;
    callbackRefs.delete(oldest);
  }
  return `${CALLBACK_REF_PREFIX}${token}`;
}

export function decodeCallbackData(
  data: string,
): { buttonId: string; payload: Record<string, unknown> } | null {
  if (!data.startsWith(CALLBACK_REF_PREFIX)) return null;
  const found = callbackRefs.get(data.slice(CALLBACK_REF_PREFIX.length));
  return found ? { buttonId: found.i, payload: found.p } : null;
}

function isValidPart(part: string): boolean {
  return typeof part === 'string' && part.length > 0 && !part.includes(MESSAGE_ID_SEPARATOR);
}
