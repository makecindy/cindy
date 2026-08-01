/**
 * telegram/chunk.ts — 出站长文本分段。
 * ---------------------------------------------------------------------------
 * Telegram 单条消息上限 4096 字符(按 UTF-16 计, 且是 parse 后的可见文本)。
 * 分段发生在 markdown 源文本上(渲染前), 预算收紧到 3000: HTML 转义与标签
 * 会放大字节数, 预留 ~35% 余量避免渲染后越界; code fence 跨段自动闭合/重开
 * 复用 discord 的分段器(算法与渠道无关, limit 参数化)。
 */

import { chunkDiscordText } from '../discord/chunk.js';

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const SOURCE_CHUNK_LIMIT = 3000;

export function chunkTelegramSource(text: string): string[] {
  return chunkDiscordText(text, SOURCE_CHUNK_LIMIT);
}
