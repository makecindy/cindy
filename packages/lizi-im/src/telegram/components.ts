/**
 * telegram/components.ts — InteractiveCardSpec ↔ Telegram inline keyboard。
 * ---------------------------------------------------------------------------
 * 卡片 = 一条 HTML 文本消息 + inline_keyboard。按钮回流走 callback_query,
 * callback_data 是内存 ref token(64 字节上限, 见 codec.ts) — 进程重启后
 * 旧按钮解不出来, 上层回「卡片已过期」。
 *
 * Telegram inline keyboard 无行数硬限制(实际上限 100 键), 不需要 Discord 的
 * 分页方案; 每行 1-2 键按 label 长度自适应, 保持触控目标可点。
 */

import type { IMCardActionEvent, InteractiveCardSpec } from '../types.js';
import type { TgCallbackQuery } from './api.js';
import { decodeCallbackData, encodeCallbackData, encodeMessageId, encodeLaneUserId } from './codec.js';
import { markdownToTelegramHtml } from './markdown.js';

const BUTTON_LABEL_MAX = 64;
/** label 短于此值时允许两键并排。 */
const PAIR_LABEL_MAX = 12;
const CARD_TEXT_MAX = 3800;

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export function buildCardPayload(spec: InteractiveCardSpec): {
  html: string;
  replyMarkup: { inline_keyboard: TelegramInlineKeyboardButton[][] } | undefined;
} {
  const title = spec.title ? `<b>${escapeTitle(spec.title)}</b>\n\n` : '';
  const { html: body } = markdownToTelegramHtml(spec.body);
  const html = capCardText(`${title}${body}`);

  if (spec.buttons.length === 0) return { html, replyMarkup: undefined };

  const rows: TelegramInlineKeyboardButton[][] = [];
  let pendingPair: TelegramInlineKeyboardButton | null = null;
  for (const button of spec.buttons) {
    const rendered: TelegramInlineKeyboardButton = {
      text: button.label.slice(0, BUTTON_LABEL_MAX),
      callback_data: encodeCallbackData(button.id, button.payload ?? {}),
    };
    if (button.label.length <= PAIR_LABEL_MAX) {
      if (pendingPair) {
        rows.push([pendingPair, rendered]);
        pendingPair = null;
      } else {
        pendingPair = rendered;
      }
      continue;
    }
    if (pendingPair) {
      rows.push([pendingPair]);
      pendingPair = null;
    }
    rows.push([rendered]);
  }
  if (pendingPair) rows.push([pendingPair]);
  return { html, replyMarkup: { inline_keyboard: rows } };
}

/**
 * callback_query → IMCardActionEvent。senderId 语义与入站消息一致: 卡片在
 * 群聊里时用群 lane id(编排层按它路由回会话), 私聊时用按键者数字 id。
 * ref 失效(重启/淘汰)返回 null — 调用方负责回「已过期」。
 */
export function parseCallbackQuery(q: TgCallbackQuery): IMCardActionEvent | null {
  if (!q.data || !q.message) return null;
  const decoded = decodeCallbackData(q.data);
  if (!decoded) return null;
  const chat = q.message.chat;
  const isPrivate = chat.type === 'private';
  const laneThreadId =
    q.message.is_topic_message === true && q.message.message_thread_id !== undefined
      ? String(q.message.message_thread_id)
      : '';
  return {
    channelName: 'telegram',
    senderId: isPrivate ? String(q.from.id) : encodeLaneUserId(String(chat.id), laneThreadId),
    chatId: String(chat.id),
    messageId: encodeMessageId(String(chat.id), String(q.message.message_id)),
    buttonId: decoded.buttonId,
    payload: decoded.payload,
    threadTs: undefined,
    scopeKey: undefined,
  };
}

function escapeTitle(title: string): string {
  return title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * HTML 安全截断: 纯字符切片可能切在标签(<a href=...)或实体(&amp;)中间,
 * parse_mode=HTML 的 sendMessage 会 400 整条失败。截点回退到完整边界,
 * 再栈扫描闭合未配对标签(Telegram HTML 子集无自闭合标签)。
 */
function capCardText(html: string): string {
  if (html.length <= CARD_TEXT_MAX) return html;
  let cut = html.slice(0, CARD_TEXT_MAX - 1);
  const lastOpen = cut.lastIndexOf('<');
  if (lastOpen > cut.lastIndexOf('>')) cut = cut.slice(0, lastOpen);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';') && cut.length - lastAmp <= 10) {
    cut = cut.slice(0, lastAmp);
  }
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cut)) !== null) {
    const name = m[2].toLowerCase();
    if (m[1]) {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push(name);
    }
  }
  const closers = stack
    .reverse()
    .map((name) => `</${name}>`)
    .join('');
  return `${cut}…${closers}`;
}
