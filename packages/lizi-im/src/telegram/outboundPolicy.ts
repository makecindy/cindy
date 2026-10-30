/**
 * telegram/outboundPolicy.ts — Telegram 出站的失败处理判据(两个 bot 同源)。
 * ---------------------------------------------------------------------------
 * 个人 bot 直连 Bot API(`index.ts` 的 callSend / sendRenderedChunk / editHtml),
 * 官方 bot 经 msg.op 由服务端执行(desktop `hook-control/telegramProgressCarrier.ts`)。
 * 两条传输不同, 但"拿到 Telegram 的拒绝之后怎么办"是同一套产品判据, 收在这里:
 *   - HTML 被拒(400) → 同一条退回纯文本, 宁可丢格式不丢内容;
 *   - `message is not modified` → 内容没变的重复编辑, 视为成功;
 *   - 429 → 按 `retry_after` 全长退避后重试一次, 不设上限(见 telegramRetryAfterWaitMs)。
 *
 * 判据只看**结构**(`errorCode` 数字 + 渠道原文), 不认具体错误类: 个人侧抛
 * `TelegramApiError`, 官方侧把 `msg.op.result` 的 `channelErrorCode` / `error` /
 * `retryAfterMs` 映射成同一形状。没有 `errorCode` 的错误(网络中断、超时、回执未知)
 * 一律不命中任何回落 —— 那时无法判断 Telegram 是否已接收。
 */

import { stripTelegramHtmlTags } from './markdown.js';

/** 个人 `TelegramApiError` 与官方 msg.op 失败都满足的错误形状。 */
export interface TelegramErrorShape {
  /** Telegram `error_code`(400 / 429 …)。缺席 = 不是 Telegram 的明确应答。 */
  errorCode?: number;
  /** 含 Telegram 原文 description。 */
  message: string;
  /** 429 时 Telegram 建议的等待秒数。 */
  retryAfterSec?: number;
}

function errorCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'number' ? code : undefined;
}

function messageOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * 429 没给 `retry_after`(或给了非法值)时的兜底退避。**只用于兜底** —— 合法值
 * 一律按服务端给的全长等, 不设上限: 任何上限都等于在 flood 窗口结束前提前重试,
 * 那次重试必然再 429, 终稿于是又丢一次(bot-wide flood 的 retry_after 可以远超
 * 一分钟)。不设上限是安全的前提是等待绑定了调用方的生命周期取消源(个人侧是
 * 连接的 outboundAbortSignal, 官方侧是本轮进度载体的关闭)。
 */
export const TELEGRAM_RETRY_AFTER_FALLBACK_MS = 3_000;

/** 429 退避时长: 合法 `retry_after` 原样采用, 缺失或非法(NaN / ≤0 / 非有限)走兜底。 */
export function telegramRetryAfterWaitMs(retryAfterSec: number | undefined): number {
  if (typeof retryAfterSec !== 'number') return TELEGRAM_RETRY_AFTER_FALLBACK_MS;
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0)
    return TELEGRAM_RETRY_AFTER_FALLBACK_MS;
  return retryAfterSec * 1000;
}

/** Telegram 明确回了 429。 */
export function isTelegramRateLimited(err: unknown): boolean {
  return errorCodeOf(err) === 429;
}

/** Telegram 明确回了 400(HTML 实体解析失败等); 调用方据此回落纯文本。 */
export function isTelegramBadRequest(err: unknown): boolean {
  return errorCodeOf(err) === 400;
}

/** 内容未变的重复编辑。必须是 Telegram 的应答(带 errorCode), 不匹配任意本地错误文案。 */
export function isTelegramMessageNotModified(err: unknown): boolean {
  return errorCodeOf(err) !== undefined && /not modified/i.test(messageOf(err));
}

/**
 * 429 退避一次重试。`sleep` 必须能被调用方的生命周期取消提前唤醒, 醒来后由
 * `isLive` 复核 —— 已停止就放弃重试并抛回原始 429, 不再发出任何请求。
 */
export async function callWithTelegramRateLimitRetry<T>(
  call: () => Promise<T>,
  opts: {
    sleep: (ms: number) => Promise<void>;
    isLive: () => boolean;
  },
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isTelegramRateLimited(err)) throw err;
    const retryAfterSec = (err as { retryAfterSec?: unknown }).retryAfterSec;
    await opts.sleep(
      telegramRetryAfterWaitMs(typeof retryAfterSec === 'number' ? retryAfterSec : undefined),
    );
    if (!opts.isLive()) throw err;
    return call();
  }
}

/**
 * 发一条渲染好的消息: 先按 HTML 发, Telegram 明确 400 时用 `plain` 原样重发。
 * `post(text, parseHtml)` 负责真正的出站(parseHtml=false 时不得带 parse_mode)。
 */
export async function sendTelegramHtmlWithFallback<T>(
  html: string,
  plain: string,
  post: (text: string, parseHtml: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await post(html || '…', true);
  } catch (err) {
    if (!isTelegramBadRequest(err)) throw err;
    return post(plain || '…', false);
  }
}

/**
 * 编辑一条消息为渲染好的 HTML: not modified 视为成功; Telegram 明确 400 时剥掉
 * 标签退回纯文本编辑, 回落那次的 not modified 同样视为成功。`put(text, parseHtml)`
 * 负责真正的出站(parseHtml=false 时不得带 parse_mode)。
 */
export async function editTelegramHtmlWithFallback(
  html: string,
  put: (text: string, parseHtml: boolean) => Promise<void>,
): Promise<void> {
  try {
    await put(html || '…', true);
  } catch (err) {
    if (isTelegramMessageNotModified(err)) return;
    if (!isTelegramBadRequest(err)) throw err;
    try {
      await put(stripTelegramHtmlTags(html) || '…', false);
    } catch (fallbackErr) {
      if (isTelegramMessageNotModified(fallbackErr)) return;
      throw fallbackErr;
    }
  }
}
