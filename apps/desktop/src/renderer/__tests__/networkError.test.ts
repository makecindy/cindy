/**
 * networkError.test.ts
 * ---------------------------------------------------------------------------
 * ErrorBanner 网络类错误识别(renderer 侧)。pattern 与 maker-core 的
 * packages/maker-core/src/agents/shared/network-error.ts 语义一致(两处同步,
 * 那边有同款用例);此处锁 renderer 消费场景:Anthropic SDK 超时/连接错误原文
 * 必须命中(2026-07-13 "Request timed out" 裸英文横幅实锤),普通业务报错不误伤。
 */

import { describe, it, expect } from 'vitest';

import { isNetworkishErrorMessage, parseReconnectAttemptMessage } from '@/utils/networkError';

describe('isNetworkishErrorMessage', () => {
  it.each([
    // Anthropic SDK 重试耗尽后透传的终止型错误原文
    'Request timed out.',
    'API Error: The operation timed out.',
    'Connection error.',
    // 网关 / errno / fetch 存量场景抽查
    'unexpected status 502 Bad Gateway: upstream unreachable: AggregateError',
    'connect ECONNREFUSED 127.0.0.1:3333',
    'fetch failed',
    'socket hang up',
    'Reconnecting... 2/5',
    'Reconnecting… 3/5 (stream disconnected before completion)',
    'The operation timed out.',
    'OpenAI Responses stream ended before a terminal response event',
    // Cindy Responses bridge / compat-proxy 中途断流；Claude Code 再包 API Error:
    'API Error: upstream stream error: terminated',
    'upstream stream error: socket reset',
    'upstream stream error: Error: terminated',
  ])('matches networkish message: %s', (msg) => {
    expect(isNetworkishErrorMessage(msg)).toBe(true);
  });

  it.each([
    'Invalid API key',
    'thread not found',
    'context window exceeded',
    'Local tool operation timed out.',
    'Wrapped error: API Error: The operation timed out.',
    // 长数字不因包含 502 片段误伤(\b 词边界)
    'order id 15024 rejected',
    // 裸 terminated 是鉴权终态,不能当传输抖动
    'app_session_terminated',
    'Your session has ended. Please log in again. (app_session_terminated)',
  ])('does not match non-network message: %s', (msg) => {
    expect(isNetworkishErrorMessage(msg)).toBe(false);
  });
});

describe('parseReconnectAttemptMessage', () => {
  it('extracts valid Codex reconnect progress', () => {
    expect(parseReconnectAttemptMessage('Reconnecting... 3/5')).toEqual({
      attempt: 3,
      maxAttempts: 5,
    });
  });

  it.each(['Reconnecting...', 'Reconnecting... 0/5', 'Reconnecting... 6/5'])(
    'rejects malformed progress: %s',
    (msg) => {
      expect(parseReconnectAttemptMessage(msg)).toBeNull();
    },
  );
});
