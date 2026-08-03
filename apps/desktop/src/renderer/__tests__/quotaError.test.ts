import { describe, expect, it } from 'vitest';

import { isQuotaExhaustedErrorMessage } from '@/utils/quotaError';

describe('isQuotaExhaustedErrorMessage', () => {
  it('认得上游明确的余额 / 配额措辞', () => {
    expect(isQuotaExhaustedErrorMessage('insufficient_quota')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('Your credit balance is insufficient balance')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('quota exceeded for this key')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('账户余额不足，请充值')).toBe(true);
  });

  it('结构化信息丢了以后仍认带上下文的 402 状态码', () => {
    expect(isQuotaExhaustedErrorMessage('HTTP 402 Payment Required')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('request failed with status 402')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('upstream error (402)')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('code: 402')).toBe(true);
    expect(isQuotaExhaustedErrorMessage('402 Payment Required')).toBe(true);
  });

  it('不误伤网络类 / 过载类 / 鉴权类错误', () => {
    expect(isQuotaExhaustedErrorMessage('fetch failed: ECONNREFUSED')).toBe(false);
    expect(isQuotaExhaustedErrorMessage('Selected model is at capacity.')).toBe(false);
    expect(isQuotaExhaustedErrorMessage('401 Unauthorized')).toBe(false);
    // 402 必须是独立数字,不能被 token 数、耗时之类的数字串误命中。
    expect(isQuotaExhaustedErrorMessage('used 4021 tokens')).toBe(false);
  });

  it('正文里恰好出现的独立 402 不算状态码 —— 必须带 http/status/code 等上下文', () => {
    expect(isQuotaExhaustedErrorMessage('processed 402 rows before failing')).toBe(false);
    expect(isQuotaExhaustedErrorMessage('账单金额 402 元,写入失败')).toBe(false);
    expect(isQuotaExhaustedErrorMessage('line 402: unexpected token')).toBe(false);
  });
});
