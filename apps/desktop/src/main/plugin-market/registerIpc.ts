import { ipcMain } from 'electron';

import { requireString } from '../utils/ipcValidate.js';
import { PluginMarketService } from './service.js';

let registered = false;
let serviceSingleton: PluginMarketService | null = null;

function service(): PluginMarketService {
  serviceSingleton ??= new PluginMarketService();
  return serviceSingleton;
}

/** 注册 renderer 可用的只读市场与显式安装/卸载写路径。 */
export function registerPluginMarketIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('plugin-market:snapshot', () => service().snapshot());
  ipcMain.handle('plugin-market:detail', (_event, pluginId: unknown) =>
    service().detail(requireString(pluginId, 'pluginId')),
  );
  ipcMain.handle(
    'plugin-market:install',
    (_event, pluginId: unknown, options: unknown) => {
      const allowPermissionExpansion =
        typeof options === 'object' &&
        options !== null &&
        (options as { allowPermissionExpansion?: unknown }).allowPermissionExpansion === true;
      return service().install(requireString(pluginId, 'pluginId'), {
        allowPermissionExpansion,
      });
    },
  );
  ipcMain.handle('plugin-market:uninstall', (_event, pluginId: unknown) =>
    service().uninstall(requireString(pluginId, 'pluginId')),
  );
}
