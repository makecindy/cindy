/**
 * sidebar 用户偏好(置顶手动顺序等)的 main 进程存储。
 * userData/sidebar-settings.json,跨 dev (http://localhost) / installed (file://) 共享,
 * 绕开 localStorage 按 origin 隔离的问题。
 */

import { BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';

import { normalizeProjectKey, projectKeyComparisonKey } from '../shared/projectKeys.js';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

interface SidebarSettingsShape {
  pinnedOrder: string[];
  /** 用户明确从侧栏移除的项目；缺省为空，不影响任务本身。 */
  hiddenProjectKeys: string[];
}

const MAX_PINNED_ORDER_ENTRIES = 10_000;
const MAX_PINNED_ORDER_ENTRY_LENGTH = 4_096;
const MAX_HIDDEN_PROJECT_ENTRIES = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;

const log = createLogger('sidebar-settings');

let storeInstance: Store<SidebarSettingsShape> | null = null;

function getStore(): Store<SidebarSettingsShape> {
  if (!storeInstance) {
    storeInstance = new Store<SidebarSettingsShape>({
      name: 'sidebar-settings',
      defaults: { pinnedOrder: [], hiddenProjectKeys: [] },
      schema: {
        pinnedOrder: { type: 'array', items: { type: 'string' } },
        hiddenProjectKeys: {
          type: 'array',
          maxItems: MAX_HIDDEN_PROJECT_ENTRIES,
          uniqueItems: true,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_PROJECT_KEY_LENGTH,
          },
        },
      },
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

export function loadHiddenProjectKeys(): string[] {
  const stored = getStore().get('hiddenProjectKeys', []);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of stored) {
    const projectKey = normalizeProjectKey(entry);
    const comparisonKey = projectKeyComparisonKey(projectKey, process.platform);
    if (
      projectKey == null ||
      projectKey.length > MAX_PROJECT_KEY_LENGTH ||
      comparisonKey == null ||
      seen.has(comparisonKey)
    ) {
      continue;
    }
    seen.add(comparisonKey);
    normalized.push(projectKey);
  }
  return normalized;
}

export function saveHiddenProjectKeys(projectKeys: readonly string[]): void {
  getStore().set('hiddenProjectKeys', Array.from(projectKeys));
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

function requireProjectKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PROJECT_KEY_LENGTH) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project key');
  }
  const projectKey = normalizeProjectKey(raw);
  if (
    projectKey == null ||
    projectKey.length > MAX_PROJECT_KEY_LENGTH ||
    (!projectKey.startsWith('local:') &&
      !projectKey.startsWith('remote:') &&
      !projectKey.startsWith('device:'))
  ) {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project key');
  }
  return projectKey;
}

function requireHidden(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid sidebar project hidden state');
  }
  return raw;
}

function broadcastPinnedOrderChanged(order: readonly string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    // order 中的项目 entry 含 workingDir，只发给 Cindy 登记过的内容窗口；
    // WebView guest 和未登记 BrowserWindow 都不能收到本地路径。
    if (!isAppContentWindow(window)) continue;
    window.webContents.send('sidebar-settings:pinned-order-changed', Array.from(order));
  }
}

function broadcastHiddenProjectKeysChanged(projectKeys: readonly string[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    // 项目 key 可能含本地路径；与 pinnedOrder 一样，只允许 Cindy 内容窗口接收。
    if (!isAppContentWindow(window)) continue;
    window.webContents.send(
      'sidebar-settings:hidden-project-keys-changed',
      Array.from(projectKeys),
    );
  }
}

function setProjectHidden(rawProjectKey: unknown, rawHidden: unknown): boolean {
  const projectKey = requireProjectKey(rawProjectKey);
  const hidden = requireHidden(rawHidden);
  // intent 更新每次都从 main 的最新快照计算，避免两个窗口用各自旧数组互相覆盖。
  const current = loadHiddenProjectKeys();
  const comparisonKey = projectKeyComparisonKey(projectKey, process.platform) ?? projectKey;
  const alreadyHidden = current.some(
    (entry) => projectKeyComparisonKey(entry, process.platform) === comparisonKey,
  );
  if (alreadyHidden === hidden) return false;
  if (hidden && current.length >= MAX_HIDDEN_PROJECT_ENTRIES) {
    throwIpcError('INVALID_PARAMS', 'too many hidden sidebar projects');
  }

  const next = hidden
    ? [...current, projectKey]
    : current.filter(
        (entry) => projectKeyComparisonKey(entry, process.platform) !== comparisonKey,
      );
  try {
    saveHiddenProjectKeys(next);
  } catch (err) {
    // electron-store errors may contain the absolute userData path. Keep the
    // original failure in main logs, but expose only a stable IPC error.
    log.error('failed to persist hidden sidebar projects', err);
    throwIpcError('INTERNAL', 'failed to persist sidebar settings');
  }
  broadcastHiddenProjectKeysChanged(next);
  return true;
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
  // 与 pinnedOrder 一样同步首帧读取，避免启动后侧栏先闪出已移除项目。
  ipcMain.on('sidebar-settings:load-hidden-project-keys-sync', (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = loadHiddenProjectKeys();
  });
  ipcMain.handle(
    'sidebar-settings:set-project-hidden',
    (event, rawProjectKey: unknown, rawHidden: unknown) => {
      assertTrustedAppRendererEvent(event);
      // Return whether this intent changed the latest main-process snapshot.
      // Add Project uses an atomic unhide attempt to distinguish restoring an
      // existing project from creating a new draft after a long-open picker.
      return setProjectHidden(rawProjectKey, rawHidden);
    },
  );
}
