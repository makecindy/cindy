/**
 * 渠道侧「正在自动重试 / 重试耗尽」文案映射。
 *
 * 断言的是判定边界: 只有过载类非终止 error 才出提示, 其它非终止 error 保持既有
 * 静默(它们的 message 是内部英文串, 外发等于把裸英文推给渠道用户)。
 */
import { describe, expect, it } from 'vitest';

import { overloadFailureNotice, overloadRetryNotice } from '../turnRetryNotice';

describe('overloadRetryNotice', () => {
  it('带次数的 Codex 容量重投 → 带进度的中文提示', () => {
    expect(
      overloadRetryNotice({
        message: 'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
      }),
    ).toBe('模型服务繁忙，正在自动重试（2/4）…');
  });

  it('Claude SDK 的 529 重试同样命中(状态码优先于文本)', () => {
    expect(
      overloadRetryNotice({
        message: 'SDK API request failed: overloaded (HTTP 529) (auto-retry 3/10)',
        errorStatus: 529,
      }),
    ).toBe('模型服务繁忙，正在自动重试（3/10）…');
  });

  it('拿不到次数时不编造分母', () => {
    expect(overloadRetryNotice({ message: 'model is at capacity' })).toBe(
      '模型服务繁忙，正在自动重试…',
    );
  });

  it('非过载的非终止 error 保持静默', () => {
    // #790 的 Codex 网络重连提示走同一条非终止 error 通道, 但渠道侧没有对应文案。
    expect(overloadRetryNotice({ message: 'stream disconnected (Reconnecting 1/3)' })).toBeNull();
    expect(overloadRetryNotice({ message: 'rate limit exceeded', errorStatus: 429 })).toBeNull();
    expect(overloadRetryNotice({ message: '缓存 capacity 已满' })).toBeNull();
  });

  it('形状异常一律静默, 不抛', () => {
    expect(overloadRetryNotice(null)).toBeNull();
    expect(overloadRetryNotice(undefined)).toBeNull();
    expect(overloadRetryNotice('at capacity')).toBeNull();
    expect(overloadRetryNotice({})).toBeNull();
    expect(overloadRetryNotice({ message: 42 })).toBeNull();
  });
});

describe('overloadFailureNotice', () => {
  it('过载终态 → 指明「在这里重发」而不是桌面端重试', () => {
    const notice = overloadFailureNotice(
      'Selected model is at capacity. Please try a different model.',
    );
    expect(notice).not.toBeNull();
    // 关键承诺: 桌面端点重试起的是新 turn, 结果不回流到这条渠道消息。
    expect(notice).toContain('在这里重发这条消息');
    expect(notice).toContain('不会回到这条消息里');
  });

  it('非过载错误沿用原文(返回 null 让调用方不改写)', () => {
    expect(overloadFailureNotice('process exited with code 1')).toBeNull();
    expect(overloadFailureNotice('Request timed out', 504)).toBeNull();
  });
});
