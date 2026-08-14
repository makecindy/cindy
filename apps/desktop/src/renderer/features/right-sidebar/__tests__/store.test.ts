// @vitest-environment jsdom

/**
 * store 单测 —— 覆盖 RSB tab store 的乐观更新 + 回滚 + dedupe + 多 session 隔离 +
 * subscribe 通知。
 *
 * IPC 行为本身在 `main/localDb/ipc/__tests__/rightSidebarTabs.test.ts` 已经测过
 * (16 case),这里只测 renderer store 跟 IPC 的协作:乐观更新先生效、IPC 失败时
 * 回滚 cache、并发 ensureHydrated dedupe 等。
 *
 * IPC 桩:替换 `window.electronAPI.localDb.rightSidebarTabs` 为内存版,把成功 /
 * 失败 / 延迟单独可控。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetTabKindRegistry, registerTabKind } from '../registry';
import {
  _resetPopupTabsForTests,
  isPopupSpawnedTab,
  markPopupSpawnedTab,
} from '../lib/popupTabs';
import { browserWebviewPool } from '../lib/browserWebviewPool';
import type { TabKindPlugin } from '../types';

// device-link origin 注册表桩:'remote-' 前缀的 sessionId 视为远程会话。
// store 对远程会话必须走纯内存(right_sidebar_tabs 对 sessions 表有 FK,
// 远程 sessionId 不在本地库,写入必撞约束),其余测试用例不受影响。
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: (sid: string) => (sid.startsWith('remote-') ? 'dev-1' : undefined),
}));

// store 是模块级单例,在测试间必须重置。但 vitest 不会重新 import 模块,
// 用导出的 `_resetStore` 清 cache。
let store: typeof import('../store');

type IpcStub = {
  list: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
};

function makeIpcStub(): IpcStub {
  return {
    list: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null }),
    upsert: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue({ ok: true }),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    reorder: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function installIpc(stub: IpcStub): void {
  // 测试用 window.electronAPI 桩。完整 surface 太大,只挂 store 用到的子集,
  // 配合 `as unknown as ...` 绕过 typing(测试本来就是用 mock 替换完整 contract)。
  (window as unknown as {
    electronAPI: { localDb: { rightSidebarTabs: IpcStub }; platform: string };
  }).electronAPI = {
    localDb: { rightSidebarTabs: stub },
    platform: 'darwin',
  };
}

function registerVetoPlugin(
  onBeforeClose = vi.fn(async () => false),
): ReturnType<typeof vi.fn> {
  registerTabKind({
    kind: 'orca-workers',
    menu: {
      kind: 'orca-workers',
      labelKey: 'rightSidebar.tabs.kinds.collaboration',
      icon: (() => null) as never,
      order: 18,
      enabled: true,
      singleton: true,
    },
    TabPillTitle: () => null,
    TabBody: () => null,
    defaultState: () => ({}),
    onBeforeClose,
  } as TabKindPlugin);
  return onBeforeClose;
}

describe('RSB store', () => {
  let ipc: IpcStub;

  beforeEach(async () => {
    store = await import('../store');
    store._resetStore();
    _resetTabKindRegistry();
    ipc = makeIpcStub();
    installIpc(ipc);
    _resetPopupTabsForTests();
  });

  afterEach(() => {
    store._resetStore();
    _resetTabKindRegistry();
    _resetPopupTabsForTests();
    vi.restoreAllMocks();
  });

  describe('getBucket', () => {
    it('returns empty bucket for null / undefined sessionId', () => {
      expect(store.getBucket(null)).toEqual({ hydrated: false, tabs: [], activeTabId: null });
      expect(store.getBucket(undefined)).toEqual({ hydrated: false, tabs: [], activeTabId: null });
    });

    it('returns empty bucket for unknown session before hydrate', () => {
      const bucket = store.getBucket('session-unknown');
      expect(bucket.hydrated).toBe(false);
      expect(bucket.tabs).toEqual([]);
    });

    // useSyncExternalStore 契约:cache miss 必须返回稳定 reference,否则 React 用
    // Object.is 比对 snapshot 会触发警告 / 无限重渲染。所有 cache miss(null /
    // undefined / unknown sessionId)共用同一 EMPTY_BUCKET 单例。
    it('returns the same reference across calls for cache misses', () => {
      const a = store.getBucket(null);
      const b = store.getBucket(undefined);
      const c = store.getBucket('session-unknown');
      const d = store.getBucket('another-unknown');
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(c).toBe(d);
    });
  });

  describe('ensureHydrated', () => {
    it('calls IPC list once and caches hydrated bucket', async () => {
      ipc.list.mockResolvedValueOnce({
        tabs: [{ id: 't1', kind: 'file-browser', position: 0, state: { selectedFilePath: 'a.md' } }],
        activeTabId: 't1',
      });
      await store.ensureHydrated('s1');
      expect(ipc.list).toHaveBeenCalledTimes(1);
      const bucket = store.getBucket('s1');
      expect(bucket.hydrated).toBe(true);
      expect(bucket.tabs).toHaveLength(1);
      expect(bucket.activeTabId).toBe('t1');
    });

    it('skips IPC on second call (cache hit)', async () => {
      await store.ensureHydrated('s1');
      await store.ensureHydrated('s1');
      expect(ipc.list).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent calls into a single IPC', async () => {
      let resolveList!: (v: { tabs: unknown[]; activeTabId: null }) => void;
      ipc.list.mockReturnValueOnce(
        new Promise((r) => {
          resolveList = r as never;
        }),
      );
      const p1 = store.ensureHydrated('s1');
      const p2 = store.ensureHydrated('s1');
      const p3 = store.ensureHydrated('s1');
      resolveList({ tabs: [], activeTabId: null });
      await Promise.all([p1, p2, p3]);
      expect(ipc.list).toHaveBeenCalledTimes(1);
    });

    it('falls back to empty hydrated bucket when electronAPI is missing (SSR / preload)', async () => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
      await store.ensureHydrated('s1');
      expect(store.getBucket('s1').hydrated).toBe(true);
      expect(store.getBucket('s1').tabs).toEqual([]);
    });

    it('marks unknown local-DB sessions as memory-only', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      const tab = await store.addTab('ghost-s1', 'web-browser', { url: 'https://example.com' });
      await store.patchTabState('ghost-s1', tab.id, (current) => ({
        ...(current as object),
        title: 'Example',
      }));

      expect(ipc.list).toHaveBeenCalledOnce();
      expect(ipc.upsert).not.toHaveBeenCalled();
      expect(ipc.setActive).not.toHaveBeenCalled();
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(1);
      expect((store.getBucket('ghost-s1').tabs[0].state as { title: string }).title).toBe('Example');
    });

    it('exports and restores a memory-only bucket across host cache invalidation', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('handoff-s1');
      const tab = await store.addTab('handoff-s1', 'web-browser', { url: 'https://example.com' });

      const snapshot = store.getTabSnapshot('handoff-s1');
      expect(snapshot).toEqual({
        sessionId: 'handoff-s1',
        tabs: [{ id: tab.id, kind: 'web-browser', state: { url: 'https://example.com' } }],
        activeTabId: tab.id,
        persistable: false,
      });

      store.invalidateSessionCaches();
      store.importTabSnapshot(snapshot!);
      store.invalidateSessionCaches();
      await store.ensureHydrated('handoff-s1');

      expect(ipc.list).toHaveBeenCalledOnce();
      expect(store.getBucket('handoff-s1')).toEqual({
        hydrated: true,
        tabs: [{ id: tab.id, kind: 'web-browser', state: { url: 'https://example.com' } }],
        activeTabId: tab.id,
      });
    });

    it('restores a pending handoff synchronously during the target host transition', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('handoff-transition');
      const tab = await store.addTab('handoff-transition', 'web-browser', {
        url: 'https://example.com',
      });
      const snapshot = store.getTabSnapshot('handoff-transition');

      store.invalidateSessionCaches();
      store.importTabSnapshot(snapshot!);
      store.resetCachesForHostTransition();

      expect(store.getBucket('handoff-transition')).toEqual({
        hydrated: true,
        tabs: [{ id: tab.id, kind: 'web-browser', state: { url: 'https://example.com' } }],
        activeTabId: tab.id,
      });
    });

    it('does not let a late empty hydrate overwrite a received handoff', async () => {
      let resolveList!: (value: {
        tabs: never[];
        activeTabId: null;
        persistable: false;
      }) => void;
      ipc.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveList = resolve;
          }),
      );
      const hydration = store.ensureHydrated('handoff-race');
      const snapshot = {
        sessionId: 'handoff-race',
        tabs: [{ id: 'tab-a', kind: 'web-browser', state: { url: 'about:blank' } }],
        activeTabId: 'tab-a',
        persistable: false as const,
      };

      store.importTabSnapshot(snapshot);
      resolveList({ tabs: [], activeTabId: null, persistable: false });
      await hydration;

      expect(store.getBucket('handoff-race')).toEqual({
        hydrated: true,
        tabs: snapshot.tabs,
        activeTabId: 'tab-a',
      });
    });

    it('can rehydrate after a host transition invalidates an in-flight hydrate', async () => {
      let resolveInitial!: (value: {
        tabs: never[];
        activeTabId: null;
      }) => void;
      ipc.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      );

      const initialHydration = store.ensureHydrated('host-transition-race');
      await vi.waitFor(() => expect(ipc.list).toHaveBeenCalledOnce());

      store.resetCachesForHostTransition();
      resolveInitial({ tabs: [], activeTabId: null });
      await initialHydration;
      expect(store.getBucket('host-transition-race').hydrated).toBe(false);

      ipc.list.mockResolvedValueOnce({
        tabs: [{ id: 'tab-after-transition', kind: 'web-browser', state: { url: 'about:blank' } }],
        activeTabId: 'tab-after-transition',
      });
      await store.ensureHydrated('host-transition-race');

      expect(store.getBucket('host-transition-race')).toEqual({
        hydrated: true,
        tabs: [{ id: 'tab-after-transition', kind: 'web-browser', state: { url: 'about:blank' } }],
        activeTabId: 'tab-after-transition',
      });
      expect(ipc.list).toHaveBeenCalledTimes(2);
    });

    it('does not export a persistable local-DB bucket as a renderer handoff', async () => {
      await store.ensureHydrated('persisted-s1');
      expect(store.getTabSnapshot('persisted-s1')).toBeNull();
    });

    it('sanitizes non-persistable favicons when hydrating web-browser tabs', async () => {
      ipc.list.mockResolvedValueOnce({
        tabs: [
          {
            id: 't1',
            kind: 'web-browser',
            position: 0,
            state: { url: 'https://a.com', title: 'A', favicon: 'blob:https://a.com/favicon' },
          },
          {
            id: 't2',
            kind: 'web-browser',
            position: 1,
            state: { url: 'https://b.com', title: 'B', favicon: 'data:image/png;base64,eA==' },
          },
          { id: 't3', kind: 'file-browser', position: 2, state: { selectedFilePath: 'x.md' } },
        ],
        activeTabId: 't1',
      });
      await store.ensureHydrated('s1');
      const tabs = store.getBucket('s1').tabs;
      // blob: 不可持久化 → 清成"无图标"。
      expect((tabs[0].state as { favicon: string | null }).favicon).toBeNull();
      // 小 data: 保留。
      expect((tabs[1].state as { favicon: string | null }).favicon).toBe('data:image/png;base64,eA==');
      // 非 web-browser kind 原样透传。
      expect(tabs[2].state).toEqual({ selectedFilePath: 'x.md' });
    });

    it('lets title patches succeed after hydrating a poisoned web-browser tab', async () => {
      // 发布前已把超大 data: favicon 落库的存量 tab:hydrate 消毒后,后续 patch
      // 不再因 16KB 预检被拒(否则 title 变更也会把坏 favicon 重新并进预检)。
      ipc.list.mockResolvedValueOnce({
        tabs: [
          {
            id: 't1',
            kind: 'web-browser',
            position: 0,
            state: {
              url: 'https://a.com',
              title: 'A',
              favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}`,
            },
          },
        ],
        activeTabId: 't1',
      });
      await store.ensureHydrated('s1');
      ipc.upsert.mockClear();
      const tab = store.getBucket('s1').tabs[0];
      await store.patchTabState('s1', tab.id, (current) => ({
        ...(current as object),
        title: 'A2',
      }));
      expect((store.getBucket('s1').tabs[0].state as { title: string }).title).toBe('A2');
      expect(ipc.upsert).toHaveBeenCalledOnce();
    });

    it('keeps the tab count limit for memory-only sessions', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      for (let i = 0; i < 20; i++) {
        await store.addTab('ghost-s1', 'web-browser', { url: `https://example.com/${i}` });
      }

      await expect(
        store.addTab('ghost-s1', 'web-browser', { url: 'https://example.com/overflow' }),
      ).rejects.toThrow(/limit reached/);
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(20);
      expect(ipc.upsert).not.toHaveBeenCalled();
    });

    it('keeps the state-size limit for memory-only addTab', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');

      await expect(
        store.addTab('ghost-s1', 'web-browser', { favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}` }),
      ).rejects.toThrow(/tab state JSON too large/);
      expect(store.getBucket('ghost-s1').tabs).toHaveLength(0);
      expect(ipc.upsert).not.toHaveBeenCalled();
    });

    it('keeps the state-size limit for memory-only patchTabState', async () => {
      ipc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null, persistable: false });
      await store.ensureHydrated('ghost-s1');
      const tab = await store.addTab('ghost-s1', 'web-browser', { title: 'small' });

      await expect(
        store.patchTabState('ghost-s1', tab.id, () => ({
          favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}`,
        })),
      ).rejects.toThrow(/tab state JSON too large/);
      expect((store.getBucket('ghost-s1').tabs[0].state as { title: string }).title).toBe('small');
      expect(ipc.upsert).not.toHaveBeenCalled();
    });
  });

  describe('addTab', () => {
    it('optimistically inserts new tab + sets it active', async () => {
      const tab = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      expect(tab.kind).toBe('file-browser');
      const bucket = store.getBucket('s1');
      expect(bucket.tabs).toHaveLength(1);
      expect(bucket.activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledOnce();
      expect(ipc.setActive).toHaveBeenCalledOnce();
    });

    it('rolls back cache when IPC upsert fails', async () => {
      ipc.upsert.mockRejectedValueOnce(new Error('boom'));
      const prevActiveId = store.getBucket('s1').activeTabId;
      await expect(store.addTab('s1', 'file-browser', null)).rejects.toThrow('boom');
      // 失败回滚:tabs 仍为空,activeTabId 仍是之前的
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(store.getBucket('s1').activeTabId).toBe(prevActiveId);
    });

    it('rejects oversized persisted state before optimistic insertion', async () => {
      const before = store.getBucket('s1');
      const listener = vi.fn();
      const onOptimisticAdd = vi.fn();
      const unsubscribe = store.subscribe(listener);

      const rejection = store.addTab(
        's1',
        'web-browser',
        { favicon: `data:image/png;base64,${'x'.repeat(20 * 1024)}` },
        { onOptimisticAdd },
      );
      await expect(rejection).rejects.toMatchObject({
        code: 'RIGHT_SIDEBAR_STATE_TOO_LARGE',
      });
      await expect(rejection).rejects.toThrow(/tab state JSON too large/);

      expect(store.getBucket('s1')).toBe(before);
      expect(listener).not.toHaveBeenCalled();
      expect(onOptimisticAdd).not.toHaveBeenCalled();
      expect(ipc.upsert).not.toHaveBeenCalled();
      expect(ipc.setActive).not.toHaveBeenCalled();
      unsubscribe();
    });

    it.each([
      ['cyclic state', () => {
        const state: Record<string, unknown> = {};
        state.self = state;
        return state;
      }],
      ['BigInt state', () => ({ value: BigInt(1) })],
      ['top-level function state', () => () => undefined],
    ])('rejects non-JSON-serializable %s before optimistic insertion', async (_name, makeState) => {
      const before = store.getBucket('s1');
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      const rejection = store.addTab('s1', 'web-browser', makeState());
      await expect(rejection).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(rejection).rejects.toThrow(/tab state must be JSON-serializable/);

      expect(store.getBucket('s1')).toBe(before);
      expect(listener).not.toHaveBeenCalled();
      expect(ipc.upsert).not.toHaveBeenCalled();
      expect(ipc.setActive).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('falls back to memory-only when the first persist hits a missing session FK', async () => {
      ipc.upsert.mockRejectedValueOnce(new Error('SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed'));
      const tab = await store.addTab('ghost-race', 'web-browser', { url: 'https://example.com' });
      await store.patchTabState('ghost-race', tab.id, (current) => ({
        ...(current as object),
        title: 'Example',
      }));

      expect(store.getBucket('ghost-race').tabs).toHaveLength(1);
      expect(store.getBucket('ghost-race').activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledTimes(1);
    });

    it('keeps tabs in different sessions isolated', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s2', 'web-browser', null);
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id]);
      expect(store.getBucket('s2').tabs.map((t) => t.id)).toEqual([b.id]);
    });

    it('onOptimisticAdd fires synchronously with the optimistic insert, before IPC settles', async () => {
      // popup 来源标记的时序契约:持久化 IPC 在途期间 React 已能 mount 这个
      // tab 的 webview,标记必须在乐观插入的同一 tick 就绪——不能等 addTab
      // resolve(快速 OAuth callback 的 window.close 会赶在登记前到达)。
      let releaseUpsert: (() => void) | null = null;
      ipc.upsert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseUpsert = () => resolve({ ok: true });
          }),
      );
      const seen: string[] = [];
      const pending = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => seen.push(tabId),
      });
      // upsert 仍挂起,回调必须已带着乐观插入的 tabId 执行过。
      expect(seen).toHaveLength(1);
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual(seen);
      releaseUpsert!();
      const tab = await pending;
      expect(tab.id).toBe(seen[0]);
    });

    it('closeTab 等待进行中的创建落地,不会用 NOT_FOUND 把关闭回滚掉', async () => {
      // OAuth callback 页能在 addTab 的 upsert 还在途时就 window.close():close 先
      // 到 main 会拿到 NOT_FOUND → closeTab 回滚出这个 tab,随后 upsert 落地,
      // cache 与 DB 里都留下一个本该消失的 tab(正是本 PR 要消灭的残留空 tab)。
      let releaseUpsert: (() => void) | null = null;
      ipc.upsert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseUpsert = () => resolve({ ok: true });
          }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => {
          createdId = tabId;
        },
      });
      // upsert 仍挂起时就关它(guest window.close 的时序)。
      const pendingClose = store.closeTab('s1', createdId);
      await Promise.resolve();
      // 必须还没发 close —— 先等创建落地。
      expect(ipc.close).not.toHaveBeenCalled();

      releaseUpsert!();
      await pendingAdd;
      await pendingClose;

      expect(ipc.upsert).toHaveBeenCalledTimes(1);
      expect(ipc.close).toHaveBeenCalledWith({ id: createdId });
      expect(store.getBucket('s1').tabs).toHaveLength(0);
    });

    it('upsert 成功但 setActive 失败时,并发关闭仍要发 close 删掉那一行', async () => {
      // 半失败:DB 里已经有这一行了。addTab 会回滚 renderer cache,若关闭路径把
      // "创建失败"一概当成"DB 里没这行"而跳过 close,DB 就留下一行孤儿 tab,
      // 下次 hydrate / 重启冒出来。
      let releaseUpsert: (() => void) | null = null;
      ipc.upsert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseUpsert = () => resolve({ ok: true });
          }),
      );
      ipc.setActive.mockRejectedValueOnce(new Error('setActive boom'));
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => {
          createdId = tabId;
        },
      });
      const pendingClose = store.closeTab('s1', createdId);
      await Promise.resolve();

      releaseUpsert!();
      await expect(pendingAdd).rejects.toThrow('setActive boom');
      await pendingClose;

      expect(ipc.close).toHaveBeenCalledWith({ id: createdId });
      expect(store.getBucket('s1').tabs).toHaveLength(0);
    });

    it('创建失败回滚时清掉 onOptimisticAdd 登记的旁路标记', async () => {
      // 没有任何 closeTab 会来清它:tab 从未存在过。不清则 DB/IPC 异常期间反复
      // 触发 popup 会让标记集合随进程生命周期无界增长。
      ipc.upsert.mockRejectedValueOnce(new Error('db down'));
      let createdId = '';

      await expect(
        store.addTab('s1', 'web-browser', null, {
          onOptimisticAdd: (tabId) => {
            createdId = tabId;
            markPopupSpawnedTab(tabId);
          },
        }),
      ).rejects.toThrow('db down');

      expect(store.getBucket('s1').tabs).toHaveLength(0);
      expect(isPopupSpawnedTab(createdId)).toBe(false);
    });

    it('创建失败时并发的 closeTab 不发 close,不留幽灵 tab', async () => {
      // 创建失败 = DB 里从来没有这行,addTab 已把它从 cache 回滚掉。此时若照样发
      // close 必然 NOT_FOUND,closeTab 的回滚分支会把这个幽灵 tab 写回 cache。
      let rejectUpsert: ((err: Error) => void) | null = null;
      ipc.upsert.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectUpsert = reject;
          }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => {
          createdId = tabId;
          markPopupSpawnedTab(tabId);
        },
      });
      const pendingClose = store.closeTab('s1', createdId);
      await Promise.resolve();

      rejectUpsert!(new Error('db down'));
      await expect(pendingAdd).rejects.toThrow('db down');
      await expect(pendingClose).resolves.toBeUndefined();

      // best-effort close(state 写队列同样走 upsert,可能反倒把行写进 DB);
      // 它必须**吞掉**失败,不能像正常分支那样回滚出一个幽灵 tab。
      expect(ipc.close).toHaveBeenCalledWith({ id: createdId });
      expect(store.getBucket('s1').tabs).toHaveLength(0);
      // tab 已不存在,标记也要清掉(否则 tabId 永久留在标记集合里)。
      expect(isPopupSpawnedTab(createdId)).toBe(false);
    });

    it('创建失败分支的 best-effort close 报错也不回滚出幽灵 tab', async () => {
      ipc.upsert.mockRejectedValueOnce(new Error('db down'));
      ipc.close.mockRejectedValueOnce(new Error('NOT_FOUND'));
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (tabId) => {
          createdId = tabId;
        },
      });
      const pendingClose = store.closeTab('s1', createdId);

      await expect(pendingAdd).rejects.toThrow('db down');
      await expect(pendingClose).resolves.toBeUndefined();

      expect(store.getBucket('s1').tabs).toHaveLength(0);
    });
  });

  describe('addOrFocusSingletonTab', () => {
    it('creates a new tab when no existing tab of that kind', async () => {
      const tab = await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(tab.kind).toBe('review');
      expect(store.getBucket('s1').tabs).toHaveLength(1);
      expect(store.getBucket('s1').activeTabId).toBe(tab.id);
      expect(ipc.upsert).toHaveBeenCalledOnce();
    });

    it('returns the existing tab + setActive when same kind already present', async () => {
      const first = await store.addOrFocusSingletonTab('s1', 'review', null);
      // 切到别的 tab 让 active 不再是 review
      const other = await store.addTab('s1', 'file-browser', null);
      expect(store.getBucket('s1').activeTabId).toBe(other.id);
      ipc.upsert.mockClear();
      ipc.setActive.mockClear();

      const same = await store.addOrFocusSingletonTab('s1', 'review', null);
      // 同一个 review tab,不重建
      expect(same.id).toBe(first.id);
      expect(store.getBucket('s1').tabs).toHaveLength(2);
      // 没新建 → upsert 不该再被调用
      expect(ipc.upsert).not.toHaveBeenCalled();
      // setActive 应该被调用切到 review
      expect(ipc.setActive).toHaveBeenCalledOnce();
      expect(store.getBucket('s1').activeTabId).toBe(first.id);
    });

    it('skips setActive when existing tab is already active', async () => {
      const tab = await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(store.getBucket('s1').activeTabId).toBe(tab.id);
      ipc.setActive.mockClear();
      ipc.upsert.mockClear();

      await store.addOrFocusSingletonTab('s1', 'review', null);
      expect(ipc.setActive).not.toHaveBeenCalled();
      expect(ipc.upsert).not.toHaveBeenCalled();
    });
  });

  describe('closeTab', () => {
    it('releases an ordinary browser WebView only after its tab is really closed', async () => {
      const release = vi.spyOn(browserWebviewPool, 'release').mockImplementation(() => undefined);
      const tab = await store.addTab('s1', 'web-browser', null);

      await store.closeTab('s1', tab.id);

      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith(tab.id);
    });

    it('清掉 tabId 上的 popup 来源标记(任何关闭入口,不只 guest 自关)', async () => {
      const tab = await store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: markPopupSpawnedTab,
      });
      expect(isPopupSpawnedTab(tab.id)).toBe(true);

      // 用户手动关(或 closeAllTabs / agent close tab-op)也必须清标记,否则标记
      // 集合会随进程生命周期无界增长。
      await store.closeTab('s1', tab.id);

      expect(isPopupSpawnedTab(tab.id)).toBe(false);
    });

    it('IPC 失败回滚时保留 popup 标记(tab 还在,自关语义不能丢)', async () => {
      const tab = await store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: markPopupSpawnedTab,
      });
      ipc.close.mockRejectedValueOnce(new Error('db down'));

      await expect(store.closeTab('s1', tab.id)).rejects.toThrow('db down');

      expect(store.getBucket('s1').tabs).toHaveLength(1);
      expect(isPopupSpawnedTab(tab.id)).toBe(true);
    });

    it('同 session 并发关闭按序落盘,不用旧快照复活已删 tab', async () => {
      // 交错场景(不限于 popup 自关):关掉 active 的 A 会把 active 挪到 B,若此时
      // 另一路关闭已经把 B 删掉,前者延迟到达的 setActive(B) 会 NOT_FOUND,
      // closeTab 便用"含 A、B"的旧快照整体回滚,两个 tab 一起复活。
      const a = await store.addTab('s1', 'web-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      await store.setActiveTab('s1', a.id);
      // close 的 IPC 慢一拍,给两路关闭制造交错窗口。
      ipc.close.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5)),
      );
      ipc.setActive.mockImplementation((input: { id: string | null }) => {
        // main 端真实行为:setActive 指向已删除的 tab 会报错。
        if (input.id !== null && !store.getBucket('s1').tabs.some((t) => t.id === input.id)) {
          return Promise.reject(new Error('NOT_FOUND'));
        }
        return Promise.resolve({ ok: true });
      });

      await Promise.all([store.closeTab('s1', a.id), store.closeTab('s1', b.id)]);

      expect(store.getBucket('s1').tabs).toHaveLength(0);
      expect(store.getBucket('s1').activeTabId).toBeNull();
    });

    it('active 落库前重取 cache 现值,不用旧值盖掉并发 addTab 落的 active', async () => {
      // closeTab 的 setActive 跨越若干 await,并发的 addTab 可能已经把新 tab 落成
      // active。若这里还按关闭前算好的旧值写,DB 的 active 会与 cache 分叉,下次
      // hydrate 恢复出错的激活项。
      const a = await store.addTab('s1', 'web-browser', null);
      let releaseClose: (() => void) | null = null;
      ipc.close.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseClose = () => resolve({ ok: true });
          }),
      );

      const pendingClose = store.closeTab('s1', a.id);
      await Promise.resolve();
      // close IPC 在途期间插入一个新 tab —— 它自己会把 active 落成 b。
      const b = await store.addTab('s1', 'web-browser', null);
      releaseClose!();
      await pendingClose;

      expect(store.getBucket('s1').activeTabId).toBe(b.id);
      // 最后一次 setActive 必须是 cache 现值(b),不是关闭时算出的 null。
      const activeCalls = ipc.setActive.mock.calls.map((c) => (c[0] as { id: string | null }).id);
      expect(activeCalls[activeCalls.length - 1]).toBe(b.id);
    });

    it('前一次关闭失败不会把同 session 后续关闭拖挂', async () => {
      const a = await store.addTab('s1', 'web-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      ipc.close.mockRejectedValueOnce(new Error('db down'));

      const first = store.closeTab('s1', a.id);
      const second = store.closeTab('s1', b.id);

      await expect(first).rejects.toThrow('db down');
      await expect(second).resolves.toBeUndefined();
      // a 回滚留下,b 正常关掉。
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id]);
    });

    it('removes tab and shifts active to neighbor', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'file-browser', null);
      const c = await store.addTab('s1', 'file-browser', null);
      // 关 active 的 c → 右邻不存在,降回左邻 b
      await store.closeTab('s1', c.id);
      const after = store.getBucket('s1');
      expect(after.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
      expect(after.activeTabId).toBe(b.id);
    });

    it('rolls back on IPC failure', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      ipc.close.mockRejectedValueOnce(new Error('boom'));
      await expect(store.closeTab('s1', a.id)).rejects.toThrow('boom');
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id]);
    });

    it('close 落库后同步 active 前,等新 active tab 的 INSERT 落定再 setActive', async () => {
      // close 在途时并发 addTab 使新 tab 成为 active:它的 upsert 未提交前就发
      // setActive 会撞 [NOT_FOUND](main 端还会先清掉全 session 的 active 位),
      // 并把"close 已成功"错误地拖进回滚分支复活已删 tab。
      const a = await store.addTab('s1', 'web-browser', null);
      ipc.setActive.mockClear();
      let releaseClose!: () => void;
      ipc.close.mockImplementationOnce(
        () => new Promise((resolve) => { releaseClose = () => resolve({ ok: true }); }),
      );
      let releaseUpsert!: () => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise((resolve) => { releaseUpsert = () => resolve({ ok: true }); }),
      );

      const close = store.closeTab('s1', a.id);
      await Promise.resolve();
      const pendingAdd = store.addTab('s1', 'web-browser', null); // 成为 active,INSERT 挂起
      await Promise.resolve();
      releaseClose();
      // 给 close 内部若干 tick 走到 active 同步点:INSERT 未落定前不得发任何 setActive。
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(ipc.setActive).not.toHaveBeenCalled();

      releaseUpsert();
      const b = await pendingAdd;
      await close;
      expect(ipc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: b.id });
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([b.id]);
    });

    it('正常分支 close 撞 [NOT_FOUND](行已被并发清理删掉)按成功收尾,不回插幽灵 tab', async () => {
      // 双路径清理竞争:addTab 半失败(upsert 成功 setActive 失败)的回滚清理先删
      // 了行,pendingCreate 半失败返回 true 让并发 close 走到正常分支 → ipc.close
      // 拿 [NOT_FOUND]。行不存在正是关闭的目标状态——回滚反而把 DB 已无的行插
      // 回 cache,制造幽灵 tab。
      const a = await store.addTab('s1', 'web-browser', null);
      ipc.close.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'local-db:right-sidebar-tabs:close': Error: [NOT_FOUND] tab x not found",
        ),
      );
      await expect(store.closeTab('s1', a.id)).resolves.toBeUndefined();
      expect(store.getBucket('s1').tabs).toHaveLength(0);
    });

    it('post-close setActive 失败的恢复不覆盖期间用户的新激活', async () => {
      // setActive(B) 在途期间用户激活 C(已各自落库):B 的失败恢复若无条件清
      // null,会把更新的激活覆盖掉——旧写失败不该赢过新写成功。
      const a = await store.addTab('s1', 'web-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      const c = await store.addTab('s1', 'web-browser', null);
      await store.setActiveTab('s1', a.id);
      ipc.setActive.mockClear();
      let rejectFirst!: (e: Error) => void;
      ipc.setActive.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectFirst = (e) => reject(e); }),
      );

      const close = store.closeTab('s1', a.id); // 替代者 = b → setActive(b) 挂起
      await vi.waitFor(() =>
        expect(ipc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: b.id }),
      );
      await store.setActiveTab('s1', c.id); // 用户此间激活 C(默认 mock 成功)
      rejectFirst(new Error('boom'));
      await close;

      expect(store.getBucket('s1').activeTabId).toBe(c.id);
    });

    it('close 落库后 setActive 失败只降级为警告,不复活已删 tab', async () => {
      const a = await store.addTab('s1', 'web-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      await store.setActiveTab('s1', a.id);
      // 关 active tab → close 成功后需要 setActive(替代者 b);让它失败。
      ipc.setActive.mockRejectedValueOnce(new Error('boom'));
      await expect(store.closeTab('s1', a.id)).resolves.toBeUndefined();
      // tab 删除已落库,绝不能因 active 同步失败复活;active 漂移由用户下次点击收敛。
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([b.id]);
    });

    it('孤儿行清理对非 NOT_FOUND 失败按 overload 节奏重试,不再静默吞掉', async () => {
      // 创建失败(非 FK)→ addTab 回滚 cache;in-flight 的 close 走孤儿清理分支。
      // 清理 close 首次撞 overload:必须重试(默认 mock 第二次成功),不能吞掉——
      // 吞掉意味着 state 写队列可能已写进 DB 的孤儿行永远没人清,重启复活。
      let rejectUpsert!: (e: Error) => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectUpsert = (e) => reject(e); }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (id) => { createdId = id; },
      });
      const close = store.closeTab('s1', createdId);
      await Promise.resolve();
      ipc.close.mockRejectedValueOnce(new Error('db worker RPC queue overloaded'));

      rejectUpsert(new Error('boom'));
      await expect(pendingAdd).rejects.toThrow('boom');
      await close;
      expect(ipc.close).toHaveBeenCalledTimes(2);
      expect(store.getBucket('s1').tabs).toHaveLength(0);
    });

    it('孤儿行清理把 Electron 包装形态的 [NOT_FOUND] 视为"行本来就没有",不重试', async () => {
      let rejectUpsert!: (e: Error) => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectUpsert = (e) => reject(e); }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (id) => { createdId = id; },
      });
      const close = store.closeTab('s1', createdId);
      await Promise.resolve();
      // renderer 实际拿到的是 Electron invoke 包装后的形态。
      ipc.close.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'local-db:right-sidebar-tabs:close': Error: [NOT_FOUND] tab x not found",
        ),
      );

      rejectUpsert(new Error('boom'));
      await expect(pendingAdd).rejects.toThrow('boom');
      await close;
      expect(ipc.close).toHaveBeenCalledTimes(1);
    });

    it('message 恰含 [NOT_FOUND] 字样但非 IPC code 位置的失败,不误判为清理成功', async () => {
      // 结构化 code 比对(extractIpcError 锚定 code 位置)的意义:裸
      // `includes('[NOT_FOUND]')` 会把这类无关错误当成"行不存在",静默跳过清理。
      let rejectUpsert!: (e: Error) => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectUpsert = (e) => reject(e); }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (id) => { createdId = id; },
      });
      const close = store.closeTab('s1', createdId);
      await Promise.resolve();
      ipc.close.mockRejectedValueOnce(
        new Error('proxy hiccup while forwarding [NOT_FOUND] marker downstream'),
      );

      rejectUpsert(new Error('boom'));
      await expect(pendingAdd).rejects.toThrow('boom');
      await close; // 默认 mock 第二次成功 → 重试路径完成清理
      expect(ipc.close).toHaveBeenCalledTimes(2);
    });

    it('孤儿行清理重试仍失败时向上抛,不静默', async () => {
      let rejectUpsert!: (e: Error) => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectUpsert = (e) => reject(e); }),
      );
      let createdId = '';
      const pendingAdd = store.addTab('s1', 'web-browser', null, {
        onOptimisticAdd: (id) => { createdId = id; },
      });
      const close = store.closeTab('s1', createdId);
      await Promise.resolve();
      ipc.close.mockRejectedValue(new Error('db worker RPC queue overloaded'));

      rejectUpsert(new Error('boom'));
      await expect(pendingAdd).rejects.toThrow('boom');
      await expect(close).rejects.toThrow('overloaded');
      // 1 次首发 + 3 次重试。
      expect(ipc.close).toHaveBeenCalledTimes(4);
      ipc.close.mockResolvedValue({ ok: true }); // 还原默认,防污染后续用例
    });

    it('close 失败的回滚只插回被关的 tab,不覆盖 in-flight 期间并发的 addTab/setActive', async () => {
      // addTab / setActiveTab 有意不进 close 队列:close 的 IPC 在途期间它们可能
      // 已把新 tab 写进 cache 和 DB。整快照回滚会把并发 tab 从 cache 抹掉(DB 里
      // 还在,重启 hydrate 后"幽灵复活")——精准回滚只恢复被关的那一个。
      const a = await store.addTab('s1', 'web-browser', null);
      let rejectClose!: (err: Error) => void;
      ipc.close.mockImplementationOnce(
        () => new Promise((_resolve, reject) => {
          rejectClose = (err) => reject(err);
        }),
      );

      const close = store.closeTab('s1', a.id);
      await Promise.resolve();
      // close IPC 挂起期间并发新增一个 tab(popup 场景)并成为 active。
      const b = await store.addTab('s1', 'web-browser', { url: 'https://popup.example' });
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([b.id]);

      rejectClose(new Error('boom'));
      await expect(close).rejects.toThrow('boom');

      const after = store.getBucket('s1');
      // a 被插回,b 不能丢。
      expect(after.tabs.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
      // 并发操作已把 active 指向 b,回滚不得抢回。
      expect(after.activeTabId).toBe(b.id);
    });

    it('waits for queued state writes before deleting the tab row', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let releaseWrite!: () => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise<{ ok: true }>((resolve) => {
          releaseWrite = () => resolve({ ok: true });
        }),
      );

      const write = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const close = store.closeTab('s1', a.id);
      await Promise.resolve();

      expect(ipc.close).not.toHaveBeenCalled();
      releaseWrite();
      await Promise.all([write, close]);

      expect(ipc.close).toHaveBeenCalledWith({ id: a.id });
      expect(store.getBucket('s1').tabs).toEqual([]);
    });

    it('keeps the tab open when plugin onBeforeClose vetoes', async () => {
      const onBeforeClose = registerVetoPlugin();
      const tab = await store.addTab('s1', 'orca-workers', {});

      await store.closeTab('s1', tab.id);

      expect(onBeforeClose).toHaveBeenCalledWith({}, { tabId: tab.id, sessionId: 's1' });
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([tab.id]);
      expect(ipc.close).not.toHaveBeenCalled();
    });

    it('lets a tab-level close interceptor veto before plugin onBeforeClose', async () => {
      const onBeforeClose = registerVetoPlugin(vi.fn(async () => true));
      const interceptor = vi.fn(async () => false);
      const tab = await store.addTab('s1', 'orca-workers', {});
      store.setTabCloseInterceptor(tab.id, interceptor);

      await store.closeTab('s1', tab.id);

      expect(interceptor).toHaveBeenCalledOnce();
      expect(onBeforeClose).not.toHaveBeenCalled();
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([tab.id]);
      expect(ipc.close).not.toHaveBeenCalled();
    });

    it('continues closing after a tab-level close interceptor allows it', async () => {
      const onBeforeClose = registerVetoPlugin(vi.fn(async () => true));
      const interceptor = vi.fn(async () => true);
      const tab = await store.addTab('s1', 'orca-workers', {});
      store.setTabCloseInterceptor(tab.id, interceptor);

      await store.closeTab('s1', tab.id);

      expect(interceptor).toHaveBeenCalledOnce();
      expect(onBeforeClose).toHaveBeenCalledWith({}, { tabId: tab.id, sessionId: 's1' });
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(ipc.close).toHaveBeenCalledWith({ id: tab.id });
    });

    it('can skip plugin onBeforeClose for post-lifecycle cleanup', async () => {
      const onBeforeClose = registerVetoPlugin();
      const tab = await store.addTab('s1', 'orca-workers', {});

      await store.closeTab('s1', tab.id, { skipBeforeClose: true });

      expect(onBeforeClose).not.toHaveBeenCalled();
      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(ipc.close).toHaveBeenCalledWith({ id: tab.id });
    });
  });

  describe('closeAllTabs', () => {
    it('closes every tab in the session bucket', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      const c = await store.addTab('s1', 'terminal', null);

      await store.closeAllTabs('s1');

      expect(store.getBucket('s1').tabs).toEqual([]);
      expect(store.getBucket('s1').activeTabId).toBeNull();
      expect(ipc.close).toHaveBeenCalledTimes(3);
      expect(ipc.close).toHaveBeenNthCalledWith(1, { id: a.id });
      expect(ipc.close).toHaveBeenNthCalledWith(2, { id: b.id });
      expect(ipc.close).toHaveBeenNthCalledWith(3, { id: c.id });
    });
  });

  describe('setActiveTab', () => {
    it('updates activeTabId optimistically', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'file-browser', null);
      await store.setActiveTab('s1', a.id);
      expect(store.getBucket('s1').activeTabId).toBe(a.id);
      // setActiveTab(null) 也支持(关掉所有 tab 时 active=null)
      await store.setActiveTab('s1', null);
      expect(store.getBucket('s1').activeTabId).toBeNull();
      // 确认 b 还在(setActive 不影响 tabs)
      expect(store.getBucket('s1').tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    });
  });

  describe('patchTabState', () => {
    it('updates tab state via patcher and persists via IPC upsert', async () => {
      const a = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      await store.patchTabState('s1', a.id, (current) => ({
        ...(current as object),
        selectedFilePath: 'x.md',
      }));
      const bucket = store.getBucket('s1');
      expect((bucket.tabs[0].state as { selectedFilePath: string }).selectedFilePath).toBe('x.md');
    });

    it('rolls back state on IPC failure', async () => {
      const a = await store.addTab('s1', 'file-browser', { selectedFilePath: null });
      ipc.upsert.mockClear();
      ipc.upsert.mockRejectedValueOnce(new Error('boom'));
      await expect(
        store.patchTabState('s1', a.id, () => ({ selectedFilePath: 'x.md' })),
      ).rejects.toThrow('boom');
      const bucket = store.getBucket('s1');
      expect((bucket.tabs[0].state as { selectedFilePath: string | null }).selectedFilePath).toBeNull();
    });

    it('rejects oversized persisted patches without notifying or writing', async () => {
      const a = await store.addTab('s1', 'web-browser', { favicon: null });
      ipc.upsert.mockClear();
      const before = store.getBucket('s1');
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);

      const oversizedFavicon = `data:image/png;base64,${'x'.repeat(20 * 1024)}`;
      const rejection = store.patchTabState('s1', a.id, (current) => ({
        ...(current as object),
        favicon: oversizedFavicon,
      }));
      await expect(rejection).rejects.toMatchObject({
        code: 'RIGHT_SIDEBAR_STATE_TOO_LARGE',
      });
      await expect(rejection).rejects.toThrow(/tab state JSON too large/);

      expect(store.getBucket('s1')).toBe(before);
      expect(store.getBucket('s1').tabs[0].state).toEqual({ favicon: null });
      expect(listener).not.toHaveBeenCalled();
      expect(ipc.upsert).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('serializes DB writes and coalesces the latest pending state per tab', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let releaseFirst!: () => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise<{ ok: true }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          }),
        )
        .mockResolvedValue({ ok: true });

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const second = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/2' }));
      const third = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/3' }));

      expect(ipc.upsert).toHaveBeenCalledTimes(1);
      expect(store.getBucket('s1').tabs[0].state).toEqual({ url: 'https://example.com/3' });

      releaseFirst();
      await Promise.all([first, second, third]);

      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(ipc.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: a.id, state: { url: 'https://example.com/3' } }),
      );
    });

    it('rolls a failed coalesced write back to the last persisted state', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      let rejectFirst!: (err: Error) => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise((_, reject) => {
            rejectFirst = reject;
          }),
        )
        .mockRejectedValueOnce(new Error('latest failed'));

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/1' }));
      const latest = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/2' }));
      rejectFirst(new Error('first failed'));

      await expect(first).rejects.toThrow('first failed');
      await expect(latest).rejects.toThrow('latest failed');
      expect(store.getBucket('s1').tabs[0].state).toEqual({ url: 'https://example.com/0' });
    });

    it('retries transient DB worker overload without flashing state back', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/0' });
      ipc.upsert.mockClear();
      ipc.upsert
        .mockRejectedValueOnce(new Error('db worker RPC queue overloaded: test'))
        .mockResolvedValueOnce({ ok: true });

      const write = store.patchTabState('s1', a.id, () => ({
        url: 'https://example.com/latest',
      }));
      expect(store.getBucket('s1').tabs[0].state).toEqual({
        url: 'https://example.com/latest',
      });

      await write;
      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(store.getBucket('s1').tabs[0].state).toEqual({
        url: 'https://example.com/latest',
      });
    });
  });

  describe('reorderTabs', () => {
    it('optimistically updates the tab order and persists every id', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      const c = await store.addTab('s1', 'terminal', null);
      ipc.reorder.mockClear();

      await store.reorderTabs('s1', [c.id, a.id, b.id]);

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([c.id, a.id, b.id]);
      expect(store.getBucket('s1').activeTabId).toBe(c.id);
      expect(ipc.reorder).toHaveBeenCalledWith({
        sessionId: 's1',
        orderedIds: [c.id, a.id, b.id],
      });
    });

    it('rolls the tab order back when persistence fails', async () => {
      const a = await store.addTab('s1', 'file-browser', null);
      const b = await store.addTab('s1', 'web-browser', null);
      ipc.reorder.mockRejectedValueOnce(new Error('boom'));

      await expect(store.reorderTabs('s1', [b.id, a.id])).rejects.toThrow('boom');

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([a.id, b.id]);
    });

    it('persists reorder after older queued state writes have settled', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com' });
      const b = await store.addTab('s1', 'file-browser', {});
      ipc.upsert.mockClear();
      let releaseWrite!: () => void;
      ipc.upsert.mockImplementationOnce(
        () => new Promise<{ ok: true }>((resolve) => {
          releaseWrite = () => resolve({ ok: true });
        }),
      );

      const write = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/next' }));
      const reorder = store.reorderTabs('s1', [b.id, a.id]);
      await Promise.resolve();

      expect(store.getBucket('s1').tabs.map((tab) => tab.id)).toEqual([b.id, a.id]);
      expect(ipc.reorder).not.toHaveBeenCalled();

      releaseWrite();
      await Promise.all([write, reorder]);
      expect(ipc.reorder).toHaveBeenCalledWith({
        sessionId: 's1',
        orderedIds: [b.id, a.id],
      });
    });
  });

  describe('invalidateSessionCaches', () => {
    it('keeps pending state writes alive while the renderer host changes', async () => {
      const a = await store.addTab('s1', 'web-browser', { url: 'https://example.com/a' });
      const b = await store.addTab('s1', 'web-browser', { url: 'https://example.com/b' });
      ipc.upsert.mockClear();
      let releaseFirst!: () => void;
      ipc.upsert
        .mockImplementationOnce(
          () => new Promise<{ ok: true }>((resolve) => {
            releaseFirst = () => resolve({ ok: true });
          }),
        )
        .mockResolvedValue({ ok: true });

      const first = store.patchTabState('s1', a.id, () => ({ url: 'https://example.com/a1' }));
      const pending = store.patchTabState('s1', b.id, () => ({ url: 'https://example.com/b1' }));
      store.invalidateSessionCaches();
      releaseFirst();
      await Promise.all([first, pending]);

      expect(ipc.upsert).toHaveBeenCalledTimes(2);
      expect(ipc.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: b.id, state: { url: 'https://example.com/b1' } }),
      );
      expect(store.getBucket('s1').hydrated).toBe(false);
    });

    it('skips post-close setActive when cache is invalidated during the close IPC', async () => {
      // Codex P1: invalidateSessionCaches() 清掉旧 renderer 的 bucket(hydrated=false)
      // 时,closeTab 的 active 同步段不应调 setActive(null)——那会把新 renderer 已
      // 接管会话的 active 标志清掉。
      const tab = await store.addTab('s1', 'web-browser', { url: 'https://example.com/a' });
      await store.addTab('s1', 'web-browser', { url: 'https://example.com/b' });
      ipc.setActive.mockClear();

      let releaseClose: (() => void) | undefined;
      ipc.close.mockImplementationOnce(
        () => new Promise<{ ok: true }>((resolve) => {
          releaseClose = () => resolve({ ok: true });
        }),
      );

      const closing = store.closeTab('s1', tab.id);
      // 等 closeTab 走到 ipc.close 调用后(releaseClose 已被 mock 赋值)
      await vi.waitFor(() => expect(releaseClose).toBeDefined());
      // close IPC 在途时 invalidate
      store.invalidateSessionCaches();
      releaseClose!();
      await closing;

      // hydrated=false 后 active 同步段必须跳过
      expect(ipc.setActive).not.toHaveBeenCalled();
    });
  });

  describe('subscribe / notify', () => {
    it('fires listener with changed sessionId', async () => {
      const seen: string[] = [];
      const unsubscribe = store.subscribe((sessionId) => seen.push(sessionId));
      await store.addTab('s1', 'file-browser', null);
      await store.addTab('s2', 'web-browser', null);
      expect(seen).toContain('s1');
      expect(seen).toContain('s2');
      unsubscribe();
      seen.length = 0;
      await store.addTab('s3', 'file-browser', null);
      expect(seen).not.toContain('s3');
    });
  });
});

describe('device-link remote sessions (memory-only tabs)', () => {
  it('addTab / hydrate never touch IPC for remote sessionIds', async () => {
    store = await import('../store');
    store._resetStore();
    const stub = makeIpcStub();
    installIpc(stub);

    await store.ensureHydrated('remote-s1');
    const tab = await store.addTab('remote-s1', 'file-browser' as never, null);
    expect(tab.id).toBeTruthy();
    expect(store.getBucket('remote-s1').tabs).toHaveLength(1);
    expect(store.getBucket('remote-s1').activeTabId).toBe(tab.id);
    // FK 保护的核心断言:list / upsert / setActive 全部没被调用。
    expect(stub.list).not.toHaveBeenCalled();
    expect(stub.upsert).not.toHaveBeenCalled();
    expect(stub.setActive).not.toHaveBeenCalled();

    // 本地会话仍走 IPC(边界只对远程生效)。
    await store.addTab('local-s1', 'file-browser' as never, null);
    expect(stub.upsert).toHaveBeenCalledTimes(1);
  });
});
