import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { Layout } from '../../shared/layoutTree.js';
import { LAYOUT_FILE_NAME, LayoutStore } from './LayoutStore.js';

/**
 * 主界面布局树的进程级单例 + IPC 注册。
 *
 * channel 约定(前缀 layout:):
 * - get (sendSync):renderer 首帧同步拉当前布局 —— 布局必须第一帧就位,
 *   禁止「先渲染默认再跳成用户布局」(设计规范规则 7),故走 sendSync,
 *   与 app-shortcuts:get 同模式。文件极小(<2KB),同步读不卡启动。
 * - set (invoke):写路径,非法树 throwIpcError('INVALID_PARAMS')。
 * - reset (invoke):重置为默认布局。
 * - changed (main → renderer 广播):全量布局快照,多窗口热更新。
 */

const log = createLogger('layout');

let storeSingleton: LayoutStore | null = null;
let ipcRegistered = false;

export function getLayoutStore(): LayoutStore {
  if (!storeSingleton) {
    storeSingleton = new LayoutStore({
      getFilePath: () => path.join(app.getPath('userData'), LAYOUT_FILE_NAME),
      onChanged: broadcastLayoutChanged,
      log,
    });
  }
  return storeSingleton;
}

export function registerLayoutIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const store = getLayoutStore();
  // 启动即落盘 + 自愈损坏存档(QA:启动后 userData 出现合法 layout.v1.json)。
  store.ensurePersisted();

  ipcMain.on('layout:get', (event) => {
    event.returnValue = { layout: store.getLayout() };
  });

  ipcMain.handle('layout:set', (_event, layout: unknown) => {
    const result = store.setLayout(layout);
    if ('rejection' in result) {
      throwIpcError('INVALID_PARAMS', `invalid layout: ${result.rejection}`);
    }
    return result;
  });

  ipcMain.handle('layout:reset', () => store.reset());
}

function broadcastLayoutChanged(layout: Layout): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('layout:changed', { layout });
  });
}
