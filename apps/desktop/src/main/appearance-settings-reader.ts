/**
 * 外观设置首帧快照的只读窗口登记表。
 *
 * Utility 窗口会加载 Cindy renderer 与共享 preload，但不应因此获得 app-content
 * 的高权限 IPC。这里单独登记允许读取外观启动快照的窗口，避免扩大权限边界。
 */

import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import {
  isTrustedCindyRendererWindow,
  isTrustedTopLevelCindyRendererEvent,
} from './security/trustedAppRenderer.js';
import { isAppContentWindow } from './windowFocusClassifier.js';

type AppearanceSettingsReadEvent = IpcMainEvent | IpcMainInvokeEvent;

const appearanceSettingsReaderWindows = new WeakSet<BrowserWindow>();

export function markAppearanceSettingsReaderWindow(win: BrowserWindow): void {
  appearanceSettingsReaderWindows.add(win);
}

export function isTrustedAppearanceSettingsReadEvent(event: AppearanceSettingsReadEvent): boolean {
  if (!isTrustedTopLevelCindyRendererEvent(event)) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  return isAppearanceSettingsReaderWindow(win);
}

export function isTrustedAppearanceSettingsReadWindow(
  win: BrowserWindow | null | undefined,
): win is BrowserWindow {
  return isAppearanceSettingsReaderWindow(win) && isTrustedCindyRendererWindow(win);
}

function isAppearanceSettingsReaderWindow(
  win: BrowserWindow | null | undefined,
): win is BrowserWindow {
  return Boolean(
    win &&
    !win.isDestroyed() &&
    (isAppContentWindow(win) || appearanceSettingsReaderWindows.has(win)),
  );
}
