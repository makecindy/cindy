/** Electron adapter for the shared, platform-independent filesystem browsing helpers. */

import { ipcMain } from 'electron';

import { requireObject, requireString } from '../utils/ipcValidate.js';
import { listDir, mkdirP, statPath } from './core.js';

export * from './core.js';

/** Register the local and Device Link project-directory browsing handlers. */
export function registerFsBrowseIpc(): void {
  ipcMain.handle('fs:list-dir', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return listDir(requireString(obj.path, 'path'), { canonicalDirectory: obj.canonicalDirectory === true });
  });
  ipcMain.handle('fs:stat-path', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return statPath(requireString(obj.path, 'path'), obj.canonicalDirectory === true);
  });
  ipcMain.handle('fs:mkdir-p', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return mkdirP(requireString(obj.path, 'path'));
  });
}
