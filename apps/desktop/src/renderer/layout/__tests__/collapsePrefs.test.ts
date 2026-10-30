// @vitest-environment jsdom

/**
 * collapsePrefs 单测(B2a)—— 折叠态统一读写按注册表 collapseMemory 声明分发:
 * global → 布局树;per-session → 会话桶(right-tabs 沿用历史键);none/未注册 → 惰性。
 * 外加旧左栏全局键的一次性迁移(memo 幂等 + 首帧同步返回)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLayout, type Layout } from '../../../shared/layoutTree';
import { RSB_COLLAPSED_KEY_PREFIX } from '@/lib/sessionLayoutPrefs';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest } from '../../panels/registry';
import {
  __resetCollapsePrefsForTests,
  clearPanelCollapsedRecord,
  migrateLegacySidebarCollapsed,
  readPanelCollapsed,
  readPanelCollapsedRecord,
  writePanelCollapsed,
} from '../collapsePrefs';

class MemLocalStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

function makeLayoutApiStub(initial?: Layout) {
  let layout = initial ?? createDefaultLayout();
  const api = {
    getStateSync: vi.fn(() => ({ layout })),
    set: vi.fn(async (next: Layout) => {
      layout = next;
      return { layout };
    }),
    reset: vi.fn(async () => ({ layout })),
    onChanged: vi.fn(() => () => undefined),
  };
  return { api, getLayout: () => layout };
}

let layoutStub: ReturnType<typeof makeLayoutApiStub>;

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemLocalStorage());
  layoutStub = makeLayoutApiStub();
  (window as unknown as { electronAPI: { layout: unknown } }).electronAPI = {
    layout: layoutStub.api,
  };
  // registry 重置后由 collapsePrefs 内部按需补注册(scopeOf 里的幂等 registerBuiltinPanels)。
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
  __resetCollapsePrefsForTests();
});

afterEach(() => {
  __resetCollapsePrefsForTests();
  vi.unstubAllGlobals();
});

describe('global 作用域(session-list → 布局树)', () => {
  it('record 读法只返回树上显式 collapsed 字段', () => {
    expect(readPanelCollapsedRecord('session-list', {})).toBeNull();

    writePanelCollapsed('session-list', {}, true);
    expect(readPanelCollapsedRecord('session-list', {})).toBe(true);

    writePanelCollapsed('session-list', {}, false);
    expect(readPanelCollapsedRecord('session-list', {})).toBe(false);
  });

  it('树上没写过 collapsed → 读 fallback', () => {
    expect(readPanelCollapsed('session-list', {}, false)).toBe(false);
    expect(readPanelCollapsed('session-list', {}, true)).toBe(true);
  });

  it('写 → setPaneCollapsed 进树;再读回同值', () => {
    writePanelCollapsed('session-list', {}, true);
    expect(layoutStub.api.set).toHaveBeenCalledTimes(1);
    expect(layoutStub.getLayout().sidebar.collapsed).toBe(true);
    expect(readPanelCollapsed('session-list', {}, false)).toBe(true);

    writePanelCollapsed('session-list', {}, false);
    expect(layoutStub.getLayout().sidebar.collapsed).toBe(false);
  });

  it('IPC 异常 → 读落 fallback,写静默', () => {
    layoutStub.api.getStateSync.mockImplementation(() => {
      throw new Error('ipc down');
    });
    expect(readPanelCollapsed('session-list', {}, true)).toBe(true);
    expect(() => writePanelCollapsed('session-list', {}, true)).not.toThrow();
  });
});

describe('per-session 作用域(right-tabs → 会话桶)', () => {
  it('withdraws only the failed default write, preserving a later same-value choice', () => {
    const ctx = { sessionId: 'failed-default' };
    const first = writePanelCollapsed('right-tabs', ctx, false)!;
    writePanelCollapsed('right-tabs', ctx, false);
    clearPanelCollapsedRecord('right-tabs', ctx, false, first);
    expect(readPanelCollapsedRecord('right-tabs', ctx)).toBe(false);
    const retry = writePanelCollapsed('right-tabs', ctx, false)!;
    clearPanelCollapsedRecord('right-tabs', ctx, false, retry);
    expect(readPanelCollapsedRecord('right-tabs', ctx)).toBeNull();
  });

  it('record 读法保留无记录 / false / true 三态', () => {
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'fresh' })).toBeNull();

    localStorage.setItem(`${RSB_COLLAPSED_KEY_PREFIX}open`, 'false');
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'open' })).toBe(false);

    localStorage.setItem(`${RSB_COLLAPSED_KEY_PREFIX}closed`, 'true');
    expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'closed' })).toBe(true);
  });

  it('right-tabs 沿用历史键前缀,老用户数据无缝', () => {
    localStorage.setItem(`${RSB_COLLAPSED_KEY_PREFIX}session-a`, 'false');
    expect(readPanelCollapsed('right-tabs', { sessionId: 'session-a' }, true)).toBe(false);

    writePanelCollapsed('right-tabs', { sessionId: 'session-b' }, false);
    expect(localStorage.getItem(`${RSB_COLLAPSED_KEY_PREFIX}session-b`)).toBe('false');
  });

  it('桶里没值 → fallback;历史解析语义:非 "false" 一律按 true', () => {
    expect(readPanelCollapsed('right-tabs', { sessionId: 'fresh' }, true)).toBe(true);
    localStorage.setItem(`${RSB_COLLAPSED_KEY_PREFIX}weird`, 'garbage');
    expect(readPanelCollapsed('right-tabs', { sessionId: 'weird' }, false)).toBe(true);
  });

  it('无 sessionId → 读 fallback、写 no-op', () => {
    expect(readPanelCollapsed('right-tabs', {}, true)).toBe(true);
    expect(readPanelCollapsedRecord('right-tabs', {})).toBeNull();
    writePanelCollapsed('right-tabs', {}, false);
    expect(localStorage.length).toBe(0);
  });

  it('会话间互不串扰', () => {
    writePanelCollapsed('right-tabs', { sessionId: 'a' }, false);
    writePanelCollapsed('right-tabs', { sessionId: 'b' }, true);
    expect(readPanelCollapsed('right-tabs', { sessionId: 'a' }, true)).toBe(false);
    expect(readPanelCollapsed('right-tabs', { sessionId: 'b' }, true)).toBe(true);
  });
});

describe('none / 未注册 kind', () => {
  it('chat-main(none)→ 读 fallback、写 no-op', () => {
    expect(readPanelCollapsed('chat-main', {}, false)).toBe(false);
    expect(readPanelCollapsedRecord('chat-main', {})).toBeNull();
    writePanelCollapsed('chat-main', {}, true);
    expect(layoutStub.api.set).not.toHaveBeenCalled();
  });

  it('未注册意识 kind → 读 fallback、写 no-op', () => {
    expect(readPanelCollapsed('ghost:ghost', {}, true)).toBe(true);
    expect(readPanelCollapsedRecord('ghost:ghost', {})).toBeNull();
    writePanelCollapsed('ghost:ghost', {}, true);
    expect(layoutStub.api.set).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
});

describe('migrateLegacySidebarCollapsed(旧 sidebar-collapsed 键 → 树)', () => {
  it('有旧值 → 同步返回、清键、写树', () => {
    localStorage.setItem('sidebar-collapsed', 'true');
    expect(migrateLegacySidebarCollapsed()).toBe(true);
    expect(localStorage.getItem('sidebar-collapsed')).toBeNull();
    expect(layoutStub.getLayout().sidebar.collapsed).toBe(true);
  });

  it('旧值为 false → 迁移 false(区别于"无旧值")', () => {
    localStorage.setItem('sidebar-collapsed', 'false');
    expect(migrateLegacySidebarCollapsed()).toBe(false);
    expect(layoutStub.getLayout().sidebar.collapsed).toBe(false);
  });

  it('无旧值 → null,不写树', () => {
    expect(migrateLegacySidebarCollapsed()).toBeNull();
    expect(layoutStub.api.set).not.toHaveBeenCalled();
  });

  it('memo 幂等:第二次调用吃缓存,树只写一次(StrictMode 双跑安全)', () => {
    localStorage.setItem('sidebar-collapsed', 'true');
    expect(migrateLegacySidebarCollapsed()).toBe(true);
    expect(migrateLegacySidebarCollapsed()).toBe(true);
    expect(layoutStub.api.set).toHaveBeenCalledTimes(1);
  });
});
