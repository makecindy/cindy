import { ipcMain } from 'electron';
import { requireObject, requireString } from '../utils/ipcValidate.js';
import { listDir, statPath, mkdirP } from '@cindy/remote-agent/fsBrowse/index';
import './windowsDrives.js';
export * from '@cindy/remote-agent/fsBrowse/index';

/** 注册三个本机 FS 浏览 handler。channel 已在 device-link allowlist 内(经隧道在被控端执行)。 */
export function registerFsBrowseIpc(): void {
  ipcMain.handle('fs:list-dir', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return listDir(requireString(obj.path, 'path'));
  });
  ipcMain.handle('fs:stat-path', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return statPath(requireString(obj.path, 'path'));
  });
  ipcMain.handle('fs:mkdir-p', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return mkdirP(requireString(obj.path, 'path'));
  });
}
