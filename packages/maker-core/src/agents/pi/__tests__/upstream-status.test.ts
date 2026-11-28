/**
 * upstream-status.test.ts
 * ---------------------------------------------------------------------------
 * 上游 RPC 错误里的状态码提取：只取状态码本身，正文一律不外传。
 */

import { describe, expect, it } from 'vitest';

import { piUpstreamStatus } from '../upstream-status.js';

describe('piUpstreamStatus', () => {
  it.each([
    ['550 status code (no body)', 550],
    ['502 status code', 502],
    ['Error: 404 status code (no body)', 404],
    ['HTTP 503 status code from upstream', 503],
  ])('reads the status from: %s', (error, status) => {
    expect(piUpstreamStatus(error)).toBe(status);
  });

  it.each([
    undefined,
    '',
    'RPC response exceeded 16 MiB and was discarded.',
    'the model returned no content',
    'status code was not a number',
  ])('has no status for a non-status error: %s', (error) => {
    expect(piUpstreamStatus(error)).toBeUndefined();
  });
});
