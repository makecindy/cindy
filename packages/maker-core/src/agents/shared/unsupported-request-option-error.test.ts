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

  it.each([
    ['generic invalid request', '400: {"error":{"message":"invalid api key"}}'],
    ['rate limit', '429: rate limit exceeded, retry later'],
    ['overload', 'overloaded_error: upstream is busy'],
    ['only the suggested field', 'prompt_cache_options is not supported by this endpoint'],
    ['only the rejected field, no verdict', 'request field prompt_cache_retention was forwarded'],
    ['empty', ''],
  ])('does not classify %s as a self-heal target', (_label, message) => {
    expect(isUnsupportedRequestOptionErrorMessage(message)).toBe(false);
    expect(unsupportedRequestOptionCompatOverride(message)).toBeUndefined();
  });
});
