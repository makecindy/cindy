import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { throwIpcError } from '../utils/ipcValidate.js';
import {
  getAppShortcutDefinition,
  normalizeAppShortcutCombo,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrides,
} from '../../shared/appShortcuts.js';
import {
  AppShortcutStore,
  APP_SHORTCUTS_FILE_NAME,
  type AppShortcutOverrideRejection,
} from './AppShortcutStore.js';
import {
  GLOBAL_MAIN_WINDOW_SHORTCUT_ID,
  type GlobalMainWindowShortcutController,
} from './global-main-window-shortcut.js';

/**
 * 应用级快捷键 override 的进程级单例 + IPC 注册。
 *
 * channel 约定 (前缀 app-shortcuts:):
 * - get (sendSync): renderer 启动时同步拉 { overrides, platform }, 自己用
 *   shared/appShortcuts 的 getEffectiveAppShortcuts 合并 —— 两端跑同一份
 *   registry 代码, 生效值判定不会漂移。
 * - set-override / clear-override / reset-all (invoke): 写路径, 校验失败
 *   throwIpcError('INVALID_PARAMS')。
 * - changed (main → renderer 广播): overrides 全量快照, renderer 热更新。
 */

let storeSingleton: AppShortcutStore | null = null;
let ipcRegistered = false;
let globalMainWindowShortcutController: GlobalMainWindowShortcutController | null = null;
let globalMainWindowShortcutUnavailable = false;

// ── 录制态 gate ──────────────────────────────────────────────────────────
// 设置页录制快捷键期间, renderer 的 useAppShortcut 靠 body dataset 让路,
// 但 macOS 菜单 accelerator 由系统在 renderer 收到按键前分发, 必须在 main
// 侧同步 gate: 录制中重建菜单 (registerAccelerator: false, 标签仍显示) +
// before-input-event 消费端让路。renderer 通过 app-shortcuts:set-recording
// 在录制开始/结束时通知。
let recordingActive = false;
const recordingListeners = new Set<(active: boolean) => void>();

export function isAppShortcutRecordingActive(): boolean {
  return recordingActive;
}

/** 订阅录制态变化 (菜单重建用); 返回取消订阅函数。 */
export function subscribeAppShortcutRecording(listener: (active: boolean) => void): () => void {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

function setRecordingActive(active: boolean): void {
  if (recordingActive === active) return;
  recordingActive = active;
  recordingListeners.forEach((listener) => listener(active));
}

export function getAppShortcutStore(): AppShortcutStore {
  if (!storeSingleton) {
    storeSingleton = new AppShortcutStore({
      getFilePath: () => path.join(app.getPath('userData'), APP_SHORTCUTS_FILE_NAME),
      platform: process.platform,
      onChanged: broadcastAppShortcutsChanged,
    });
  }
  return storeSingleton;
}

export function registerAppShortcutIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const store = getAppShortcutStore();

  ipcMain.on('app-shortcuts:get', (event) => {
    event.returnValue = {
      overrides: store.getOverrides(),
      platform: process.platform,
      unavailableIds: getUnavailableShortcutIds(),
    };
  });

  ipcMain.handle('app-shortcuts:set-override', (_event, id: unknown, combo: unknown) => {
    const rejection = store.validateOverride(id, combo);
    if (rejection) {
      throwIpcError('INVALID_PARAMS', rejectionMessage(rejection, id));
    }
    const normalizedCombo = combo === null ? null : normalizeAppShortcutCombo(combo)!;
    runCoordinatedMutation(id, normalizedCombo, () => store.setOverride(id, combo));
    return appShortcutMutationResult(store);
  });

  ipcMain.handle('app-shortcuts:clear-override', (_event, id: unknown) => {
    runCoordinatedMutation(id, getGlobalMainWindowDefaultCombo(), () => store.clearOverride(id));
    return appShortcutMutationResult(store);
  });

  ipcMain.handle('app-shortcuts:reset-all', () => {
    runCoordinatedMutation(
      GLOBAL_MAIN_WINDOW_SHORTCUT_ID,
      getGlobalMainWindowDefaultCombo(),
      () => store.resetAll(),
    );
    return appShortcutMutationResult(store);
  });

  ipcMain.on('app-shortcuts:set-recording', (event, active: unknown) => {
    setRecordingActive(active === true);
    // renderer 的 effect cleanup 在窗口直接销毁 / 渲染进程崩溃时不保证执行,
    // set-recording(false) 可能永远送不到 —— recordingActive 卡 true 会让重
    // 建后的窗口菜单 accelerator 全部不注册直至重启。挂 sender 生命周期兜底,
    // 每个 webContents 只挂一次。
    if (active === true && !recordingResetHooked.has(event.sender)) {
      recordingResetHooked.add(event.sender);
      const reset = () => setRecordingActive(false);
      event.sender.once('destroyed', reset);
      event.sender.once('render-process-gone', reset);
    }
  });
}

/** app ready 后装入 Electron globalShortcut 协调器并注册当前生效键位。 */
export function installGlobalMainWindowShortcutController(
  controller: GlobalMainWindowShortcutController,
): () => void {
  globalMainWindowShortcutController?.dispose();
  setGlobalMainWindowShortcutUnavailable(false);
  globalMainWindowShortcutController = controller;
  controller.initialize(
    getAppShortcutStore().getEffectiveCombos(GLOBAL_MAIN_WINDOW_SHORTCUT_ID)[0] ?? null,
  );
  return () => {
    if (globalMainWindowShortcutController !== controller) return;
    controller.dispose();
    globalMainWindowShortcutController = null;
  };
}

/** controller 的注册结果进入同步快照与 changed 广播，启动失败不会静默。 */
export function setGlobalMainWindowShortcutUnavailable(unavailable: boolean): void {
  if (globalMainWindowShortcutUnavailable === unavailable) return;
  globalMainWindowShortcutUnavailable = unavailable;
  broadcastAppShortcutsChanged(getAppShortcutStore().getOverrides());
}

function runCoordinatedMutation(
  id: unknown,
  nextCombo: AppShortcutCombo | null,
  mutation: () => AppShortcutOverrideRejection | void | null,
): void {
  if (id !== GLOBAL_MAIN_WINDOW_SHORTCUT_ID || !globalMainWindowShortcutController) {
    runStoreMutation(mutation);
    return;
  }
  const prepared = globalMainWindowShortcutController.prepare(nextCombo);
  if (!prepared.ok) {
    throwIpcError(
      prepared.reason === 'unavailable'
        ? 'APP_SHORTCUT_GLOBAL_UNAVAILABLE'
        : 'INVALID_PARAMS',
      prepared.reason === 'unavailable'
        ? 'global shortcut is already in use by the operating system or another application'
        : 'shortcut combo cannot be expressed as a global accelerator',
    );
  }
  try {
    runStoreMutation(mutation);
    prepared.commit();
  } catch (error) {
    prepared.rollback();
    throw error;
  }
}

function getGlobalMainWindowDefaultCombo(): AppShortcutCombo | null {
  const defaults = getAppShortcutDefinition(
    GLOBAL_MAIN_WINDOW_SHORTCUT_ID,
  ).getDefaultCombos(process.platform);
  return defaults[0] ?? null;
}

function getUnavailableShortcutIds(): AppShortcutId[] {
  return globalMainWindowShortcutUnavailable ? [GLOBAL_MAIN_WINDOW_SHORTCUT_ID] : [];
}

function appShortcutMutationResult(store: AppShortcutStore): {
  overrides: AppShortcutOverrides;
  unavailableIds: AppShortcutId[];
} {
  return {
    overrides: store.getOverrides(),
    unavailableIds: getUnavailableShortcutIds(),
  };
}

function runStoreMutation<T>(mutation: () => T): T {
  try {
    return mutation();
  } catch (error) {
    throwIpcError(
      'APP_SHORTCUTS_WRITE_FAILED',
      `failed to save app shortcut overrides: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const recordingResetHooked = new WeakSet<Electron.WebContents>();

function rejectionMessage(rejection: AppShortcutOverrideRejection, id: unknown): string {
  switch (rejection) {
    case 'unknown-id':
      return `unknown app shortcut id: ${String(id)}`;
    case 'not-rebindable':
      return `app shortcut is not rebindable: ${String(id)}`;
    case 'platform-unavailable':
      return `app shortcut not available on this platform: ${String(id)}`;
    case 'invalid-combo':
      return 'invalid shortcut combo';
    case 'not-bindable':
      return 'shortcut combo not bindable (bare keys limited to F1-F24 / Shift+non-printable)';
    case 'system-reserved':
      return 'shortcut combo is reserved by the operating system';
    case 'menu-inexpressible':
      return 'shortcut combo cannot be expressed as a menu accelerator on macOS';
    case 'global-inexpressible':
      return 'shortcut combo cannot be expressed as a global accelerator';
    case 'conflict':
      return 'shortcut combo conflicts with another shortcut in an overlapping scope';
  }
}

function broadcastAppShortcutsChanged(overrides: AppShortcutOverrides): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('app-shortcuts:changed', {
      overrides,
      unavailableIds: getUnavailableShortcutIds(),
    });
  });
}
