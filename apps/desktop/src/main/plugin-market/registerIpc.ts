import { ipcMain } from 'electron';

import { isIpcError } from '../../shared/ipc-errors.js';
import { setGhostUninstallLedgerPreparer } from '../cindy-brain/index.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { PluginMarketService } from './service.js';

const log = createLogger('plugin-market-ipc');
let registered = false;
let serviceSingleton: PluginMarketService | null = null;

function service(): PluginMarketService {
  serviceSingleton ??= new PluginMarketService();
  return serviceSingleton;
}

/**
 * Preserve stable IPC errors and hide internal/network messages from the
 * renderer. Detailed failures stay in main logs; the renderer localizes by
 * code and uses a generic fallback for INTERNAL.
 */
async function invokePluginMarket<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIpcError(error)) throw error;
    log.warn('plugin market IPC failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throwIpcError('INTERNAL', 'Plugin market operation failed');
  }
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
    return invokePluginMarket(() => service().snapshot());
  });
  ipcMain.handle('plugin-market:detail', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().detail(requireString(pluginId, 'pluginId')),
    );
  });
  ipcMain.handle(
    'plugin-market:install',
    (event, pluginId: unknown, options: unknown) => {
      assertTrustedAppRendererEvent(event);
      const allowPermissionExpansion =
        typeof options === 'object' &&
        options !== null &&
        (options as { allowPermissionExpansion?: unknown }).allowPermissionExpansion === true;
      return invokePluginMarket(() =>
        service().install(requireString(pluginId, 'pluginId'), {
          allowPermissionExpansion,
          nodeAuthorizationWebContents: event.sender,
        }),
      );
    },
  );
  ipcMain.handle('plugin-market:uninstall', (event, pluginId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invokePluginMarket(() =>
      service().uninstall(requireString(pluginId, 'pluginId')),
    );
  });
}
