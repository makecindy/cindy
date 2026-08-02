// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeXUsage,
  isXUsageAcknowledged,
  resetXUsageNoticeMemoryState,
} from '../state/xUsageNotice';

const STORAGE_KEY = 'xUsageNotice.acknowledgedPrincipals';

describe('xUsageNotice', () => {
  beforeEach(() => {
    localStorage.clear();
    resetXUsageNoticeMemoryState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetXUsageNoticeMemoryState();
  });

  it('确认过的账号判已知晓, 没确认过的不判', () => {
    expect(isXUsageAcknowledged('x-user-1')).toBe(false);
    acknowledgeXUsage('x-user-1');
    expect(isXUsageAcknowledged('x-user-1')).toBe(true);
    // 按 principalId 记账:换绑到另一个 X 账号是新的公开面, 应当再确认一次
    expect(isXUsageAcknowledged('x-user-2')).toBe(false);
  });

  it('空 principalId 既不记账也不判已知晓: 别把「拿不到账号 id」当成已确认', () => {
    acknowledgeXUsage('');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(isXUsageAcknowledged('')).toBe(false);
  });

  it('多次确认累积而不是互相覆盖', () => {
    acknowledgeXUsage('x-user-1');
    acknowledgeXUsage('x-user-2');
    expect(isXUsageAcknowledged('x-user-1')).toBe(true);
    expect(isXUsageAcknowledged('x-user-2')).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(2);
  });

  it('坏数据按「没确认过」处理, 不抛错', () => {
    // 手改过 / 旧 schema。宁可多弹一次告知, 也绝不让整个设置页因此白屏。
    for (const bad of ['not json', '{"a":1}', '42', '"x-user-1"']) {
      localStorage.setItem(STORAGE_KEY, bad);
      expect(() => isXUsageAcknowledged('x-user-1')).not.toThrow();
      expect(isXUsageAcknowledged('x-user-1')).toBe(false);
    }
  });

  it('数组里的非字符串项被过滤掉, 不影响同数组里的合法项', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([null, 1, { a: 1 }, 'x-user-1']));
    expect(isXUsageAcknowledged('x-user-1')).toBe(true);
  });

  it('localStorage 写不进去时退到进程内兜底: 本次会话内不重复弹', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    acknowledgeXUsage('x-user-1');
    expect(isXUsageAcknowledged('x-user-1')).toBe(true);
  });

  it('写成功后不留内存态: 别人清掉 key 之后本窗口要跟着回到未确认', () => {
    // 反方向的锚点。写成功时若同时置内存态, 跨窗口 clear 后本窗口会因为内存态
    // 永远判定已确认 —— inheritedSubscriptionNotice / providerOnboardingDismissal
    // 都踩过这一条。
    acknowledgeXUsage('x-user-1');
    expect(isXUsageAcknowledged('x-user-1')).toBe(true);
    localStorage.clear();
    expect(isXUsageAcknowledged('x-user-1')).toBe(false);
  });
});
