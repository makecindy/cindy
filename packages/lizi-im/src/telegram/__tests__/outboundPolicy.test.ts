/**
 * outboundPolicy: 两个 bot 共用的 Telegram 失败判据。只认结构(errorCode + 渠道原文),
 * 不认具体错误类 —— 个人侧的 TelegramApiError 与官方 msg.op 映射出的错误走同一条。
 */

import { describe, expect, it, vi } from 'vitest';

import { TelegramApiError } from '../api.js';
import {
  callWithTelegramRateLimitRetry,
  editTelegramHtmlWithFallback,
  isTelegramMessageNotModified,
  sendTelegramHtmlWithFallback,
  TELEGRAM_RETRY_AFTER_FALLBACK_MS,
  telegramRetryAfterWaitMs,
} from '../outboundPolicy.js';

const badRequest = (description: string) => new TelegramApiError('sendMessage', 400, description);

describe('outboundPolicy', () => {
  it('retry_after 合法值全长采用, 缺失或非法走兜底', () => {
    expect(telegramRetryAfterWaitMs(26)).toBe(26_000);
    for (const v of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(telegramRetryAfterWaitMs(v)).toBe(TELEGRAM_RETRY_AFTER_FALLBACK_MS);
    }
  });

  it('not modified 只认 Telegram 应答(带 errorCode), 不认本地错误文案', () => {
    expect(isTelegramMessageNotModified(badRequest('Bad Request: message is not modified'))).toBe(
      true,
    );
    expect(
      isTelegramMessageNotModified({
        errorCode: 400,
        message: 'message is not modified',
      }),
    ).toBe(true);
    expect(isTelegramMessageNotModified(new Error('message is not modified'))).toBe(false);
  });

  it('send: 400 回落 plain 原文, 其它错误原样抛出', async () => {
    const post = vi.fn(async (text: string, parseHtml: boolean) => {
      if (parseHtml) throw badRequest("can't parse entities");
      return text;
    });
    await expect(sendTelegramHtmlWithFallback('<b>x', '**x', post)).resolves.toBe('**x');
    expect(post.mock.calls).toEqual([
      ['<b>x', true],
      ['**x', false],
    ]);

    const network = new Error('socket hang up');
    await expect(
      sendTelegramHtmlWithFallback('h', 'p', async () => {
        throw network;
      }),
    ).rejects.toBe(network);
  });

  it('edit: not modified 视为成功; 400 剥标签回落, 回落的 not modified 也算成功', async () => {
    const put = vi.fn(async () => {
      throw badRequest('Bad Request: message is not modified');
    });
    await expect(editTelegramHtmlWithFallback('<b>x</b>', put)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);

    const calls: Array<[string, boolean]> = [];
    await editTelegramHtmlWithFallback('<b>粗</b> &amp; 细', async (text, parseHtml) => {
      calls.push([text, parseHtml]);
      if (parseHtml) throw badRequest("can't parse entities");
      throw badRequest('message is not modified');
    });
    expect(calls).toEqual([
      ['<b>粗</b> &amp; 细', true],
      ['粗 &amp; 细', false],
    ]);
  });

  it('429: 退避后重试一次; 醒来已停止则抛回原始 429、不再请求', async () => {
    const limited = new TelegramApiError('editMessageText', 429, 'Too Many Requests', 7);
    const sleep = vi.fn(async () => undefined);
    let attempt = 0;
    const call = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw limited;
      return 'ok';
    });
    await expect(callWithTelegramRateLimitRetry(call, { sleep, isLive: () => true })).resolves.toBe(
      'ok',
    );
    expect(sleep).toHaveBeenCalledWith(7_000);

    attempt = 0;
    call.mockClear();
    await expect(callWithTelegramRateLimitRetry(call, { sleep, isLive: () => false })).rejects.toBe(
      limited,
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
});
