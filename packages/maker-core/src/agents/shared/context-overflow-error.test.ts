import { describe, expect, it } from 'vitest';

import { isContextOverflowErrorMessage } from './context-overflow-error.js';

/**
 * Pattern 与 desktop providerErrors.ts 的 CONTEXT_TOO_LONG_RE、renderer 镜像判定
 * 同语义(三处同步, 见模块注释)。正例覆盖四类真实供应商措辞, 反例守住与
 * overload / network 判定的互斥边界。
 */
describe('isContextOverflowErrorMessage', () => {
  it('matches the litellm/Azure phrasing from #1429 (with and without the error code)', () => {
    // 实踩原文: 结构化 code 字段随 JSON 一起出现
    expect(
      isContextOverflowErrorMessage(
        'API Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Your input exceeds the context window of this model. Please adjust your input and try again.", "type": "invalid_request_error", "param": "input", "code": "context_length_exceeded" } }',
      ),
    ).toBe(true);
    // 只透出 message 正文、code 字段被裁掉时, 语序补条("exceeds ... context window")仍须命中
    expect(
      isContextOverflowErrorMessage(
        'Your input exceeds the context window of this model. Please adjust your input and try again.',
      ),
    ).toBe(true);
  });

  it('matches Anthropic / OpenAI / structured gateway phrasings', () => {
    expect(
      isContextOverflowErrorMessage('prompt is too long: 250000 tokens > 200000 maximum'),
    ).toBe(true);
    expect(
      isContextOverflowErrorMessage(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
      ),
    ).toBe(true);
    expect(isContextOverflowErrorMessage('{"code": "context_length_exceeded"}')).toBe(true);
    expect(
      isContextOverflowErrorMessage(
        'API Error: 400 litellm.BadRequestError: XaiException - {"code":"invalid-argument","error":"This model\'s maximum prompt length is 500000 but the request contains 637815 tokens."}',
      ),
    ).toBe(true);
  });

  it('does NOT confuse rate, output, or tool argument limits with context overflow', () => {
    expect(
      isContextOverflowErrorMessage('Rate limit exceeded: too many tokens per minute'),
    ).toBe(false);
    expect(
      isContextOverflowErrorMessage('Maximum output tokens reached: too many tokens'),
    ).toBe(false);
    expect(
      isContextOverflowErrorMessage(
        'Tool argument validation failed: input length exceeds 1000 characters',
      ),
    ).toBe(false);
  });

  it('does NOT match overload / network / auth errors (disjoint recovery semantics)', () => {
    expect(
      isContextOverflowErrorMessage('Selected model is at capacity. Please try a different model.'),
    ).toBe(false);
    expect(isContextOverflowErrorMessage('overloaded_error: 529')).toBe(false);
    expect(isContextOverflowErrorMessage('fetch failed: ECONNREFUSED 127.0.0.1:443')).toBe(false);
    expect(isContextOverflowErrorMessage('401 Unauthorized: Missing bearer token')).toBe(false);
  });

  it('does NOT match ordinary text that merely mentions context or tokens', () => {
    expect(isContextOverflowErrorMessage('reading the context window documentation')).toBe(false);
    expect(isContextOverflowErrorMessage('token usage: 1200 input, 300 output')).toBe(false);
    expect(isContextOverflowErrorMessage('')).toBe(false);
  });
});
