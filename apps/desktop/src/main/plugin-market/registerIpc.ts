import { ipcMain } from 'electron';

import { setGhostUninstallLedgerPreparer } from '../cindy-brain/index.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
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
  setGhostUninstallLedgerPreparer((ghostId) =>
    service().prepareLocalUninstallTracking(ghostId),
  );
  ipcMain.handle('plugin-market:snapshot', (event) => {
    assertTrustedAppRendererEvent(event);
    return service().snapshot();
  });
  ipcMain.handle('plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return service().detail(requireString(pluginId, 'pluginId'));
  });
  ipcMain.handle(
    'plugin-market:install',
    (event, pluginId: unknown, options: unknown) => {
      assertTrustedAppRendererEvent(event);
      const allowPermissionExpansion =
        typeof options === 'object' &&
        options !== null &&
        (options as { allowPermissionExpansion?: unknown }).allowPermissionExpansion === true;
      return service().install(requireString(pluginId, 'pluginId'), {
        allowPermissionExpansion,
      });
    },
  );
  ipcMain.handle('plugin-market:uninstall', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return service().uninstall(requireString(pluginId, 'pluginId'));
  });
}
