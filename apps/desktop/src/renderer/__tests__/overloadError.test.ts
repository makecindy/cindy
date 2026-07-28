/**
 * overloadError.test.ts
 * ---------------------------------------------------------------------------
 * ErrorBanner 服务过载类错误识别(renderer 侧)。判定与 maker-core 的
 * packages/maker-core/src/agents/shared/overload-error.ts 语义一致(两处同步,
 * 那边有同款用例)。
 *
 * 此处锁 renderer 消费场景:
 *  1. Codex 容量拒绝与 Anthropic 529 都要命中,否则 banner 显示裸英文;
 *  2. 过载**不能**被误判成网络类——把容量问题说成"网络异常"会让用户白折腾自己
 *     的网络;
 *  3. 有无 `(auto-retry N/M)` 后缀决定显示"正在重试"还是"请换模型",两者不能混。
 */

import { describe, it, expect } from 'vitest';

import { isNetworkishErrorMessage } from '@/utils/networkError';
import {
  isOverloadErrorMessage,
  parseOverloadError,
  parseOverloadRetryProgress,
} from '@/utils/overloadError';

describe('isOverloadErrorMessage', () => {
  it.each([
    // Codex 透传的 OpenAI 原文(裸英文横幅的实际来源)
    'Selected model is at capacity. Please try a different model.',
    // 容量抖动被 Codex 包装成"安全拒绝"时,真因在 rationale 里
    'Automatic approval review failed: Selected model is at capacity. Please try a different model.',
    // 带重投进度后缀后仍必须命中,否则重试中的 banner 会退回裸英文
    'Selected model is at capacity. (auto-retry 2/4)',
    // Anthropic 529
    'SDK API request failed: overloaded_error (HTTP 529)',
  ])('matches overload message: %s', (msg) => {
    expect(isOverloadErrorMessage(msg)).toBe(true);
  });

  it('529 由 errorStatus 判定时不依赖文本措辞', () => {
    expect(isOverloadErrorMessage('upstream busy', 529)).toBe(true);
    expect(parseOverloadError('upstream busy', 529)).toEqual({ kind: 'overloaded' });
  });

  it.each([
    // 实现/业务文案里的 capacity 不是平台容量问题
    'buffer capacity dropping → replayLossy',
    'increase the cache capacity to 256',
    // 裸词 overloaded 常出现在模型输出里
    'the operator is overloaded for this type',
    // 邻近错误类别不得被吞
    'Invalid API key',
    'context window exceeded',
    'rate limit exceeded',
    // 长数字含 529 片段不误伤
    'order id 15294 rejected',
  ])('does not match non-overload message: %s', (msg) => {
    expect(isOverloadErrorMessage(msg)).toBe(false);
  });

  it('过载与网络类判定互不串台', () => {
    const capacity = 'Selected model is at capacity. Please try a different model.';
    // 容量问题绝不能走"网络异常"文案。
    expect(isNetworkishErrorMessage(capacity)).toBe(false);
    expect(isOverloadErrorMessage(capacity)).toBe(true);

    const network = 'unexpected status 502 Bad Gateway: upstream unreachable';
    expect(isNetworkishErrorMessage(network)).toBe(true);
    expect(isOverloadErrorMessage(network)).toBe(false);
  });
});

describe('parseOverloadRetryProgress', () => {
  it('提取重投进度', () => {
    expect(
      parseOverloadRetryProgress('Selected model is at capacity. (auto-retry 3/4)'),
    ).toEqual({ attempt: 3, maxAttempts: 4 });
  });

  it.each([
    // 退避耗尽后的终止错误没有后缀 → banner 必须改口说"换模型"
    'Selected model is at capacity. Please try a different model.',
    // 后缀必须在结尾
    'auto-retry 2/4 was attempted earlier',
    'foo (auto-retry 0/4)',
    'foo (auto-retry 5/4)',
  ])('无有效进度后缀时返回 null: %s', (msg) => {
    expect(parseOverloadRetryProgress(msg)).toBeNull();
  });
});
