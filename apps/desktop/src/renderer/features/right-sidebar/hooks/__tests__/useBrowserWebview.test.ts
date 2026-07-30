// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseBrowserWebviewResult } from '../useBrowserWebview';
import {
  BROWSER_NAVIGATION_FUSE_LIMIT,
  useBrowserWebview,
} from '../useBrowserWebview';

interface MockWebview {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  getURL: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

let mockWebview: MockWebview;

type MockPoolEntry = {
  wrapper: HTMLDivElement;
  webview: MockWebview;
  guestFailure: null | {
    kind: 'render-process-gone' | 'unresponsive';
    reason: string;
  };
};

const poolMocks = vi.hoisted(() => ({
  releaseListeners: new Set<(tabId: string) => void>(),
  entryCreatedListeners: new Set<(tabId: string) => void>(),
  currentEntry: null as MockPoolEntry | null,
  fireRelease(tabId: string) {
    this.currentEntry = null;
    for (const cb of [...this.releaseListeners]) cb(tabId);
  },
  fireEntryCreated(tabId: string) {
    for (const cb of [...this.entryCreatedListeners]) cb(tabId);
  },
}));

const bridgeMocks = vi.hoisted(() => ({
  resourceCb: null as ((event: Record<string, unknown>) => void) | null,
  consumePendingKillCause: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../lib/browserWebviewPool', () => ({
  browserWebviewPool: {
    acquire: vi.fn(() => {
      if (poolMocks.currentEntry) return poolMocks.currentEntry;
      const entry: MockPoolEntry = {
        wrapper: document.createElement('div'),
        webview: mockWebview,
        guestFailure: null,
      };
      poolMocks.currentEntry = entry;
      poolMocks.fireEntryCreated('tab-a');
      return entry;
    }),
    peek: vi.fn(() => poolMocks.currentEntry),
    onRelease: vi.fn((cb: (tabId: string) => void) => {
      poolMocks.releaseListeners.add(cb);
      return () => poolMocks.releaseListeners.delete(cb);
    }),
    onEntryCreated: vi.fn((cb: (tabId: string) => void) => {
      poolMocks.entryCreatedListeners.add(cb);
      return () => poolMocks.entryCreatedListeners.delete(cb);
    }),
  },
}));

vi.mock('../../lib/rsbBrowserBridge', () => {
  bridgeMocks.consumePendingKillCause = vi.fn(() => null);
  return {
    reportRsbBrowserTab: vi.fn(),
    subscribeTabResourceEvent: vi.fn(
      (_tabId: string, cb: (event: Record<string, unknown>) => void) => {
        bridgeMocks.resourceCb = cb;
        return () => {
          bridgeMocks.resourceCb = null;
        };
      },
    ),
    consumePendingKillCause: (tabId: string) => bridgeMocks.consumePendingKillCause(tabId),
  };
});

function makeMockWebview(initialUrl: string): MockWebview {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch: (type: string, event: Record<string, unknown> = {}) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    getURL: vi.fn(() => initialUrl),
    loadURL: vi.fn(),
    setAttribute: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    stop: vi.fn(),
  };
}

function HookProbe({
  onResult,
  visible,
}: {
  onResult: (result: UseBrowserWebviewResult) => void;
  visible?: boolean;
}) {
  const result = useBrowserWebview('tab-a', 'session-a', visible);
  onResult(result);
  return null;
}

describe('useBrowserWebview', () => {
  beforeEach(() => {
    mockWebview = makeMockWebview('https://www.taptap.cn/');
    poolMocks.currentEntry = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    poolMocks.releaseListeners.clear();
    poolMocks.entryCreatedListeners.clear();
    bridgeMocks.resourceCb = null;
  });

  it('does not materialize a tab without explicit visibility', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    const acquire = vi.mocked(browserWebviewPool.acquire);
    let result: UseBrowserWebviewResult | null = null;

    render(createElement(HookProbe, { onResult: (next) => { result = next; } }));

    expect(acquire).not.toHaveBeenCalled();
    expect(result!.wrapper).toBeNull();
    expect(result!.webview).toBeNull();
  });

  it('does not materialize a hidden tab until it becomes visible', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    const acquire = vi.mocked(browserWebviewPool.acquire);
    let result: UseBrowserWebviewResult | null = null;
    const view = render(
      createElement(HookProbe, { visible: false, onResult: (next) => { result = next; } }),
    );

    expect(acquire).not.toHaveBeenCalled();
    expect(result!.wrapper).toBeNull();

    view.rerender(
      createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }),
    );

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(result!.wrapper).not.toBeNull();
    expect(result!.webview).toBe(mockWebview);
  });

  it('touches an existing entry through acquire when it becomes visible', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    const existing: MockPoolEntry = {
      wrapper: document.createElement('div'),
      webview: mockWebview,
      guestFailure: null,
    };
    poolMocks.currentEntry = existing;
    let result: UseBrowserWebviewResult | null = null;

    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    expect(browserWebviewPool.acquire).toHaveBeenCalledOnce();
    expect(result!.wrapper).toBe(existing.wrapper);
    expect(result!.webview).toBe(mockWebview);
  });

  it('observes an entry explicitly created while hidden without navigating it', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: false,
      onResult: (next) => { result = next; },
    }));

    act(() => {
      browserWebviewPool.acquire('tab-a');
    });

    expect(browserWebviewPool.acquire).toHaveBeenCalledOnce();
    expect(result!.wrapper).toBeNull();
    expect(result!.webview).toBe(mockWebview);
    expect(mockWebview.addEventListener).toHaveBeenCalledWith(
      'render-process-gone',
      expect.any(Function),
    );
    expect(mockWebview.loadURL).not.toHaveBeenCalled();
  });

  it('restores a guest crash captured before hidden hook listeners bind', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    bridgeMocks.consumePendingKillCause.mockReturnValueOnce('memory');
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: false,
      onResult: (next) => { result = next; },
    }));

    act(() => {
      const entry = browserWebviewPool.acquire('tab-a');
      entry.guestFailure = { kind: 'render-process-gone', reason: 'killed' };
    });

    expect(result!.crash).toEqual({ reason: 'killed', cause: 'resource-memory' });
  });

  it('restores the real webview URL when an optimistic navigation is aborted', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    expect(current().url).toBe('https://www.taptap.cn/');

    act(() => {
      current().navigate('https://www.google.com/');
    });
    expect(current().url).toBe('https://www.google.com/');

    act(() => {
      mockWebview.dispatch('did-fail-load', { errorCode: -3 });
    });

    expect(current().url).toBe('https://www.taptap.cn/');
    expect(current().isLoading).toBe(false);
  });

  it('does not publish redirect intermediates as committed URLs', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    act(() => {
      mockWebview.dispatch('did-redirect-navigation', {
        url: 'https://accounts.example.com/authorize',
      });
    });
    expect(current().url).toBe('https://www.taptap.cn/');

    act(() => {
      mockWebview.dispatch('did-navigate', {
        url: 'https://www.taptap.cn/auth/callback',
      });
    });
    expect(current().url).toBe('https://www.taptap.cn/auth/callback');
  });

  it('stops programmatic navigation bursts and reload clears the fuse', () => {
    let result: UseBrowserWebviewResult | null = null;
    const current = () => {
      if (result === null) throw new Error('hook result was not captured');
      return result;
    };
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    act(() => {
      for (let i = 0; i <= BROWSER_NAVIGATION_FUSE_LIMIT; i += 1) {
        current().navigate(`https://example.com/${i}`);
      }
    });

    expect(mockWebview.loadURL).toHaveBeenCalledTimes(BROWSER_NAVIGATION_FUSE_LIMIT);
    expect(mockWebview.stop).toHaveBeenCalledOnce();
    expect(current().crash).toEqual({ reason: 'navigation-loop' });
    expect(current().isLoading).toBe(false);

    act(() => current().reload());
    expect(mockWebview.reload).toHaveBeenCalledOnce();
    expect(current().crash).toBeNull();

    act(() => current().navigate('https://example.com/recovered'));
    expect(mockWebview.loadURL).toHaveBeenCalledTimes(BROWSER_NAVIGATION_FUSE_LIMIT + 1);
  });

  it('shows loading immediately on reload and resets after stop-loading', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    act(() => result!.reload());
    expect(mockWebview.reload).toHaveBeenCalledOnce();
    expect(result!.isLoading).toBe(true);

    act(() => mockWebview.dispatch('did-stop-loading'));
    expect(result!.isLoading).toBe(false);
  });

  it('rolls back optimistic loading when reload throws', () => {
    mockWebview.reload.mockImplementationOnce(() => {
      throw new Error('detached');
    });
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    act(() => result!.reload());
    expect(result!.isLoading).toBe(false);
  });

  it('leaves loading immediately when the user stops the page', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    act(() => result!.reload());
    expect(result!.isLoading).toBe(true);

    act(() => result!.stop());
    expect(mockWebview.stop).toHaveBeenCalledOnce();
    expect(result!.isLoading).toBe(false);
  });

  it('distinguishes an unobserved favicon from an explicitly missing favicon', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    expect(result!.favicon).toBeNull();

    act(() => {
      mockWebview.dispatch('page-favicon-updated', {
        favicons: ['', 'https://www.taptap.cn/favicon.ico'],
      });
    });
    expect(result!.favicon).toBe('https://www.taptap.cn/favicon.ico');

    act(() => {
      mockWebview.dispatch('page-favicon-updated', { favicons: [] });
    });
    expect(result!.favicon).toBe('');
  });

  it('does not treat a suppressed stale navigation report as a missing favicon', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    act(() => {
      mockWebview.dispatch('page-favicon-updated', {
        favicons: ['https://www.taptap.cn/favicon.ico'],
      });
      result!.navigate('https://example.com/');
    });
    expect(result!.favicon).toBeNull();

    act(() => {
      mockWebview.dispatch('did-navigate', { url: 'https://www.taptap.cn/' });
    });
    expect(result!.favicon).toBeNull();
    expect(result!.url).toBe('https://example.com/');
  });

  it('clears a stale favicon after guest navigation but keeps reload state independent', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, {
      visible: true,
      onResult: (next) => { result = next; },
    }));

    act(() => {
      mockWebview.dispatch('page-favicon-updated', {
        favicons: ['https://www.taptap.cn/favicon.ico'],
      });
    });
    expect(result!.favicon).toBe('https://www.taptap.cn/favicon.ico');

    act(() => {
      mockWebview.dispatch('did-navigate', { url: 'https://example.com/' });
    });
    expect(result!.favicon).toBe('');

    act(() => {
      mockWebview.dispatch('page-favicon-updated', {
        favicons: ['https://example.com/favicon.ico'],
      });
      result!.reload();
    });
    expect(result!.favicon).toBe('https://example.com/favicon.ico');
    expect(result!.isLoading).toBe(true);
  });

  it('re-acquires a fresh pool entry when an evicted tab becomes visible again', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    const acquire = vi.mocked(browserWebviewPool.acquire);
    let result: UseBrowserWebviewResult | null = null;
    const view = render(
      createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }),
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    const firstWrapper = result!.wrapper;
    const firstWebview = result!.webview;

    act(() => {
      for (let i = 0; i <= BROWSER_NAVIGATION_FUSE_LIMIT; i += 1) {
        result!.navigate(`https://example.com/old-${i}`);
      }
    });
    expect(result!.crash).toEqual({ reason: 'navigation-loop' });

    view.rerender(
      createElement(HookProbe, { visible: false, onResult: (next) => { result = next; } }),
    );

    // 后台淘汰(资源看门狗 / LRU):entry 被 release,不可见期间不得重建。
    act(() => poolMocks.fireRelease('tab-a'));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(result!.webview).toBeNull();

    // 重新可见 → 重新 acquire,拿到新一代 entry,观测 state 复位。
    mockWebview = makeMockWebview('');
    view.rerender(
      createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }),
    );
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(result!.wrapper).not.toBe(firstWrapper);
    expect(result!.webview).not.toBe(firstWebview);
    expect(result!.webview).toBe(mockWebview);
    expect(result!.url).toBe('');
    expect(result!.crash).toBeNull();

    act(() => result!.navigate('https://example.com/replacement'));
    expect(mockWebview.loadURL).toHaveBeenCalledWith('https://example.com/replacement');
  });

  it('does not re-acquire when a foreign tab is released', async () => {
    const { browserWebviewPool } = await import('../../lib/browserWebviewPool');
    const acquire = vi.mocked(browserWebviewPool.acquire);
    render(createElement(HookProbe, { visible: true, onResult: () => undefined }));
    expect(acquire).toHaveBeenCalledTimes(1);
    act(() => poolMocks.fireRelease('tab-other'));
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('marks a watchdog kill as resource-memory when the notice arrived first', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    bridgeMocks.consumePendingKillCause.mockReturnValueOnce('memory');
    act(() => {
      mockWebview.dispatch('render-process-gone', { details: { reason: 'killed' } });
    });
    expect(result!.crash).toEqual({ reason: 'killed', cause: 'resource-memory' });
  });

  it('upgrades the crash when gone + late notice land in the same React batch', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    // 两个事件在同一次 act(同一批,React 尚未 commit)内先后到达 ——
    // 订阅回调必须能看到 crash 已发生(靠同步写 ref,不能等渲染期镜像)。
    act(() => {
      mockWebview.dispatch('render-process-gone', { details: { reason: 'killed' } });
      bridgeMocks.resourceCb?.({ tabId: 'tab-a', kind: 'kill-notice', cause: 'memory' });
    });
    expect(result!.crash).toEqual({ reason: 'killed', cause: 'resource-memory' });
  });

  it('upgrades an existing crash on a late kill-notice and consumes the pending cause', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    // crash 事件先到:此时还没有 pending cause,banner 是笼统的 killed。
    act(() => {
      mockWebview.dispatch('render-process-gone', { details: { reason: 'killed' } });
    });
    expect(result!.crash).toEqual({ reason: 'killed' });

    // notice 晚到:升级 banner,并消费 pending cause(否则会错标下一次崩溃)。
    const callsBefore = bridgeMocks.consumePendingKillCause.mock.calls.length;
    act(() => {
      bridgeMocks.resourceCb?.({ tabId: 'tab-a', kind: 'kill-notice', cause: 'memory' });
    });
    expect(result!.crash).toEqual({ reason: 'killed', cause: 'resource-memory' });
    expect(bridgeMocks.consumePendingKillCause.mock.calls.length).toBe(callsBefore + 1);
  });

  it('shows and dismisses the cpu resource alert', () => {
    let result: UseBrowserWebviewResult | null = null;
    render(createElement(HookProbe, { visible: true, onResult: (next) => { result = next; } }));

    act(() => {
      bridgeMocks.resourceCb?.({ tabId: 'tab-a', kind: 'cpu-alert', cpuPercent: 95 });
    });
    expect(result!.resourceAlert).toEqual({ cpuPercent: 95 });

    act(() => result!.dismissResourceAlert());
    expect(result!.resourceAlert).toBeNull();
  });
});
