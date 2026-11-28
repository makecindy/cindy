/**
 * upstreamStatusError.test.ts
 * ---------------------------------------------------------------------------
 * 上游 5xx 无正文错误的识别(renderer 侧)。只认 "NNN status code" 这类上游
 * 状态原文,取状态码本身;4xx 与普通业务报错不误伤(配额、上下文超限各有专属
 * 分支,不能在这里被通用文案抢走)。
 */

import { describe, it, expect } from 'vitest';

import { parseUpstreamStatusError } from '@/utils/upstreamStatusError';

describe('parseUpstreamStatusError', () => {
  it.each([
    ['550 status code (no body)', '550'],
    ['Error: 550 status code (no body)', '550'],
    ['upstream returned 502 status code', '502'],
    ['503 status code', '503'],
    ['HTTP 500 status code from upstream', '500'],
  ])('reads the upstream status from: %s', (message, status) => {
    expect(parseUpstreamStatusError(message)).toEqual({ status });
  });

  it.each([
    // 4xx 是请求本身的问题,交给各自的专属分支。
    '400 status code (no body)',
    '429 status code',
    '404 status code',
    // 不是上游状态原文。
    'expecting 200 status code',
    'the model returned no content',
    '550 status codes were seen earlier',
  ])('ignores a non-upstream-5xx message: %s', (message) => {
    expect(parseUpstreamStatusError(message)).toBeNull();
  });
});
