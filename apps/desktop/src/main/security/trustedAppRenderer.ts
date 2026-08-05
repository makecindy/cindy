/**
 * trustedAppRenderer — Cindy 自有顶层 Renderer 的 IPC 来源闸。
 *
 * Renderer / WebView / Ghost 都是不可信输入。需要文件、安装或进程权限的 IPC
 * 只能由 Cindy 自己创建并登记过的应用窗口顶层页面调用；子 frame、WebView、
 * Ghost 页面和导航到其它地址的窗口一律失败关闭。
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { throwIpcError } from '../utils/ipcValidate.js';
import { isAppContentWindow } from '../windowFocusClassifier.js';

interface TrustedRendererUrlOptions {
  devServerUrl: string | null;
  packagedRendererFile: string;
}

type MainIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

/** 纯 URL 判定，导出用于锁住 dev / packaged 两条允许路径。 */
export function isTrustedAppRendererUrl(
  rawUrl: string,
  options: TrustedRendererUrlOptions,
): boolean {
  try {
    const actual = new URL(rawUrl);
    if (options.devServerUrl) {
      const expected = new URL(options.devServerUrl);
      if (!['http:', 'https:'].includes(expected.protocol)) return false;
      return actual.origin === expected.origin;
    }
    if (actual.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(actual)) === path.resolve(options.packagedRendererFile);
  } catch {
    return false;
  }
}

function currentRendererUrlOptions(): TrustedRendererUrlOptions {
  return {
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || null,
    packagedRendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  };
}

/**
 * 判断 IPC 是否来自 Cindy 登记过的应用窗口顶层页面。
 * 身份只取 Electron 持有的 sender / senderFrame，不接受 Renderer 自报字段。
 */
export function isTrustedAppRendererEvent(event: MainIpcEvent): boolean {
  return isTrustedAppRendererEventForLocation(event, currentRendererUrlOptions());
}

/** 与生产判定相同，但允许测试显式传入 renderer 地址。 */
export function isTrustedAppRendererEventForLocation(
  event: MainIpcEvent,
  options: TrustedRendererUrlOptions,
): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || frame.parent !== null) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!isAppContentWindow(win)) return false;
  return isTrustedAppRendererUrl(frame.url, options);
}

/** 高权限 IPC 的统一断言；失败时不泄露真实允许地址。 */
export function assertTrustedAppRendererEvent(event: MainIpcEvent): void {
  if (!isTrustedAppRendererEvent(event)) {
    throwIpcError('PERMISSION_DENIED', '此操作只能从 Cindy 主页面发起');
  }
}
