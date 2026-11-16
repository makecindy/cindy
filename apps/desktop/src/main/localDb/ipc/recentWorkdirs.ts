import { BrowserWindow, ipcMain } from 'electron';
import { requireString } from '../../utils/ipcValidate.js';
import { createLogger } from '../../logger.js';
import { listRecentWorkdirs, removeRecentWorkdir } from './recentWorkdirsCore.js';
import { emitProjectCatalogChanged } from '../../projectCatalogEvents.js';
export * from './recentWorkdirsCore.js';
const log = createLogger('recentWorkdirs');

export function registerRecentWorkdirsIpc(): void {
  ipcMain.handle('local-db:recent-workdirs:list', async () => listRecentWorkdirs());
  ipcMain.handle('local-db:recent-workdirs:remove', async (_evt, input: unknown) => {
    const body = (input ?? {}) as { path?: unknown };
    const raw = requireString(body.path, 'path');
    // 归一化后再删,保证与写入侧同一主键形态;归一失败(纯空白等)当 no-op,
    // 删除本身幂等,不值得为它抛错。
    const { deleted, normalizedPath: normalized } = await removeRecentWorkdir(raw);
    log.info('[localDb] recent workdir removed by user', { path: normalized, deleted });
    // 广播到本机所有窗口:发起删除的 renderer 已乐观 patch 自己的 store,
    // 其它窗口(以及 device-link 远程调用落地时的被控端窗口)靠这个刷新,
    // 否则模块级缓存只在 sessions:created 时重拉,删掉的项目会在别的窗口
    // 里残留可选。真删了才广播;no-op 不打扰。
    if (deleted) {
      emitProjectCatalogChanged();
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('local-db:recent-workdirs:changed', { path: normalized });
        }
      }
    }
    return { deleted };
  });
}
