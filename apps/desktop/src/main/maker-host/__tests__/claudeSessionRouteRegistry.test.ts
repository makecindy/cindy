/**
 * claude-session-route-registry 单测 —— per-session 生效计费路由观察表的语义:
 * 记录 / 读回 / 同值幂等(不重复通知)/ listener 异常隔离。
 * transform 侧的记录点覆盖见 claudeSessionRouteObservation.test.ts。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  onClaudeSessionRouteChange,
  readClaudeSessionRoute,
  recordClaudeSessionRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';

describe('claude-session-route-registry', () => {
  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
  });

  it('records and reads back the latest route per session', () => {
    expect(readClaudeSessionRoute('s1')).toBeNull();
    recordClaudeSessionRoute('s1', 'gateway');
    expect(readClaudeSessionRoute('s1')).toBe('gateway');
    // 凭证中途变化 → 下一个请求重判并纠正记录
    recordClaudeSessionRoute('s1', 'subscription');
    expect(readClaudeSessionRoute('s1')).toBe('subscription');
    expect(readClaudeSessionRoute('s2')).toBeNull();
  });

  it('notifies listeners only when the route value changes (idempotent hot path)', () => {
    const listener = vi.fn();
    onClaudeSessionRouteChange(listener);

    recordClaudeSessionRoute('s1', 'gateway');
    recordClaudeSessionRoute('s1', 'gateway');  // 同值: 每请求都会调, 不得重复广播
    recordClaudeSessionRoute('s1', 'gateway');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('s1', 'gateway');

    recordClaudeSessionRoute('s1', 'subscription');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('s1', 'subscription');
  });

  it('isolates listener exceptions from the routing hot path and other listeners', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    onClaudeSessionRouteChange(bad);
    onClaudeSessionRouteChange(good);

    expect(() => recordClaudeSessionRoute('s1', 'gateway')).not.toThrow();
    expect(good).toHaveBeenCalledWith('s1', 'gateway');
  });

  it('unsubscribes via the returned disposer', () => {
    const listener = vi.fn();
    const off = onClaudeSessionRouteChange(listener);
    off();
    recordClaudeSessionRoute('s1', 'gateway');
    expect(listener).not.toHaveBeenCalled();
  });
});
