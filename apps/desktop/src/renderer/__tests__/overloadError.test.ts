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
  GOAL_OVERLOAD_LAST_REASON,
  UPSTREAM_OVERLOAD_REASON,
  isGoalCapacityBackoff,
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

  // ── 稳定 reason key 优先 ─────────────────────────────────────────────────────
  //
  // renderer 隔着 IPC 投影拿不到 codex 的原始 codexErrorInfo tag, 靠 maker-core 带上
  // 的 UPSTREAM_OVERLOAD_REASON 判定。这一组锁的是「codex 改了容量文案后 banner 仍显示
  // 本地化过载文案与重试进度, 而不是英文原文」。

  it('reason key 命中时不依赖文案措辞', () => {
    // message 故意完全不含 `at capacity`: 模拟 codex 改了措辞。
    expect(
      isOverloadErrorMessage('The upstream declined this request.', undefined, UPSTREAM_OVERLOAD_REASON),
    ).toBe(true);
    expect(
      parseOverloadError('The upstream declined this request.', undefined, UPSTREAM_OVERLOAD_REASON),
    ).toEqual({ kind: 'capacity' });
    // 空文案同理(host 合成的错误可能不带 message)。
    expect(isOverloadErrorMessage('', undefined, UPSTREAM_OVERLOAD_REASON)).toBe(true);
  });

  it('reason key 优先于 529(决定用户看到哪条文案)', () => {
    expect(parseOverloadError('overloaded_error', 529, UPSTREAM_OVERLOAD_REASON)).toEqual({
      kind: 'capacity',
    });
  });

  it('其它 reason key 不误判成过载', () => {
    for (const reason of ['silent-stop-exhausted', 'turn-failed', 'empty-response', 'app-exit-interrupted']) {
      expect(isOverloadErrorMessage('tool failed: file not found', undefined, reason)).toBe(false);
    }
  });

  it('reason 缺席时退回文案兜底(历史持久化错误行只有文案可用)', () => {
    expect(
      isOverloadErrorMessage('Selected model is at capacity.', undefined, undefined),
    ).toBe(true);
    expect(isOverloadErrorMessage('Selected model is at capacity.', undefined, null)).toBe(true);
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

describe('isGoalCapacityBackoff', () => {
  it('过载退避与账号限流分得开(两者共用 usageLimited 状态)', () => {
    // 状态标签与「恢复时刻」文案都靠这个判定分岔: 账号从没被限流时说「用量受限 /
    // X 点恢复」是假信息 —— 那个时刻只是"现在 + 60s 后重试"(review #844 codex P1)。
    expect(isGoalCapacityBackoff('usageLimited', GOAL_OVERLOAD_LAST_REASON)).toBe(true);
    expect(isGoalCapacityBackoff('usageLimited', 'usage limit reached')).toBe(false);
    expect(isGoalCapacityBackoff('usageLimited', null)).toBe(false);
    expect(isGoalCapacityBackoff('usageLimited', undefined)).toBe(false);
  });

  it('其它状态一律 false, 不受 reason 影响', () => {
    expect(isGoalCapacityBackoff('active', GOAL_OVERLOAD_LAST_REASON)).toBe(false);
    expect(isGoalCapacityBackoff('blocked', GOAL_OVERLOAD_LAST_REASON)).toBe(false);
    expect(isGoalCapacityBackoff(null, GOAL_OVERLOAD_LAST_REASON)).toBe(false);
  });
});
