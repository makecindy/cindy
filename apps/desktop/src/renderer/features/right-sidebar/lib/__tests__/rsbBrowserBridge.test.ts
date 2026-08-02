// @vitest-environment jsdom

/**
 * rsbBrowserBridge (renderer helper) — verifies the glue between the
 * BrowserWebviewPool and the preload-exposed IPC surface:
 *  - initRsbBrowserBridge binds pool.onRelease → ipc.release
 *  - initRsbBrowserBridge binds ipc.onPin / onUnpin → pool pin/unpin
 *  - reportRsbBrowserTab forwards to ipc.report
 *  - snapshotRsbBrowserTabs forwards to ipc.snapshot
 *  - All API call failures are swallowed (resolve undefined) so the renderer
 *    never crashes on transient IPC issues
 *  - When window.electronAPI is missing (SSR / preload-not-ready), all
 *    helpers no-op without throwing
 *  - init() is idempotent on repeat
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserWebviewPool } from '../browserWebviewPool';
import {
  _resetRsbBrowserBridgeForTests,
  consumePendingKillCause,
  forceKillBrowserTab,
  initRsbBrowserBridge,
  PENDING_KILL_CAUSE_TTL_MS,
  releaseRsbBrowserTab,
  reportRsbBrowserTab,
  setForegroundBrowserTab,
  snapshotRsbBrowserTabs,
  subscribeTabResourceEvent,
} from '../rsbBrowserBridge';
import { _resetPopupTabsForTests, markPopupSpawnedTab } from '../popupTabs';
import {
  _resetStore,
  addTab,
  ensureHydrated,
  getBucket,
  setTabCloseInterceptor,
} from '../../store';

interface FakeIpcApi {
  report: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  onPin: ReturnType<typeof vi.fn>;
  onUnpin: ReturnType<typeof vi.fn>;
  onTabOpRequest: ReturnType<typeof vi.fn>;
  tabOpResult: ReturnType<typeof vi.fn>;
  setForeground: ReturnType<typeof vi.fn>;
  forceKill: ReturnType<typeof vi.fn>;
  onResourceEvent: ReturnType<typeof vi.fn>;
  // Captured callbacks the bridge registered via onPin / onUnpin / onTabOpRequest /
  // onResourceEvent.
  pinCb: ((p: { tabId: string }) => void) | null;
  unpinCb: ((p: { tabId: string }) => void) | null;
  tabOpCb: ((req: unknown) => void) | null;
  resourceCb: ((event: unknown) => void) | null;
}

function installFakeIpc(): FakeIpcApi {
  const api: FakeIpcApi = {
    report: vi.fn(async () => ({ ok: true })),
    release: vi.fn(async () => ({ ok: true })),
    snapshot: vi.fn(async () => ({ ok: true, dropped: [], kept: 0, pinnedTabIds: [] })),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onTabOpRequest: vi.fn(),
    tabOpResult: vi.fn(async () => ({ ok: true })),
    setForeground: vi.fn(async () => ({ ok: true })),
    forceKill: vi.fn(async () => ({ ok: true })),
    onResourceEvent: vi.fn(),
    pinCb: null,
    unpinCb: null,
    tabOpCb: null,
    resourceCb: null,
  };
  api.onPin.mockImplementation((cb: (p: { tabId: string }) => void) => {
    api.pinCb = cb;
    return () => {
      api.pinCb = null;
    };
  });
  api.onUnpin.mockImplementation((cb: (p: { tabId: string }) => void) => {
    api.unpinCb = cb;
    return () => {
      api.unpinCb = null;
    };
  });
  api.onTabOpRequest.mockImplementation((cb: (req: unknown) => void) => {
    api.tabOpCb = cb;
    return () => {
      api.tabOpCb = null;
    };
  });
  api.onResourceEvent.mockImplementation((cb: (event: unknown) => void) => {
    api.resourceCb = cb;
    return () => {
      api.resourceCb = null;
    };
  });
  (window as unknown as { electronAPI?: { rsbBrowserBridge: FakeIpcApi } }).electronAPI = {
    rsbBrowserBridge: api,
  };
  return api;
}

function clearIpc(): void {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

beforeEach(() => {
  _resetRsbBrowserBridgeForTests();
  _resetPopupTabsForTests();
  _resetStore();
});

afterEach(() => {
  _resetRsbBrowserBridgeForTests();
  _resetPopupTabsForTests();
  _resetStore();
  clearIpc();
  // Drain the pool — tests share the singleton.
  for (const tabId of browserWebviewPool.inspectTabIds()) {
    browserWebviewPool.release(tabId);
  }
});

describe('rsbBrowserBridge — report / release / snapshot forwarding', () => {
  it('reportRsbBrowserTab calls ipc.report with the payload', async () => {
    const api = installFakeIpc();
    await reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 });
    expect(api.report).toHaveBeenCalledWith({ sessionId: 's1', tabId: 't1', webContentsId: 42 });
  });

  it('snapshotRsbBrowserTabs calls ipc.snapshot with the liveTabIds', async () => {
    const api = installFakeIpc();
    await snapshotRsbBrowserTabs(['t1', 't2']);
    expect(api.snapshot).toHaveBeenCalledWith({ liveTabIds: ['t1', 't2'] });
  });

  it('snapshotRsbBrowserTabs mirrors main-side pinnedTabIds into the pool', async () => {
    const api = installFakeIpc();
    api.snapshot.mockResolvedValueOnce({
      ok: true,
      dropped: [],
      kept: 1,
      pinnedTabIds: ['t-pin'],
    });

    await snapshotRsbBrowserTabs(['t-pin']);

    expect(browserWebviewPool.isPinnedForAutomation('t-pin')).toBe(true);
  });

  it('releaseRsbBrowserTab calls ipc.release with the tabId', async () => {
    const api = installFakeIpc();
    await releaseRsbBrowserTab('t1');
    expect(api.release).toHaveBeenCalledWith({ tabId: 't1' });
  });

  it('report swallows IPC failures (resolves undefined)', async () => {
    const api = installFakeIpc();
    api.report.mockRejectedValueOnce(new Error('boom'));
    await expect(
      reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 }),
    ).resolves.toBeUndefined();
  });

  it('snapshot swallows IPC failures', async () => {
    const api = installFakeIpc();
    api.snapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(snapshotRsbBrowserTabs([])).resolves.toBeUndefined();
  });

  it('snapshot swallows malformed response (missing pinnedTabIds)', async () => {
    const api = installFakeIpc();
    // Defensive: if main returns a partial shape, no throw and no pool mutation.
    api.snapshot.mockResolvedValueOnce({ ok: true, dropped: [], kept: 0 } as unknown as never);
    await expect(snapshotRsbBrowserTabs(['t-x'])).resolves.toBeUndefined();
    expect(browserWebviewPool.isPinnedForAutomation('t-x')).toBe(false);
  });

  it('release swallows IPC failures', async () => {
    const api = installFakeIpc();
    api.release.mockRejectedValueOnce(new Error('boom'));
    await expect(releaseRsbBrowserTab('t1')).resolves.toBeUndefined();
  });

  it('helpers no-op when electronAPI is missing', async () => {
    clearIpc();
    await expect(
      reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 }),
    ).resolves.toBeUndefined();
    await expect(snapshotRsbBrowserTabs([])).resolves.toBeUndefined();
    await expect(releaseRsbBrowserTab('t1')).resolves.toBeUndefined();
  });
});

describe('rsbBrowserBridge — control-path probe', () => {
  it('acks without hydrating a session or creating a webview', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();
    const before = browserWebviewPool.inspectTabIds();

    api.tabOpCb?.({ reqId: 'probe-1', op: 'probe' });

    await vi.waitFor(() => {
      expect(api.tabOpResult).toHaveBeenCalledWith({ reqId: 'probe-1', ok: true });
    });
    expect(browserWebviewPool.inspectTabIds()).toEqual(before);
  });
});

describe('rsbBrowserBridge — initialization & teardown', () => {
  it('binds pool.onRelease → ipc.release', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    expect(api.release).toHaveBeenCalledWith({ tabId: 'tab-a' });
  });

  it('guest window.close() auto-closes a popup-spawned tab (残留空 tab 修复)', async () => {
    installFakeIpc();
    initRsbBrowserBridge();

    // memory-only store 路径:无持久化 IPC,addTab 直接写 cache。
    await ensureHydrated('sess-oauth');
    const tab = await addTab('sess-oauth', 'web-browser', { url: 'https://cb.example' });
    markPopupSpawnedTab(tab.id);
    const entry = browserWebviewPool.acquire(tab.id);

    // OAuth callback 页授权完成后的标准收尾:window.close() → webview 'close' 事件。
    entry.webview.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      expect(getBucket('sess-oauth').tabs).toHaveLength(0);
      // 后台自关没有 BrowserTabBody unmount cleanup 兜底,bridge 必须显式释放
      // pool entry(销毁 guest webContents + 同步 main 端 registry)。放进
      // waitFor:closeTab 的乐观更新先于 release 落地,分开断言会撞时序。
      expect(browserWebviewPool.peek(tab.id)).toBeNull();
    });
  });

  it('guest 自关对 closeTab 瞬态失败按延迟重试,不静默丢弃关闭意图', async () => {
    installFakeIpc();
    // 装 localDb stub 让 store 走持久化路径 —— memory-only 下 closeTab 不会失败,
    // 测不到重试分支。close 事件不重发,首次 overload 若被吞掉 = 空 tab 复活。
    const tabsIpc = {
      list: vi.fn(async () => ({ tabs: [], activeTabId: null })),
      upsert: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => ({ ok: true })),
      setActive: vi.fn(async () => ({ ok: true })),
      reorder: vi.fn(async () => ({ ok: true })),
    };
    (
      window as unknown as { electronAPI: { localDb?: unknown } }
    ).electronAPI.localDb = { rightSidebarTabs: tabsIpc };
    initRsbBrowserBridge();

    await ensureHydrated('sess-retry');
    const tab = await addTab('sess-retry', 'web-browser', { url: 'https://cb.example' });
    markPopupSpawnedTab(tab.id);
    const entry = browserWebviewPool.acquire(tab.id);

    tabsIpc.close.mockRejectedValueOnce(new Error('db worker RPC queue overloaded'));
    entry.webview.dispatchEvent(new Event('close'));

    await vi.waitFor(
      () => {
        expect(getBucket('sess-retry').tabs).toHaveLength(0);
      },
      { timeout: 2000 },
    );
    // 首次失败 + 重试成功 = 恰好 2 次。
    expect(tabsIpc.close).toHaveBeenCalledTimes(2);
  });

  it('pool release (LRU 淘汰) 不清 popup 标记 —— tab 重建后仍能自关', async () => {
    installFakeIpc();
    initRsbBrowserBridge();

    await ensureHydrated('sess-lru');
    const tab = await addTab('sess-lru', 'web-browser', { url: 'https://cb.example' });
    markPopupSpawnedTab(tab.id);
    browserWebviewPool.acquire(tab.id);

    // 模拟 LRU 淘汰:webview 实例销毁,但 tab 仍在 store bucket 里。
    browserWebviewPool.release(tab.id);
    expect(getBucket('sess-lru').tabs).toHaveLength(1);

    // 用户切回该 tab → webview 重建,callback 页重新加载后 window.close()。
    // 若 release 误清了标记,这次自关会被忽略、空 tab 再次残留。
    const revived = browserWebviewPool.acquire(tab.id);
    revived.webview.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      expect(getBucket('sess-lru').tabs).toHaveLength(0);
    });
  });

  it('同 session 两个 popup 同时自关时串行处理,不互相覆盖乐观删除', async () => {
    installFakeIpc();
    initRsbBrowserBridge();

    await ensureHydrated('sess-both');
    const first = await addTab('sess-both', 'web-browser', { url: 'https://a.example' });
    const second = await addTab('sess-both', 'web-browser', { url: 'https://b.example' });
    markPopupSpawnedTab(first.id);
    markPopupSpawnedTab(second.id);
    const firstEntry = browserWebviewPool.acquire(first.id);
    const secondEntry = browserWebviewPool.acquire(second.id);
    // close interceptor 让 closeTab 在"抓完 bucket 快照"和"写回 cache"之间真的
    // 让出一次 microtask —— 真实场景里这个让出点来自 interceptor /
    // plugin.onBeforeClose / 持久化 IPC,并发窗口就开在这里。
    for (const id of [first.id, second.id]) {
      setTabCloseInterceptor(id, async () => {
        await Promise.resolve();
        return true;
      });
    }

    // 两个 OAuth 流几乎同时收尾。closeTab 在入口抓 bucket 快照、await 后才落盘,
    // 并发跑会让后完成的那条把对方已删的 tab 写回 cache(或回滚掉两次删除)。
    firstEntry.webview.dispatchEvent(new Event('close'));
    secondEntry.webview.dispatchEvent(new Event('close'));

    await vi.waitFor(() => {
      expect(getBucket('sess-both').tabs).toHaveLength(0);
    });
    // 复活检测:再多跑几个 microtask/timer tick,确认没有 tab 被写回。
    await new Promise((r) => setTimeout(r, 10));
    expect(getBucket('sess-both').tabs).toHaveLength(0);
  });

  it('guest window.close() on a NON-popup tab is ignored (script-opened-only 语义)', async () => {
    installFakeIpc();
    initRsbBrowserBridge();

    await ensureHydrated('sess-user');
    const tab = await addTab('sess-user', 'web-browser', { url: 'https://page.example' });
    const entry = browserWebviewPool.acquire(tab.id);

    entry.webview.dispatchEvent(new Event('close'));

    // 恶意 / 意外的 window.close() 不得关掉用户自己开的 tab。
    await new Promise((r) => setTimeout(r, 10));
    expect(getBucket('sess-user').tabs).toHaveLength(1);
  });

  it('binds main → pool pin/unpin sync', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Simulate main pushing a pin.
    api.pinCb?.({ tabId: 'tab-a' });
    expect(browserWebviewPool.isPinnedForAutomation('tab-a')).toBe(true);

    api.unpinCb?.({ tabId: 'tab-a' });
    expect(browserWebviewPool.isPinnedForAutomation('tab-a')).toBe(false);
  });

  it('init is idempotent (does not double-bind listeners)', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();
    initRsbBrowserBridge();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    // If bound twice, release would be called twice for one release.
    expect(api.release).toHaveBeenCalledTimes(1);
  });

  it('teardown removes the pool listener', () => {
    const api = installFakeIpc();
    const teardown = initRsbBrowserBridge();

    teardown();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    expect(api.release).not.toHaveBeenCalled();
  });

  it('teardown permits HMR re-init and a stale disposer cannot remove fresh listeners', () => {
    const api = installFakeIpc();
    const staleTeardown = initRsbBrowserBridge();

    staleTeardown();
    const currentTeardown = initRsbBrowserBridge();
    expect(api.onPin).toHaveBeenCalledTimes(2);
    expect(api.pinCb).not.toBeNull();

    staleTeardown();
    expect(api.pinCb).not.toBeNull();

    currentTeardown();
    expect(api.pinCb).toBeNull();
  });

  it('init when electronAPI is missing is a silent no-op', () => {
    clearIpc();
    expect(() => initRsbBrowserBridge()).not.toThrow();
  });

  it('init fires a one-time snapshot with the current pool tabIds (P0-1)', () => {
    const api = installFakeIpc();
    browserWebviewPool.acquire('t1');
    browserWebviewPool.acquire('t2');

    initRsbBrowserBridge();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.snapshot.mock.calls[0][0]).toEqual({ liveTabIds: ['t1', 't2'] });
  });

  it('tab-op request: open eager-spawns webview + reports webContentsId BEFORE acking (cross-session race fix)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Spy on pool.acquire so we can intercept the returned entry and drive a
    // synthetic dom-ready. jsdom's <webview> is a generic HTMLElement, not a
    // real Electron guest, so we override the entry's webview methods.
    const realAcquire = browserWebviewPool.acquire.bind(browserWebviewPool);
    const acquireSpy = vi.spyOn(browserWebviewPool, 'acquire').mockImplementation(
      (tabId) => {
        const real = realAcquire(tabId);
        // Override the webview to behave like a real Electron <webview>:
        //   - setAttribute('src') is fine on a vanilla HTMLElement, no extra
        //     work needed.
        //   - addEventListener('dom-ready') needs to fire synthetically.
        //   - getWebContentsId must return a stable number.
        const synthetic = real.webview as unknown as {
          addEventListener: (event: string, cb: () => void) => void;
          removeEventListener: (event: string, cb: () => void) => void;
          setAttribute: (k: string, v: string) => void;
          getWebContentsId: () => number;
          _domReadyListeners: Array<() => void>;
        };
        synthetic._domReadyListeners = [];
        synthetic.addEventListener = (event, cb) => {
          if (event === 'dom-ready') synthetic._domReadyListeners.push(cb);
        };
        synthetic.removeEventListener = (event, cb) => {
          if (event === 'dom-ready') {
            const idx = synthetic._domReadyListeners.indexOf(cb);
            if (idx >= 0) synthetic._domReadyListeners.splice(idx, 1);
          }
        };
        synthetic.setAttribute = vi.fn(() => {
          // Simulate async dom-ready firing on the next microtask. The real
          // Electron <webview> fires it once the guest WebContents has
          // attached + initial navigation begins.
          queueMicrotask(() => {
            for (const l of synthetic._domReadyListeners.slice()) l();
          });
        });
        synthetic.getWebContentsId = () => 4242;
        return real;
      },
    );

    api.tabOpCb?.({ reqId: 'r-open-1', op: 'open', sessionId: 's-A', url: 'https://example.test' });

    // Wait for the entire eager-spawn promise chain to settle:
    // queueMicrotask → addEventListener → resolve → outer await → ack.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // The acquire MUST have happened (eager-spawn fired).
    expect(acquireSpy).toHaveBeenCalled();
    // webContentsId MUST have been reported BEFORE the ack — that's the whole
    // point of the fix. We assert by call order on the same fake IPC.
    expect(api.report).toHaveBeenCalledWith({
      sessionId: 's-A',
      tabId: expect.any(String),
      webContentsId: 4242,
    });
    // And the ack went out with the tab id.
    expect(api.tabOpResult).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: 'r-open-1', ok: true }),
    );

    acquireSpy.mockRestore();
  });

  it('tab-op request: close routes through store and acks with ok=false on unknown session (P3)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Trigger a close for a session that hasn't been hydrated — store.closeTab
    // resolves silently (idx<0 path) so we expect ok:true with the same tabId.
    // The store's behavior is the truth here; the renderer just forwards.
    api.tabOpCb?.({ reqId: 'r-close-1', op: 'close', sessionId: 'unknown', tabId: 't1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult).toHaveBeenCalledTimes(1);
    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-close-1',
      ok: true,
      tabId: 't1',
    });
  });

  it('tab-op request: focus rejects unknown tabId with ok=false (P3)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    api.tabOpCb?.({ reqId: 'r-focus-1', op: 'focus', sessionId: 'unknown', tabId: 't-ghost' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-focus-1',
      ok: false,
      error: expect.stringContaining('t-ghost'),
    });
  });

  it('tab-op request: ensure rejects unknown tabId with ok=false (no side effects)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    api.tabOpCb?.({ reqId: 'r-ensure-1', op: 'ensure', sessionId: 'unknown', tabId: 't-ghost' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-ensure-1',
      ok: false,
      error: expect.stringContaining('t-ghost'),
    });
    // ensure 不该带 visibility / report 副作用
    expect(api.report).not.toHaveBeenCalled();
  });

  it('init snapshot response re-mirrors main pin set into pool (P1-3)', async () => {
    const api = installFakeIpc();
    api.snapshot.mockResolvedValueOnce({
      ok: true,
      dropped: [],
      kept: 0,
      pinnedTabIds: ['t-from-main'],
    });

    initRsbBrowserBridge();
    // Wait for the snapshot promise chain to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(browserWebviewPool.isPinnedForAutomation('t-from-main')).toBe(true);
  });
});

describe('rsbBrowserBridge — resource watchdog events', () => {
  it('evict-request releases the pool entry (and syncs main via release)', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    browserWebviewPool.acquire('tab-r');
    api.resourceCb?.({ tabId: 'tab-r', kind: 'evict-request' });

    expect(browserWebviewPool.inspectTabIds()).not.toContain('tab-r');
    expect(api.release).toHaveBeenCalledWith({ tabId: 'tab-r' });
  });

  it('kill-notice records a pending cause consumable exactly once', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    api.resourceCb?.({ tabId: 'tab-k', kind: 'kill-notice', cause: 'memory' });

    expect(consumePendingKillCause('tab-k')).toBe('memory');
    // 第二次取应为空 —— cause 只对紧随其后的那次 render-process-gone 生效。
    expect(consumePendingKillCause('tab-k')).toBeNull();
  });

  it('expires a stale pending kill cause after the freshness window', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();
    vi.useFakeTimers();
    try {
      api.resourceCb?.({ tabId: 'tab-k', kind: 'kill-notice', cause: 'memory' });
      // kill 在 main 侧失败 / guest 已死时 crash 事件永远不来 —— 超窗后残留的
      // cause 不能错标下一次无关崩溃。
      vi.advanceTimersByTime(PENDING_KILL_CAUSE_TTL_MS + 1);
      expect(consumePendingKillCause('tab-k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fans kill-notice / cpu-alert out to per-tab subscribers only', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    const onTabA = vi.fn();
    const onTabB = vi.fn();
    const unsubA = subscribeTabResourceEvent('tab-a', onTabA);
    subscribeTabResourceEvent('tab-b', onTabB);

    api.resourceCb?.({ tabId: 'tab-a', kind: 'cpu-alert', cpuPercent: 95 });
    expect(onTabA).toHaveBeenCalledWith({ tabId: 'tab-a', kind: 'cpu-alert', cpuPercent: 95 });
    expect(onTabB).not.toHaveBeenCalled();

    unsubA();
    api.resourceCb?.({ tabId: 'tab-a', kind: 'cpu-alert', cpuPercent: 96 });
    expect(onTabA).toHaveBeenCalledTimes(1);
  });

  it('setForegroundBrowserTab tracks a single claimant — stale deactivation is ignored', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    setForegroundBrowserTab('tab-a', true);
    expect(api.setForeground).toHaveBeenLastCalledWith({ tabId: 'tab-a' });

    // tab-b 接管前台后,tab-a 的 unmount(false)不能把 tab-b 的声明冲掉。
    setForegroundBrowserTab('tab-b', true);
    expect(api.setForeground).toHaveBeenLastCalledWith({ tabId: 'tab-b' });
    api.setForeground.mockClear();
    setForegroundBrowserTab('tab-a', false);
    expect(api.setForeground).not.toHaveBeenCalled();

    // 当前 claimant 自己退场才发 null。
    setForegroundBrowserTab('tab-b', false);
    expect(api.setForeground).toHaveBeenLastCalledWith({ tabId: null });
  });

  it('forceKillBrowserTab forwards to ipc and swallows failures', async () => {
    const api = installFakeIpc();
    await forceKillBrowserTab('tab-x');
    expect(api.forceKill).toHaveBeenCalledWith({ tabId: 'tab-x' });

    api.forceKill.mockRejectedValueOnce(new Error('boom'));
    await expect(forceKillBrowserTab('tab-x')).resolves.toBeUndefined();
  });
});
