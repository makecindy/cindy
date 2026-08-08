// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionScopedTreeCollapsed } from '../useSessionScopedTreeCollapsed';
import { RSB_TREE_COLLAPSED_KEY_PREFIX, cleanupSessionLayoutPrefs } from '@/lib/sessionLayoutPrefs';

function kSession(sid: string): string {
  return `${RSB_TREE_COLLAPSED_KEY_PREFIX}${sid}`;
}

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('localStorage', memStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSessionScopedTreeCollapsed', () => {
  it('defaults to an expanded tree', () => {
    const { result } = renderHook(() => useSessionScopedTreeCollapsed('A'));
    expect(result.current.isTreeCollapsed).toBe(false);
  });

  it('persists only the collapsed state and restores it for the same session', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSessionScopedTreeCollapsed(sessionId),
      { initialProps: { sessionId: 'A' } },
    );

    act(() => result.current.toggleTreeCollapsed());
    expect(result.current.isTreeCollapsed).toBe(true);
    expect(localStorage.getItem(kSession('A'))).toBe('true');

    rerender({ sessionId: 'B' });
    expect(result.current.isTreeCollapsed).toBe(false);
    rerender({ sessionId: 'A' });
    expect(result.current.isTreeCollapsed).toBe(true);
  });

  it('keeps multiple mounted tabs for one session in sync', () => {
    const first = renderHook(() => useSessionScopedTreeCollapsed('A'));
    const second = renderHook(() => useSessionScopedTreeCollapsed('A'));

    act(() => first.result.current.toggleTreeCollapsed());

    expect(first.result.current.isTreeCollapsed).toBe(true);
    expect(second.result.current.isTreeCollapsed).toBe(true);

    act(() => second.result.current.toggleTreeCollapsed());

    expect(first.result.current.isTreeCollapsed).toBe(false);
    expect(second.result.current.isTreeCollapsed).toBe(false);
  });

  it('removes the preference when the tree is expanded again', () => {
    memStorage.setItem(kSession('A'), 'true');
    const { result } = renderHook(() => useSessionScopedTreeCollapsed('A'));

    act(() => result.current.setTreeCollapsed(false));
    expect(result.current.isTreeCollapsed).toBe(false);
    expect(localStorage.getItem(kSession('A'))).toBeNull();
  });

  it('does not persist a transient state without a session', () => {
    const { result } = renderHook(() => useSessionScopedTreeCollapsed(null));

    act(() => result.current.toggleTreeCollapsed());
    expect(result.current.isTreeCollapsed).toBe(true);
    expect(localStorage.getItem(`${RSB_TREE_COLLAPSED_KEY_PREFIX}null`)).toBeNull();
  });

  it('cleans up the session preference when the session is deleted', () => {
    memStorage.setItem(kSession('A'), 'true');
    cleanupSessionLayoutPrefs('A');
    expect(localStorage.getItem(kSession('A'))).toBeNull();
  });

  it('keeps the runtime state when localStorage writes fail', () => {
    // 配额耗尽 / private mode：写入抛错，但界面状态仍可在运行期切换（内存 override）。
    vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(memStorage, 'removeItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const { result } = renderHook(() => useSessionScopedTreeCollapsed('A'));
    expect(result.current.isTreeCollapsed).toBe(false);

    act(() => result.current.toggleTreeCollapsed());
    // 持久化失败，但运行期状态经内存 override 仍可切换。
    expect(result.current.isTreeCollapsed).toBe(true);

    act(() => result.current.toggleTreeCollapsed());
    expect(result.current.isTreeCollapsed).toBe(false);
  });
});
