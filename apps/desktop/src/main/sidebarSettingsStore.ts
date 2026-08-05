/**
 * sidebar 用户偏好(置顶手动顺序等)的 main 进程存储。
 * userData/sidebar-settings.json,跨 dev (http://localhost) / installed (file://) 共享,
 * 绕开 localStorage 按 origin 隔离的问题。
 */

import { BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';

import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface SidebarSettingsShape {
  pinnedOrder: string[];
}

const MAX_PINNED_ORDER_ENTRIES = 10_000;
const MAX_PINNED_ORDER_ENTRY_LENGTH = 4_096;

let storeInstance: Store<SidebarSettingsShape> | null = null;

function getStore(): Store<SidebarSettingsShape> {
  if (!storeInstance) {
    storeInstance = new Store<SidebarSettingsShape>({
      name: 'sidebar-settings',
      defaults: { pinnedOrder: [] },
      schema: { pinnedOrder: { type: 'array', items: { type: 'string' } } },
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export function loadPinnedOrder(): string[] {
  return getStore().get('pinnedOrder', []);
}

export function savePinnedOrder(order: readonly string[]): void {
  getStore().set('pinnedOrder', Array.from(order));
}

function requirePinnedOrder(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_PINNED_ORDER_ENTRIES ||
    raw.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.length > MAX_PINNED_ORDER_ENTRY_LENGTH,
    )
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar pinned order');
  }
  return Array.from(raw);
}

function broadcastPinnedOrderChanged(order: readonly string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    // order 中的项目 entry 含 workingDir，只发给 Cindy 登记过的内容窗口；
    // WebView guest 和未登记 BrowserWindow 都不能收到本地路径。
    if (!isAppContentWindow(window)) continue;
    window.webContents.send('sidebar-settings:pinned-order-changed', Array.from(order));
  }
}

export function registerSidebarSettingsIpc(): void {
  // sync read:让 renderer 的 useState(() => load()) 不用改成异步初始化
  ipcMain.on('sidebar-settings:load-pinned-order-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = loadPinnedOrder();
  });
  ipcMain.handle('sidebar-settings:save-pinned-order', (event, rawOrder: unknown) => {
    assertTrustedAppRendererEvent(event);
    const order = requirePinnedOrder(rawOrder);
    savePinnedOrder(order);
    // 包含来源窗口：它的乐观状态会用 main 的规范快照幂等校准；其它已打开
    // 窗口即时跟进，避免下一次操作拿旧顺序覆盖刚写入的项目置顶。
    broadcastPinnedOrderChanged(order);
  });
}
