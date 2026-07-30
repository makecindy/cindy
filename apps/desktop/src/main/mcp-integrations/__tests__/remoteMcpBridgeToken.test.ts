/**
 * remoteMcpBridgeToken 的进程内缓存生命周期:
 * 首次惰性生成并写 safeStorage,后续命中缓存;账号切换 clearAll 触发
 * secrets-cleared 监听后缓存必须失效 —— 否则旧账号远端 daemon 的 token
 * 在当前进程内仍可通过 bridge 鉴权(防串号,P0 回归)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  clearListeners: [] as Array<() => void>,
  reads: { count: 0 },
  writes: { count: 0 },
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readRemoteMcpBridgeToken: vi.fn(() => {
    h.reads.count += 1;
    return h.store.get('token') ?? null;
  }),
  writeRemoteMcpBridgeToken: vi.fn((value: string) => {
    h.writes.count += 1;
    h.store.set('token', value);
    return true;
  }),
  addProviderSecretsClearedListener: vi.fn((listener: () => void) => {
    h.clearListeners.push(listener);
    return () => undefined;
  }),
}));

import {
  getRemoteMcpBridgeToken,
  resetRemoteMcpBridgeTokenCacheForTests,
  setRemoteMcpBridgeTokenRotatedHook,
} from '../remoteMcpBridgeToken.js';

describe('remoteMcpBridgeToken', () => {
  beforeEach(() => {
    h.store.clear();
    h.clearListeners.length = 0;
    h.reads.count = 0;
    h.writes.count = 0;
    resetRemoteMcpBridgeTokenCacheForTests();
    setRemoteMcpBridgeTokenRotatedHook(null);
  });

  it('lazily generates and persists the token on first use, then serves from cache', () => {
    const first = getRemoteMcpBridgeToken();
    expect(first).toBeTruthy();
    expect(h.writes.count).toBe(1);

    const second = getRemoteMcpBridgeToken();
    expect(second).toBe(first);
    expect(h.reads.count).toBe(1); // 第二次走进程内缓存,不再读 safeStorage
  });

  it('invokes the rotated hook when secrets are cleared (R24 P2: remote CC must be invalidated)', () => {
    const hook = vi.fn();
    setRemoteMcpBridgeTokenRotatedHook(hook);
    getRemoteMcpBridgeToken();
    expect(hook).not.toHaveBeenCalled();
    for (const listener of h.clearListeners) listener();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('keeps the secrets-cleared flow working when the rotated hook throws', () => {
    setRemoteMcpBridgeTokenRotatedHook(() => {
      throw new Error('invalidate exploded');
    });
    getRemoteMcpBridgeToken();
    expect(() => {
      for (const listener of h.clearListeners) listener();
    }).not.toThrow();
  });

  it('registers the secrets-cleared listener on first use', () => {
    getRemoteMcpBridgeToken();
    expect(h.clearListeners).toHaveLength(1);
  });

  it('invalidates the process cache when secrets are cleared (account switch)', () => {
    const before = getRemoteMcpBridgeToken();
    expect(before).toBeTruthy();

    // 账号切换:safeStorage 被 clearAll 删除 + 触发清空监听。
    h.store.clear();
    for (const listener of h.clearListeners) listener();

    const after = getRemoteMcpBridgeToken();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before); // 重新生成,旧 token 在本进程内失效
    expect(h.writes.count).toBe(2);
  });
});
