import { describe, expect, it } from 'vitest';

import { classifyProviderError, isQuotaExceededMessage } from '../providerErrors';

describe('classifyProviderError — quota patterns', () => {
  it('classifies 402 as QUOTA_EXCEEDED regardless of body', () => {
    expect(classifyProviderError({ status: 402 }).code).toBe('QUOTA_EXCEEDED');
  });

  it('classifies LiteLLM budget wording on 400 as QUOTA_EXCEEDED', () => {
    // XD 网关(LiteLLM)点数耗尽的实际错误形状:ExceededBudget / Budget has been exceeded。
    expect(
      classifyProviderError({
        status: 400,
        bodyText:
          'litellm.BudgetExceededError: ExceededBudget: Crossed spend threshold. Budget has been exceeded! Current cost: 12.3, Max budget: 12.0',
      }).code,
    ).toBe('QUOTA_EXCEEDED');
  });

  it('keeps unrelated 400 bodies out of QUOTA_EXCEEDED', () => {
    expect(
      classifyProviderError({ status: 400, bodyText: 'unknown field: budget_hint' }).code,
    ).not.toBe('QUOTA_EXCEEDED');
  });

  it('classifies 429 + budget-exhaustion body as QUOTA_EXCEEDED (not retryable rate limiting)', () => {
    // LiteLLM 的预算耗尽会以 429 形状出现:Request rejected (429): ExceededBudget。
    const result = classifyProviderError({
      status: 429,
      bodyText: 'Request rejected (429): ExceededBudget: Budget has been exceeded!',
    });
    expect(result.code).toBe('QUOTA_EXCEEDED');
    expect(result.retryable).toBe(false);
  });

  it.each(['credits depleted', 'credits exhausted', 'credit balance too low'])(
    'classifies 429 + existing billing-depletion wording as QUOTA_EXCEEDED: %s',
    (bodyText) => {
      const result = classifyProviderError({ status: 429, bodyText });
      expect(result.code).toBe('QUOTA_EXCEEDED');
      expect(result.retryable).toBe(false);
    },
  );

  it('keeps per-minute metric quotas as retryable RATE_LIMITED (not billing)', () => {
    // Google 风格速率配额也带 quota exceeded 字样,但等待重试即可恢复,
    // 不是余额耗尽——不得判成不可重试并触发购买引导(review P1)。
    const result = classifyProviderError({
      status: 429,
      bodyText: "Quota exceeded for quota metric 'requests per minute' and limit 'RPM'",
    });
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.retryable).toBe(true);
  });

  it('keeps slash-form rate quotas as retryable RATE_LIMITED (not billing)', () => {
    // 紧凑斜杠写法(无 "per" 全称、也无 RPM/TPM 缩写)同样是速率配额,不得判成
    // 不可重试并触发购买引导(review P1 ×2)。
    const result = classifyProviderError({
      status: 429,
      bodyText: 'Quota exceeded: 100 requests/minute',
    });
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.retryable).toBe(true);
  });

  it('keeps abbreviated slash-form rate quotas as retryable RATE_LIMITED (not billing)', () => {
    // 缩写斜杠单位(/min、/sec)同样是速率配额,不得判成不可重试并触发购买
    // 引导(review P1 ×3)。
    const result = classifyProviderError({
      status: 429,
      bodyText: 'Quota exceeded: 100 requests/min',
    });
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.retryable).toBe(true);
  });

  it('keeps single-letter slash-form rate quotas as retryable RATE_LIMITED (not billing)', () => {
    // 单字母斜杠单位(/s)同样是速率配额,不得判成不可重试并触发购买引导
    // (review P1 ×4)。
    const result = classifyProviderError({
      status: 429,
      bodyText: 'Quota exceeded: 100 tokens/s',
    });
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.retryable).toBe(true);
  });

  it.each(['RPS', 'RPM', 'RPH', 'RPD', 'TPS', 'TPM', 'TPH', 'TPD'])(
    'keeps %s rate quota abbreviations as retryable RATE_LIMITED (not billing)',
    (unit) => {
      const result = classifyProviderError({
        status: 429,
        bodyText: `Quota exceeded: limit 500 ${unit}`,
      });
      expect(result.code).toBe('RATE_LIMITED');
      expect(result.retryable).toBe(true);
    },
  );

  it('keeps plain 429 as retryable RATE_LIMITED', () => {
    const result = classifyProviderError({
      status: 429,
      bodyText: 'Rate limit reached for requests. Please try again later.',
    });
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.retryable).toBe(true);
  });
});

describe('isQuotaExceededMessage — message-level matcher (ErrorBanner 消费)', () => {
  it.each([
    'litellm.BudgetExceededError: Budget has been exceeded! Current cost: 1.2',
    'ExceededBudget: Crossed spend threshold',
    'Error code: 429 - insufficient_quota: You exceeded your current quota',
    'API Error: 余额不足，请充值后再试',
    'insufficient balance for this request',
    'credits depleted',
    'credits exhausted',
    'credit balance too low',
    // makerChatStore 从结构化 errorStatus 保留的稳定后缀:正文即使只有通用
    // Payment Required,消息级 ErrorBanner 也必须识别为余额耗尽(review P2)。
    'Payment Required (HTTP 402)',
  ])('matches quota wording: %s', (text) => {
    expect(isQuotaExceededMessage(text)).toBe(true);
  });

  it.each([
    'fetch failed: ECONNREFUSED 127.0.0.1:50750',
    '401 Unauthorized: Missing bearer token',
    'Payment Required (HTTP 403)',
    'model gpt-x not found',
    'prompt is too long: 250000 tokens',
    // 速率型配额(每分钟请求/token 上限):quota exceeded 字样但可等待恢复,
    // 不得触发点数耗尽文案与购买引导(review P1)。
    "Quota exceeded for quota metric 'requests per minute' and limit 'RPM'",
    'Token quota exceeded: 30000 tokens per minute',
    // 仅缩写措辞(无 per minute 全称)同样是速率配额(review P1:\b 边界回归)。
    'Quota exceeded: limit 20,000 TPM',
    'quota exceeded, current RPM limit reached',
    // 紧凑斜杠写法(review P1 ×2)。
    'Quota exceeded: 100 requests/minute',
    'quota exceeded: 1M tokens/day',
    // 缩写斜杠写法(review P1 ×3)。
    'Quota exceeded: 100 requests/min',
    'quota exceeded: 500 tokens/sec',
    // 单字母斜杠写法(review P1 ×4)。
    'Quota exceeded: 100 tokens/s',
    'quota exceeded: 500 requests/s',
    // requests/tokens-per-second/hour/day 缩写(review P1 ×5)。
    'Quota exceeded: 50 RPD',
    'Quota exceeded: 100 RPH',
    'Quota exceeded: 250 RPS',
    'Quota exceeded: 500 TPS',
    'Quota exceeded: 10 TPH',
    'Quota exceeded: 1M TPD',
  ])('does not match non-quota errors: %s', (text) => {
    expect(isQuotaExceededMessage(text)).toBe(false);
  });
});
