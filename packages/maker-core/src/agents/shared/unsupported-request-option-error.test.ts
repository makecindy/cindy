import { describe, expect, it } from 'vitest';

import {
  UNSUPPORTED_REQUEST_OPTION_REASON,
  isUnsupportedRequestOptionErrorMessage,
  unsupportedRequestOptionCompatOverride,
} from './unsupported-request-option-error.js';

// 真实形态（2026-09-20，Console Go / opencode-go + glm-5.3-flash）。
const CONSOLE_GO_REJECTION =
  '400: {"param":"prompt_cache_retention","type":"invalid_request_error","message":'
  + '"Error from provider (Console Go): Upstream request failed: [invalid_request_error] '
  + '\\"prompt_cache_retention\\" is not supported by this endpoint; use \\"prompt_cache_options\\""}';

describe('unsupported request option error', () => {
  it('classifies the Console Go prompt_cache_retention rejection and maps the compat fix', () => {
    expect(isUnsupportedRequestOptionErrorMessage(CONSOLE_GO_REJECTION)).toBe(true);
    expect(unsupportedRequestOptionCompatOverride(CONSOLE_GO_REJECTION)).toEqual({
      supportsLongCacheRetention: false,
    });
    expect(UNSUPPORTED_REQUEST_OPTION_REASON).toBe('unsupported-request-option');
  });

  it('accepts an upstream that phrases the same rejection without the HTTP prefix', () => {
    expect(
      isUnsupportedRequestOptionErrorMessage(
        'invalid_request_error: prompt_cache_retention is unsupported here, use prompt_cache_options',
      ),
    ).toBe(true);
  });

  // issue #5878（2026-10-12）：政企/内网自定义 OpenAI 兼容网关只点名 prompt_cache_key。
  // Pi 1.0.2 实测：关掉 supportsLongCacheRetention 后 key 与 retention 一起消失。
  const CUSTOM_GATEWAY_KEY_REJECTION =
    '400: {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`",'
    + '"type":"invalid_request_error"}';

  it('classifies a custom gateway prompt_cache_key rejection and maps the same compat fix', () => {
    expect(isUnsupportedRequestOptionErrorMessage(CUSTOM_GATEWAY_KEY_REJECTION)).toBe(true);
    expect(unsupportedRequestOptionCompatOverride(CUSTOM_GATEWAY_KEY_REJECTION)).toEqual({
      supportsLongCacheRetention: false,
    });
  });

  it('accepts a prompt_cache_key rejection without markup or a suggested field', () => {
    expect(
      isUnsupportedRequestOptionErrorMessage('Unsupported parameter(s): prompt_cache_key'),
    ).toBe(true);
    expect(
      isUnsupportedRequestOptionErrorMessage(
        '400: {"param":"prompt_cache_key","message":"prompt_cache_key is not supported by this endpoint"}',
      ),
    ).toBe(true);
  });

  it.each([
    ['generic invalid request', '400: {"error":{"message":"invalid api key"}}'],
    ['rate limit', '429: rate limit exceeded, retry later'],
    ['overload', 'overloaded_error: upstream is busy'],
    ['only the suggested field', 'prompt_cache_options is not supported by this endpoint'],
    ['only the rejected field, no verdict', 'request field prompt_cache_retention was forwarded'],
    // 点名了别的参数：即使提到 prompt_cache_key 也不算（param 点名另一字段时同样拒绝）。
    ['unsupported parameter that is not a cache field', 'Unsupported parameter(s): `temperature`'],
    ['near-miss field name', 'Unsupported parameter(s): `prompt_cache_keyword`'],
    [
      'structured param names another cache-related field',
      '400: {"param":"prompt_cache_options","message":"Unsupported parameter(s): `prompt_cache_key`"}',
    ],
    // 裸 invalid_request_error 不再算「不支持」；结构化 param 不点名被拒字段也不算。
    [
      'generic invalid_request_error mentioning both fields',
      '400: {"type":"invalid_request_error","message":"prompt_cache_retention conflicts with prompt_cache_options"}',
    ],
    [
      'structured param names another field',
      '400: {"param":"prompt_cache_options","type":"invalid_request_error","message":"prompt_cache_retention is not supported by this endpoint; use prompt_cache_options"}',
    ],
    ['empty', ''],
  ])('does not classify %s as a self-heal target', (_label, message) => {
    expect(isUnsupportedRequestOptionErrorMessage(message)).toBe(false);
    expect(unsupportedRequestOptionCompatOverride(message)).toBeUndefined();
  });
});
