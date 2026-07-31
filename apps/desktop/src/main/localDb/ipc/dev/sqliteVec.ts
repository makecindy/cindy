/**
 * dev-only IPC: `dev:sqlite-vec:status`
 *
 * 仅在非 packaged 模式（`app.isPackaged === false`）下注册，供开发调试用。
 * 不在 preload 暴露，renderer 无法通过 contextBridge 访问。
 */

import { ipcMain, app } from 'electron';
import { getSqliteVecState } from '../../sqliteVecLoader';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

export function registerDevSqliteVecIpc(): void {
  if (app.isPackaged) return;

  ipcMain.handle(IPC_CHANNELS.DEV.SQLITE_VEC_STATUS, () => {
    const state = getSqliteVecState();
    return {
      available: state?.loaded ?? false,
      version: state?.version,
      expectedPath: state?.expectedPath,
      lastError: state?.error,
    };
  });
}
