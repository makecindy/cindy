// @vitest-environment jsdom

/**
 * store × pinnedGhostTabs 联动单测:
 *  - addTab({activate:false}) 不抢激活位(cache 与 IPC 都不动 active);
 *  - addOrFocusSingletonTab 打开插件页签 → 默认写入钉住条目;
 *  - closeTab 关闭钉住中的插件页签 → 钉住条目清除(= 取消钉住并关闭);
 *  - closeTab IPC 失败回滚 → 钉住条目保留。
 * IPC 桩与 store.test.ts 同款(内存版 rightSidebarTabs)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as store from '../store';
import {
  _resetGhostTabPinsForTest,
  isGhostTabPinned,
} from '../lib/pinnedGhostTabs';

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
}));

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
  (window as unknown as {
    electronAPI: { localDb: { rightSidebarTabs: IpcStub }; platform: string };
  }).electronAPI = {
    localDb: { rightSidebarTabs: stub },
    platform: 'darwin',
  };
}

const SID = 's-pin-test';

describe('store × pinnedGhostTabs', () => {
  let ipc: IpcStub;

  beforeEach(async () => {
    store._resetStore();
    _resetGhostTabPinsForTest();
    ipc = makeIpcStub();
    installIpc(ipc);
    await store.ensureHydrated(SID);
  });

  it('addTab activate:false:激活位不动,IPC 不发 setActive', async () => {
    const first = await store.addTab(SID, 'file-browser');
    expect(store.getBucket(SID).activeTabId).toBe(first.id);
    ipc.setActive.mockClear();

    const added = await store.addTab(SID, 'ghost:cindy-art', { autoPinned: true }, {
      activate: false,
    });
    const bucket = store.getBucket(SID);
    expect(bucket.tabs.map((t) => t.id)).toEqual([first.id, added.id]);
    expect(bucket.activeTabId).toBe(first.id);
    expect(ipc.setActive).not.toHaveBeenCalled();
  });

  it('addOrFocusSingletonTab 打开插件页签 → 默认钉住;非插件 kind 不写条目', async () => {
    expect(isGhostTabPinned('cindy-art')).toBe(false);
    await store.addOrFocusSingletonTab(SID, 'ghost:cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(true);
    await store.addOrFocusSingletonTab(SID, 'review');
    expect(isGhostTabPinned('review')).toBe(false);
  });

  it('closeTab 关闭钉住中的插件页签 → 取消钉住(条目清除)', async () => {
    const tab = await store.addOrFocusSingletonTab(SID, 'ghost:cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(true);
    await store.closeTab(SID, tab.id);
    expect(isGhostTabPinned('cindy-art')).toBe(false);
    expect(store.getBucket(SID).tabs).toEqual([]);
  });

  it('closeTab IPC 失败回滚 → 页签还在,钉住状态原样保留', async () => {
    const tab = await store.addOrFocusSingletonTab(SID, 'ghost:cindy-art');
    ipc.close.mockRejectedValueOnce(new Error('db down'));
    await expect(store.closeTab(SID, tab.id)).rejects.toThrow('db down');
    expect(store.getBucket(SID).tabs.map((t) => t.id)).toEqual([tab.id]);
    expect(isGhostTabPinned('cindy-art')).toBe(true);
  });
});
