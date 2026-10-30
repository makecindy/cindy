import { describe, expect, it } from 'vitest';
import { isVoiceInputStartRateLimited } from '../voiceInputStartError.js';

function apiError(code = 'RATE_LIMITED', statusCode = 429): Error {
  return Object.assign(new Error('upstream details must not determine the message'), { code, statusCode });
}

describe('voice input start rate-limit message', () => {
  it('recognizes a structured session rate limit', () => {
    expect(isVoiceInputStartRateLimited(apiError())).toBe(true);
  });

  it('recognizes the three-provider aggregate produced by ASR fallback', () => {
    expect(isVoiceInputStartRateLimited(new AggregateError([
      apiError(), apiError(), apiError(),
    ], 'All 3 voice input ASR providers failed to start'))).toBe(true);
  });

  it.each([
    new AggregateError([apiError(), new Error('connection timed out')]),
    new AggregateError([]),
    apiError('INTERNAL_ERROR', 503),
    apiError('RATE_LIMITED', 500),
    apiError('QUOTA_EXCEEDED', 429),
    new Error('RATE_LIMITED 429 语音请求过于频繁'),
    null,
  ])('keeps unknown, mixed, and unstructured failures generic (%#)', (error) => {
    expect(isVoiceInputStartRateLimited(error)).toBe(false);
  });
});
