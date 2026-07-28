import { BrowserWindow, ipcMain } from 'electron';

import type { LocalThemeWriteRequest } from '../../shared/local-themes';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { importExternalTheme } from './importer';
import { loadLocalThemes, loadLocalThemesSync } from './loader';
import { openLocalThemesDir, writeLocalTheme } from './writer';

export function registerLocalThemesIpc(): void {
  ipcMain.on('local-themes:list-sync', (event) => {
    event.returnValue = loadLocalThemesSync();
  });

  ipcMain.handle('local-themes:list', async () => loadLocalThemes());
  ipcMain.handle('local-themes:write', async (_event, req: LocalThemeWriteRequest) =>
    writeLocalTheme(req));
  ipcMain.handle('local-themes:open-dir', async () => openLocalThemesDir());
  // 导入会弹原生文件对话框并读取用户选中的任意路径,是新增的文件访问能力,
  // 因此显式过来源闸(只允许 Cindy 自有顶层页面发起);对话框与读文件都在 main
  // 侧完成,Renderer 拿不到也传不进路径。
  ipcMain.handle('local-themes:import', async (event) => {
    assertTrustedAppRendererEvent(event);
    return importExternalTheme({
      parentWindow: BrowserWindow.fromWebContents(event.sender),
    });
  });
}
