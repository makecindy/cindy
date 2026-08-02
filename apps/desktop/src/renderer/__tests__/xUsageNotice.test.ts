// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeXUsage,
  isXUsageAcknowledged,
  resetXUsageNoticeMemoryState,
} from '@/state/xUsageNotice';

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

  it('localStorage 一直写不进去时, 多个账号在内存兜底里累积而不是互相覆盖', () => {
    // 上一条只测了**单个**账号, 所以漏掉了这个:storage 不可写时 readStored() 恒为空,
    // 写侧若只并 readStored, 第二个账号就把第一个从内存里覆盖掉 —— 用户切回第一个
    // 账号时又被拦一次, 而那次确认本该在本会话内一直有效(#1347 review 由 codex 指出)。
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    acknowledgeXUsage('x-user-1');
    acknowledgeXUsage('x-user-2');
    expect(isXUsageAcknowledged('x-user-1'), '第一个账号不该被第二个覆盖掉').toBe(true);
    expect(isXUsageAcknowledged('x-user-2')).toBe(true);
  });

  it('storage 从坏转好: 第一次写成功把内存里攒下的账号一并落盘', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    acknowledgeXUsage('x-user-1');
    acknowledgeXUsage('x-user-2');
    setItem.mockRestore();
    acknowledgeXUsage('x-user-3');

    // 三个都在 storage 里, 内存态已清空 —— 所以 clear 之后三个都回到未确认
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]').sort()).toEqual([
      'x-user-1',
      'x-user-2',
      'x-user-3',
    ]);
    localStorage.clear();
    for (const id of ['x-user-1', 'x-user-2', 'x-user-3']) {
      expect(isXUsageAcknowledged(id), `${id} 应随 storage 清空回到未确认`).toBe(false);
    }
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
