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
import { TELEGRAM_CARD_LAYOUT } from './cardLayout.js';
import { capRenderedText } from './htmlCap.js';
import { markdownToTelegramHtml } from './markdown.js';

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
  const html = capRenderedText(`${title}${body}`, TELEGRAM_CARD_LAYOUT.cardTextMax);

  if (spec.buttons.length === 0) return { html, replyMarkup: undefined };

  const rows: TelegramInlineKeyboardButton[][] = [];
  let pendingPair: TelegramInlineKeyboardButton | null = null;
  for (const button of spec.buttons) {
    const rendered: TelegramInlineKeyboardButton = {
      text: button.label.slice(0, TELEGRAM_CARD_LAYOUT.buttonLabelMax),
      callback_data: encodeCallbackData(button.id, button.payload ?? {}),
    };
    if (button.label.length <= TELEGRAM_CARD_LAYOUT.pairLabelMax) {
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
