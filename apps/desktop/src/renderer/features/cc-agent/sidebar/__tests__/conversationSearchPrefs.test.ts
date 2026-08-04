/**
 * conversationSearchPrefs 单测 —— 会话搜索排序偏好的读写与容错。
 * ---------------------------------------------------------------------------
 * vitest 默认跑在 node 环境(apps/desktop/vitest.config.ts),localStorage 用内存 shim 注入,
 * 策略同 useSidebarFilter.test.ts。覆盖:默认值、往返、非法值回落、storage 缺失、读写抛异常。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SEARCH_SORT_BY,
  SEARCH_SORT_BY_KEY,
  loadSearchSortBy,
  persistSearchSortBy,
} from '../conversationSearchPrefs';

function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(idx: number) {
      return Array.from(store.keys())[idx] ?? null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = fakeStorage;
  return store;
}

function uninstallLocalStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
}

describe('loadSearchSortBy', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it('defaults to relevance when nothing was persisted', () => {
    expect(loadSearchSortBy()).toBe('relevance');
    expect(DEFAULT_SEARCH_SORT_BY).toBe('relevance');
  });

  it('returns every persisted legal value', () => {
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityDesc');
    expect(loadSearchSortBy()).toBe('activityDesc');
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityAsc');
    expect(loadSearchSortBy()).toBe('activityAsc');
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'relevance');
    expect(loadSearchSortBy()).toBe('relevance');
  });

  it('falls back to the default on an illegal value', () => {
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'bogus');
    expect(loadSearchSortBy()).toBe('relevance');
  });

  it('falls back to the default when localStorage is unavailable', () => {
    uninstallLocalStorage();
    expect(loadSearchSortBy()).toBe('relevance');
  });

  it('falls back to the default when getItem throws', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem() {
        throw new Error('security error');
      },
      setItem() {},
      removeItem() {},
      clear() {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(loadSearchSortBy()).toBe('relevance');
  });
});

describe('persistSearchSortBy', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it('round-trips the chosen sort', () => {
    persistSearchSortBy('activityDesc');
    expect(localStorage.getItem(SEARCH_SORT_BY_KEY)).toBe('activityDesc');
    expect(loadSearchSortBy()).toBe('activityDesc');

    persistSearchSortBy('relevance');
    expect(loadSearchSortBy()).toBe('relevance');
  });

  it('is a no-op (does not throw) when localStorage is unavailable', () => {
    uninstallLocalStorage();
    expect(() => persistSearchSortBy('activityAsc')).not.toThrow();
  });

  it('swallows setItem failures (quota / security errors)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem() {
        throw new Error('quota exceeded');
      },
      removeItem() {},
      clear() {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(() => persistSearchSortBy('activityAsc')).not.toThrow();
  });
});
