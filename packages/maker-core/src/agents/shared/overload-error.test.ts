/**
 * overload-error.test.ts
 * ---------------------------------------------------------------------------
 * 服务过载类错误识别与退避（maker-core 侧，决定 codex capacity 是否退避重投、
 * goal-host 是否安排短窗口续跑）。pattern 与 renderer 的
 * apps/desktop/src/renderer/utils/overloadError.ts 语义一致（两处同步，那边有
 * 同款用例）。
 *
 * 锁三件事：
 *  1. capacity / overloaded 两种形态分得开——它们由不同的一方负责重试；
 *  2. 不误伤业务文案里的 "capacity" 与模型输出里的 "overloaded"；
 *  3. 退避序列的边界与 jitter 幅度，防止有人顺手把上限调大烧掉用户额度。
 */

import { describe, it, expect } from 'vitest';

import {
  OVERLOAD_RETRY_MAX_ATTEMPTS,
  formatOverloadRetryMessage,
  isOverloadErrorMessage,
  overloadRetryDelayMs,
  parseOverloadError,
  parseOverloadRetryProgress,
} from './overload-error.js';

describe('parseOverloadError', () => {
  it('识别 Codex 的模型容量拒绝', () => {
    expect(parseOverloadError('Selected model is at capacity. Please try a different model.')).toEqual({
      kind: 'capacity',
    });
  });

  it('识别包在 Guardian 审批失败里的容量拒绝', () => {
    // 实录形态：容量抖动被 Codex 包装成"安全拒绝"，理由里才是真因。
    expect(
      parseOverloadError(
        'Automatic approval review failed: Selected model is at capacity. Please try a different model.',
      ),
    ).toEqual({ kind: 'capacity' });
  });

  it.each([529, undefined])('529 状态码优先判定为 overloaded（errorStatus=%s 时走文本）', (status) => {
    const message = status === 529 ? 'upstream busy' : 'overloaded_error: Overloaded';
    expect(parseOverloadError(message, status)).toEqual({ kind: 'overloaded' });
  });

  it('529 状态码的判定不依赖文本措辞', () => {
    expect(parseOverloadError('', 529)).toEqual({ kind: 'overloaded' });
  });

  it.each([
    // 业务/实现文案里的 capacity 不是平台容量问题
    'buffer capacity dropping → replayLossy',
    'dictionary capacity exceeded',
    'increase the cache capacity to 256',
    // 裸词 overloaded 常出现在模型输出与日志摘要里，不能当平台故障
    'the operator is overloaded for this type',
    // 邻近的其它错误类别不得被吞进来
    'Invalid API key',
    'context window exceeded',
    'rate limit exceeded',
    'Request timed out.',
    // 长数字包含 529 片段不误伤（\b 词边界）
    'order id 15294 rejected',
  ])('不误伤非过载消息: %s', (msg) => {
    expect(parseOverloadError(msg)).toBeNull();
  });

  it('isOverloadErrorMessage 与 parseOverloadError 判定一致', () => {
    expect(isOverloadErrorMessage('Selected model is at capacity.')).toBe(true);
    expect(isOverloadErrorMessage('buffer capacity dropping')).toBe(false);
    expect(isOverloadErrorMessage('upstream busy', 529)).toBe(true);
  });
});

describe('overloadRetryDelayMs', () => {
  it('无 jitter 时按 2s 起指数退避', () => {
    const mid = () => 0.5; // factor = 1
    expect(overloadRetryDelayMs(1, mid)).toBe(2_000);
    expect(overloadRetryDelayMs(2, mid)).toBe(4_000);
    expect(overloadRetryDelayMs(3, mid)).toBe(8_000);
    expect(overloadRetryDelayMs(4, mid)).toBe(16_000);
  });

  it('单次退避封顶 30s，不随 attempt 无限增长', () => {
    const mid = () => 0.5;
    expect(overloadRetryDelayMs(5, mid)).toBe(30_000);
    expect(overloadRetryDelayMs(50, mid)).toBe(30_000);
  });

  it('jitter 之后也不越过 30s 上限', () => {
    // 只封 base 的话触顶那几档乘上 1.25 会回到约 37.5s, 与常量声明的"单次上限"矛盾。
    expect(overloadRetryDelayMs(5, () => 0.999999)).toBe(30_000);
    expect(overloadRetryDelayMs(50, () => 0.999999)).toBe(30_000);
    // 下边界照常受 jitter 影响(触顶后只能往下拉, 打散作用仍在)。
    expect(overloadRetryDelayMs(5, () => 0)).toBe(22_500);
  });

  it('jitter 幅度为 ±25%', () => {
    expect(overloadRetryDelayMs(1, () => 0)).toBe(1_500);
    expect(overloadRetryDelayMs(1, () => 0.999999)).toBe(2_500);
  });

  it('attempt 小于 1 时退化为基数，不产生负指数', () => {
    const mid = () => 0.5;
    expect(overloadRetryDelayMs(0, mid)).toBe(2_000);
  });

  it('重试上限保持在小数值，避免容量故障期烧额度', () => {
    // 容量被拒时额度照扣，上限调大是有代价的改动，必须显式改测试。
    expect(OVERLOAD_RETRY_MAX_ATTEMPTS).toBe(4);
  });
});

describe('重投进度编码', () => {
  it('保留原始错误原文并追加进度后缀', () => {
    const raw = 'Selected model is at capacity. Please try a different model.';
    const formatted = formatOverloadRetryMessage(raw, 2, 4);
    expect(formatted).toBe(`${raw} (auto-retry 2/4)`);
    // 追加后仍必须能被识别为过载错误，否则 renderer 会退回裸英文分支。
    expect(isOverloadErrorMessage(formatted)).toBe(true);
  });

  it('format 与 parse 互为逆运算', () => {
    const formatted = formatOverloadRetryMessage('upstream at capacity', 3, 4);
    expect(parseOverloadRetryProgress(formatted)).toEqual({ attempt: 3, maxAttempts: 4 });
  });

  it.each([
    // 退避耗尽后的终止错误没有后缀 → 必须区分于"正在重试"
    'Selected model is at capacity. Please try a different model.',
    // 后缀必须在结尾，防止误配正文里提到的数字
    'auto-retry 2/4 was attempted earlier',
    // 越界/畸形不接受
    'foo (auto-retry 0/4)',
    'foo (auto-retry 5/4)',
    'foo (auto-retry 2)',
  ])('无有效进度后缀时返回 null: %s', (msg) => {
    expect(parseOverloadRetryProgress(msg)).toBeNull();
  });
});
