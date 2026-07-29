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
  ])('matches quota wording: %s', (text) => {
    expect(isQuotaExceededMessage(text)).toBe(true);
  });

  it.each([
    'fetch failed: ECONNREFUSED 127.0.0.1:50750',
    '401 Unauthorized: Missing bearer token',
    'model gpt-x not found',
    'prompt is too long: 250000 tokens',
  ])('does not match non-quota errors: %s', (text) => {
    expect(isQuotaExceededMessage(text)).toBe(false);
  });
});
