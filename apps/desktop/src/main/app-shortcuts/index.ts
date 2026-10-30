import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { throwIpcError } from '../utils/ipcValidate.js';
import type { AppShortcutId, AppShortcutOverrides } from '../../shared/appShortcuts.js';
import {
  AppShortcutStore,
  APP_SHORTCUTS_FILE_NAME,
  type AppShortcutOverrideRejection,
} from './AppShortcutStore.js';

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
 *
 * get / changed 同时携带 globalFailures: global scope 条目中当前生效组合
 * 向系统注册失败 (多为被其它应用占用) 的 id, 设置页据此提示。它是运行态,
 * 不落盘; 由注册方 (如 region-screenshot) 通过
 * setGlobalShortcutRegistrationFailures 上报。
 */

let storeSingleton: AppShortcutStore | null = null;
let ipcRegistered = false;
let globalFailures: AppShortcutId[] = [];

/** 注册方上报当前注册失败的 global 条目; 变化时连同 overrides 一起广播。 */
export function setGlobalShortcutRegistrationFailures(ids: readonly AppShortcutId[]): void {
  const next = [...new Set(ids)].sort();
  if (next.length === globalFailures.length && next.every((id, i) => id === globalFailures[i])) {
    return;
  }
  globalFailures = next;
  broadcastAppShortcutsChanged(getAppShortcutStore().getOverrides());
}

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
      globalFailures: [...globalFailures],
    };
  });

  ipcMain.handle('app-shortcuts:set-override', (_event, id: unknown, combo: unknown) => {
    const rejection = runStoreMutation(() => store.setOverride(id, combo));
    if (rejection) {
      throwIpcError('INVALID_PARAMS', rejectionMessage(rejection, id));
    }
    return { overrides: store.getOverrides() };
  });

  ipcMain.handle('app-shortcuts:clear-override', (_event, id: unknown) => {
    runStoreMutation(() => store.clearOverride(id));
    return { overrides: store.getOverrides() };
  });

  ipcMain.handle('app-shortcuts:reset-all', () => {
    runStoreMutation(() => store.resetAll());
    return { overrides: store.getOverrides() };
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
    case 'global-unusable':
      return 'shortcut combo cannot be used as a system-wide shortcut';
    case 'conflict':
      return 'shortcut combo conflicts with another shortcut in an overlapping scope';
  }
}

function broadcastAppShortcutsChanged(overrides: AppShortcutOverrides): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('app-shortcuts:changed', {
      overrides,
      globalFailures: [...globalFailures],
    });
  });
}
