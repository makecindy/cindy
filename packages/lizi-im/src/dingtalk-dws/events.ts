/**
 * dws 个人 IM 事件（`event consume --flatten -f ndjson`）的解析。
 *
 * 只订阅两类事件：全部单聊（o2o_all）与群里 @ 当前账号（at）。扁平输出的
 * `type` 字段固定为 event_key，据此区分单聊与群聊。
 */

export const DWS_EVENT_DIRECT = 'user_im_message_receive_o2o_all';
export const DWS_EVENT_MENTION = 'user_im_message_receive_at';

export interface DwsInboundMessage {
  kind: 'direct' | 'mention';
  /** 去重键：优先 event_id，缺省退回 message_id。 */
  dedupeKey: string;
  messageId: string;
  conversationId: string;
  senderOpenId: string;
  senderName: string;
  text: string;
  /** 引用回复的原消息；messageId 用于连同原消息里的图片一起下载。 */
  quoted?: { author: string; text: string; messageId?: string };
}

const MAX_TEXT_CHARS = 20_000;

export function parseDwsEventLine(line: string): DwsInboundMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const type = str(raw.type);
  const kind =
    type === DWS_EVENT_DIRECT ? 'direct' : type === DWS_EVENT_MENTION ? 'mention' : null;
  if (!kind) return null;
  const messageId = str(raw.message_id);
  const conversationId = str(raw.conversation_id);
  const senderOpenId = str(raw.sender_open_dingtalk_id);
  if (!messageId || !conversationId || !senderOpenId) return null;
  const quoted = isRecord(raw.quoted_message) ? raw.quoted_message : null;
  const quotedText = quoted ? str(quoted.content) : '';
  const quotedMessageId = quoted ? str(quoted.message_id) : '';
  return {
    kind,
    dedupeKey: str(raw.event_id) || messageId,
    messageId,
    conversationId,
    senderOpenId,
    senderName: displayName(str(raw.sender)),
    text: str(raw.content).slice(0, MAX_TEXT_CHARS),
    ...(quoted && (quotedText || quotedMessageId)
      ? {
          quoted: {
            author: displayName(str(quoted.sender)),
            text: quotedText.slice(0, MAX_TEXT_CHARS),
            ...(quotedMessageId ? { messageId: quotedMessageId } : {}),
          },
        }
      : {}),
  };
}

/** stderr 就绪行：`[event] ready ...`（多事件时带 event_count）。 */
export function isDwsReadyLine(line: string): boolean {
  return /^\[event\] ready\b/.test(line.trim());
}

/**
 * stderr 传输状态行：`[event] transport {"state":"connected",...}`。
 * 只取 state，不回显整行（行内可能带订阅标识）。
 */
export function parseDwsTransportState(line: string): string | null {
  const match = /^\[event\] transport (\{.*\})\s*$/.exec(line.trim());
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return isRecord(parsed) && typeof parsed.state === 'string' ? parsed.state : null;
  } catch {
    return null;
  }
}

/** 群 @ 消息正文里去掉对当前账号的 @ 提及。 */
export function stripSelfMention(text: string, selfName: string): string {
  if (!selfName) return text.trim();
  const name = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 手机端 @ 只插入「@名字」；电脑端会在后面附带括号，如「@智能机器人(智能机器人)」，
  // 也可能是「@备注名(名字)」。半角、全角括号都要连同 @ 一起去掉。
  const paren = '[(（][^()（）\\n]{0,64}[)）]';
  const mention = new RegExp(`@(?:${name}(?:${paren})?|[^\\s@()（）]{1,64}[(（]${name}[)）])\\s*`, 'g');
  return text.replace(mention, '').trim();
}

function displayName(value: string): string {
  // 服务端未提供展示名时可能给出空串或字面量 "null"。
  return value && value !== 'null' ? value : '钉钉用户';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
